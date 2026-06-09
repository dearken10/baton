/**
 * RemoteFs — BatonFs over a long-lived SSH ControlMaster.
 *
 * Every method composes a small POSIX shell snippet, runs it on the
 * remote via SshConnection.exec, and parses the result. The snippets
 * assume GNU coreutils (the common case for Linux dev boxes); a future
 * remote-daemon could replace this whole file behind the same Fs surface.
 *
 * Path safety: we quote every absPath with single quotes and escape
 * embedded single quotes via the `'\''` POSIX idiom. The renderer is
 * never sending arbitrary user input as a path — paths come from
 * fs.readdir or the user's own input which we already trim — but
 * defense-in-depth is cheap.
 */

import { spawn } from 'node:child_process';
import { Readable } from 'node:stream';
import * as pty from 'node-pty';
import type { ConnectionProfile } from '../../../shared/ipc.js';
import { wrapPty } from './localFs.js';
import { SshConnection } from './sshConnection.js';
import type {
  BatonFs,
  ExecBufferResult,
  ExecOpts,
  ExecResult,
  FsDirent,
  FsStat,
  PtyHandle,
  PtySpawnOpts,
  ReadBinaryOpts,
  ReadBinaryResult,
  ReadFileOpts,
  ReadFileResult,
  WriteFileOpts,
  WriteFileResult,
} from './types.js';

/** Single-quote a string so it's safe to embed inside a `sh -c`
 *  argument. Replaces `'` with `'\''` per POSIX. */
function sq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** Quote a list of strings for `sh -c`. */
function sqList(xs: readonly string[]): string {
  return xs.map(sq).join(' ');
}

/** Build a shell prefix of inline env assignments that mirrors what
 *  `node:child_process` does when you pass `{ env }` — only the keys
 *  you list get exported; everything else is inherited from the remote
 *  shell.
 *
 *  We deliberately do NOT use the `env` binary here. `env VAR=val cmd`
 *  works fine when `cmd` is a real binary, but our caller composes
 *  `env VAR=val exec bash …` where `exec` is a shell builtin — `env`
 *  then fails with "env: 'exec': No such file or directory" and the
 *  pty exits 127. Inline assignments (`VAR=val exec bash …`) are shell
 *  syntax that does the right thing for both builtins and binaries. */
function envPrefix(env?: Record<string, string>): string {
  if (!env) return '';
  const parts: string[] = [];
  for (const [k, v] of Object.entries(env)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) continue;
    parts.push(`${k}=${sq(v)}`);
  }
  return parts.length ? `${parts.join(' ')} ` : '';
}

export class RemoteFs implements BatonFs {
  readonly isLocal = false;
  constructor(private conn: SshConnection) {}

  get id(): string { return this.conn.profile.id; }
  get profile(): ConnectionProfile { return this.conn.profile; }
  get connection(): SshConnection { return this.conn; }

  async stat(absPath: string): Promise<FsStat | null> {
    await this.conn.ensureMaster();
    // GNU stat: `%F` = file type ("regular file", "directory", "symbolic link"),
    // `%s` = size, `%Y` = mtime in seconds.
    // The double-`stat` indirection is so we can distinguish ENOENT
    // from other failures by exit code.
    const cmd = `stat -c '%F|%s|%Y' -- ${sq(absPath)} 2>&1`;
    const res = await this.conn.exec({ command: cmd, timeoutMs: 5000 });
    if (res.timedOut) throw new Error(`stat timed out: ${absPath}`);
    const stdout = res.stdout.toString('utf-8').trim();
    if (res.code !== 0) {
      if (/No such file/i.test(stdout)) return null;
      throw new Error(`stat ${absPath}: ${stdout || `exit ${res.code}`}`);
    }
    const [kindRaw, sizeRaw, mtimeRaw] = stdout.split('|');
    const kind =
      kindRaw === 'directory' ? 'dir'
      : kindRaw === 'symbolic link' ? 'symlink'
      : kindRaw === 'regular file' || kindRaw === 'regular empty file' ? 'file'
      : 'other';
    return {
      kind,
      size: Number(sizeRaw ?? '0'),
      mtimeMs: Number(mtimeRaw ?? '0') * 1000,
    };
  }

  async exists(absPath: string): Promise<boolean> {
    await this.conn.ensureMaster();
    const res = await this.conn.exec({
      command: `[ -e ${sq(absPath)} ]`,
      timeoutMs: 5000,
    });
    return res.code === 0;
  }

  async readdir(absPath: string): Promise<FsDirent[]> {
    await this.conn.ensureMaster();
    // `find -L … -maxdepth 1 -mindepth 1` with `-printf` for one line
    // per entry: `<type>\t<name>\n`. -L follows symlinks for the type
    // check so a symlink-to-dir reports as 'd', matching what the local
    // tree walker does. `-printf` is GNU; this is the "we assume Linux
    // remote" assumption the file docstring calls out.
    const cmd =
      `find -L ${sq(absPath)} -mindepth 1 -maxdepth 1 ` +
      `-printf '%y\\t%f\\n' 2>/dev/null`;
    const res = await this.conn.exec({ command: cmd, timeoutMs: 10_000 });
    if (res.code !== 0 && res.stdout.length === 0) return [];
    const out: FsDirent[] = [];
    for (const line of res.stdout.toString('utf-8').split('\n')) {
      if (!line) continue;
      const tabIdx = line.indexOf('\t');
      if (tabIdx < 0) continue;
      const ty = line[0];
      const name = line.slice(tabIdx + 1);
      const kind: FsDirent['kind'] =
        ty === 'd' ? 'dir'
        : ty === 'l' ? 'symlink'
        : ty === 'f' ? 'file'
        : 'other';
      out.push({ name, kind });
    }
    return out;
  }

  async mkdir(absPath: string, opts?: { recursive?: boolean }): Promise<void> {
    await this.conn.ensureMaster();
    const flag = opts?.recursive ? '-p' : '';
    const cmd = `mkdir ${flag} -- ${sq(absPath)}`;
    const res = await this.conn.exec({ command: cmd, timeoutMs: 5000 });
    if (res.code !== 0) {
      throw new Error(
        `mkdir ${absPath}: ${res.stderr.toString('utf-8').trim() || `exit ${res.code}`}`
      );
    }
  }

  async rm(absPath: string, opts?: { recursive?: boolean; force?: boolean; trash?: boolean }): Promise<void> {
    if (opts?.trash) {
      // No portable "move to trash" on Linux; we use `rm -rf` which is
      // what the UI ends up doing anyway. The caller is expected to
      // gate on a confirmation prompt for remote sessions (same
      // contract as file.delete in bus.ts).
    }
    await this.conn.ensureMaster();
    const flags = [
      opts?.recursive ? '-r' : '',
      opts?.force ? '-f' : '',
    ].filter(Boolean).join(' ');
    const cmd = `rm ${flags} -- ${sq(absPath)}`;
    const res = await this.conn.exec({ command: cmd, timeoutMs: 15_000 });
    if (res.code !== 0) {
      throw new Error(
        `rm ${absPath}: ${res.stderr.toString('utf-8').trim() || `exit ${res.code}`}`
      );
    }
  }

  async rename(fromAbs: string, toAbs: string): Promise<void> {
    await this.conn.ensureMaster();
    const cmd = `mv -n -- ${sq(fromAbs)} ${sq(toAbs)}`;
    const res = await this.conn.exec({ command: cmd, timeoutMs: 8000 });
    if (res.code !== 0) {
      throw new Error(
        `mv ${fromAbs} → ${toAbs}: ${res.stderr.toString('utf-8').trim() || `exit ${res.code}`}`
      );
    }
  }

  async cp(fromAbs: string, toAbs: string, opts?: { recursive?: boolean; errorOnExist?: boolean }): Promise<void> {
    await this.conn.ensureMaster();
    const flags = [
      opts?.recursive ? '-R' : '',
      opts?.errorOnExist === false ? '' : '-n', // no clobber by default
    ].filter(Boolean).join(' ');
    const cmd = `cp ${flags} -- ${sq(fromAbs)} ${sq(toAbs)}`;
    const res = await this.conn.exec({ command: cmd, timeoutMs: 30_000 });
    if (res.code !== 0) {
      throw new Error(
        `cp ${fromAbs} → ${toAbs}: ${res.stderr.toString('utf-8').trim() || `exit ${res.code}`}`
      );
    }
  }

  async readFile(absPath: string, opts?: ReadFileOpts): Promise<ReadFileResult> {
    const max = opts?.maxBytes ?? 5 * 1024 * 1024;
    const stat = await this.stat(absPath);
    if (!stat || stat.kind === 'dir') {
      throw new Error(`readFile: not a file: ${absPath}`);
    }
    if (stat.size > max) {
      return {
        content: '',
        mtimeMs: stat.mtimeMs,
        binary: false,
        tooLarge: true,
        size: stat.size,
      };
    }
    await this.conn.ensureMaster();
    const res = await this.conn.exec({
      command: `cat -- ${sq(absPath)}`,
      timeoutMs: 20_000,
      maxStdoutBytes: max + 65_536,
    });
    if (res.code !== 0) {
      throw new Error(
        `cat ${absPath}: ${res.stderr.toString('utf-8').trim() || `exit ${res.code}`}`
      );
    }
    const buf = res.stdout;
    const sliceEnd = Math.min(buf.length, 4096);
    let binary = false;
    for (let i = 0; i < sliceEnd; i++) {
      if (buf[i] === 0) { binary = true; break; }
    }
    if (binary) {
      return {
        content: '',
        mtimeMs: stat.mtimeMs,
        binary: true,
        tooLarge: false,
        size: stat.size,
      };
    }
    return {
      content: buf.toString('utf-8'),
      mtimeMs: stat.mtimeMs,
      binary: false,
      tooLarge: false,
      size: stat.size,
    };
  }

  async readFileBinary(absPath: string, opts?: ReadBinaryOpts): Promise<ReadBinaryResult> {
    const max = opts?.maxBytes ?? 8 * 1024 * 1024;
    const stat = await this.stat(absPath);
    if (!stat || stat.kind === 'dir') {
      throw new Error(`readFileBinary: not a file: ${absPath}`);
    }
    if (stat.size > max) {
      return {
        data: '',
        size: stat.size,
        mtimeMs: stat.mtimeMs,
        tooLarge: true,
      };
    }
    await this.conn.ensureMaster();
    // base64 on stdout — handles binary cleanly over the text-oriented
    // ssh stream.
    const cmd = `base64 -w0 -- ${sq(absPath)} || base64 -- ${sq(absPath)}`;
    const res = await this.conn.exec({
      command: cmd,
      timeoutMs: 30_000,
      maxStdoutBytes: Math.ceil(max * 1.4) + 65_536, // ~33% expansion + safety
    });
    if (res.code !== 0) {
      throw new Error(
        `base64 ${absPath}: ${res.stderr.toString('utf-8').trim() || `exit ${res.code}`}`
      );
    }
    // Strip whitespace (BSD base64 inserts newlines).
    const data = res.stdout.toString('utf-8').replace(/\s+/g, '');
    return { data, size: stat.size, mtimeMs: stat.mtimeMs, tooLarge: false };
  }

  async writeFile(absPath: string, content: string, opts?: WriteFileOpts): Promise<WriteFileResult> {
    if (opts?.knownMtimeMs != null && !opts.force) {
      const stat = await this.stat(absPath);
      if (stat && stat.mtimeMs > opts.knownMtimeMs + 1) {
        return { ok: false, mtimeMs: stat.mtimeMs, stale: true };
      }
    }
    await this.conn.ensureMaster();
    // `dd of=...` writes everything from stdin to the file atomically
    // enough for our purposes (no truncate semantics on partial write —
    // tee would be similar). We pipe the file contents in via SSH's
    // stdin, which the master forwards to the remote shell.
    const cmd = `cat > ${sq(absPath)}`;
    const res = await this.conn.exec({
      command: cmd,
      stdin: content,
      timeoutMs: 30_000,
    });
    if (res.code !== 0) {
      throw new Error(
        `write ${absPath}: ${res.stderr.toString('utf-8').trim() || `exit ${res.code}`}`
      );
    }
    const stat = await this.stat(absPath);
    return {
      ok: true,
      mtimeMs: stat?.mtimeMs ?? Date.now(),
      stale: false,
    };
  }

  async exec(command: string, args: readonly string[], opts: ExecOpts): Promise<ExecResult> {
    const buf = await this.execBuffer(command, args, opts);
    return {
      stdout: buf.stdout.toString('utf-8'),
      stderr: buf.stderr.toString('utf-8'),
      code: buf.code,
      timedOut: buf.timedOut,
    };
  }

  async execBuffer(command: string, args: readonly string[], opts: ExecOpts): Promise<ExecBufferResult> {
    await this.conn.ensureMaster();
    // Compose: `cd "$cwd" && env … exec <command> <args…>`. We use
    // `exec` so signals propagate cleanly (no shell wrapper between
    // ssh and the child).
    const composed =
      `cd ${sq(opts.cwd)} && ${envPrefix(opts.env)}exec ${sq(command)} ${sqList(args)}`;
    const result = await this.conn.exec({
      command: composed,
      ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
      ...(opts.maxStdoutBytes !== undefined ? { maxStdoutBytes: opts.maxStdoutBytes } : {}),
      ...(opts.stdin !== undefined ? { stdin: opts.stdin } : {}),
    });
    return result;
  }

  async spawnPty(opts: PtySpawnOpts): Promise<PtyHandle> {
    // We need a long-running pty pointing at the remote — node-pty
    // spawns a LOCAL pty and connects ssh as its child, which gives us
    // the right semantics (Claude sees a real tty, ssh forwards
    // SIGWINCH on resize, exit code propagates back).
    await this.conn.ensureMaster();

    const composed =
      `cd ${sq(opts.cwd)} && ${envPrefix(opts.env)}exec ${sq(opts.command)} ${sqList(opts.args)}`;

    // For pty we use a fresh ssh invocation that reuses the master
    // socket via -S. -tt forces pty allocation even when stdin isn't a
    // tty (which it isn't — we're inside node-pty's pty).
    const sshArgs: string[] = [
      '-tt',
      ...this.conn.sshBaseArgs(),
    ];
    if (opts.reverseForward) {
      for (const f of opts.reverseForward) {
        sshArgs.push('-R', `${f.localPort}:localhost:${f.remotePort}`);
      }
    }
    sshArgs.push(
      `${this.conn.profile.user}@${this.conn.profile.host}`,
      '--',
      composed,
    );

    // We need an env that gives ssh access to its key etc. Inherit
    // everything from the main process so SSH_AUTH_SOCK / TERM are
    // sane. The PTY's TERM is set by node-pty's `name` arg.
    const env: Record<string, string> = {
      ...process.env as Record<string, string>,
      TERM: 'xterm-256color',
    };

    const ptyProcess = pty.spawn('ssh', sshArgs, {
      name: 'xterm-256color',
      cols: opts.cols,
      rows: opts.rows,
      // cwd on the Mac (where we're spawning ssh from) doesn't matter
      // much; use HOME so we don't accidentally land in a stale path.
      cwd: process.env['HOME'] ?? '/',
      env,
    });
    return wrapPty(ptyProcess);
  }
}

// Suppress unused-import linter (Readable / spawn are kept for future
// streaming write paths).
void Readable; void spawn;
