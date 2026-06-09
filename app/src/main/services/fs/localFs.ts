/**
 * LocalFs — BatonFs implementation backed by node:fs / child_process /
 * node-pty. Mirrors what bus.ts used to do inline so the refactor is a
 * pure no-op for local projects.
 */

import * as fsp from 'node:fs/promises';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Readable } from 'node:stream';
import { execFile, spawn } from 'node:child_process';
import { shell } from 'electron';
import * as pty from 'node-pty';

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

function direntKind(entry: fs.Dirent): FsDirent['kind'] {
  if (entry.isDirectory()) return 'dir';
  if (entry.isSymbolicLink()) return 'symlink';
  if (entry.isFile()) return 'file';
  return 'other';
}

function statKind(stat: fs.Stats): FsStat['kind'] {
  if (stat.isDirectory()) return 'dir';
  if (stat.isSymbolicLink()) return 'symlink';
  if (stat.isFile()) return 'file';
  return 'other';
}

export class LocalFs implements BatonFs {
  readonly id = 'local';
  readonly isLocal = true;

  async stat(absPath: string): Promise<FsStat | null> {
    try {
      const s = await fsp.stat(absPath);
      return { kind: statKind(s), size: s.size, mtimeMs: s.mtimeMs };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
  }

  async exists(absPath: string): Promise<boolean> {
    try { await fsp.access(absPath); return true; } catch { return false; }
  }

  async readdir(absPath: string): Promise<FsDirent[]> {
    try {
      const entries = await fsp.readdir(absPath, { withFileTypes: true });
      return entries.map((e) => ({ name: e.name, kind: direntKind(e) }));
    } catch {
      return [];
    }
  }

  async mkdir(absPath: string, opts?: { recursive?: boolean }): Promise<void> {
    await fsp.mkdir(absPath, { recursive: opts?.recursive ?? false });
  }

  async rm(absPath: string, opts?: { recursive?: boolean; force?: boolean; trash?: boolean }): Promise<void> {
    if (opts?.trash) {
      await shell.trashItem(absPath);
      return;
    }
    await fsp.rm(absPath, {
      recursive: opts?.recursive ?? false,
      force: opts?.force ?? false,
    });
  }

  async rename(fromAbs: string, toAbs: string): Promise<void> {
    await fsp.rename(fromAbs, toAbs);
  }

  async cp(fromAbs: string, toAbs: string, opts?: { recursive?: boolean; errorOnExist?: boolean }): Promise<void> {
    await fsp.cp(fromAbs, toAbs, {
      recursive: opts?.recursive ?? true,
      errorOnExist: opts?.errorOnExist ?? true,
      force: false,
    });
  }

  async readFile(absPath: string, opts?: ReadFileOpts): Promise<ReadFileResult> {
    const max = opts?.maxBytes ?? 5 * 1024 * 1024;
    const stat = await fsp.stat(absPath);
    if (stat.size > max) {
      return {
        content: '',
        mtimeMs: stat.mtimeMs,
        binary: false,
        tooLarge: true,
        size: stat.size,
      };
    }
    const buf = await fsp.readFile(absPath);
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
    const stat = await fsp.stat(absPath);
    if (stat.size > max) {
      return {
        data: '',
        size: stat.size,
        mtimeMs: stat.mtimeMs,
        tooLarge: true,
      };
    }
    const buf = await fsp.readFile(absPath);
    return {
      data: buf.toString('base64'),
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      tooLarge: false,
    };
  }

  async writeFile(absPath: string, content: string, opts?: WriteFileOpts): Promise<WriteFileResult> {
    if (opts?.knownMtimeMs != null && !opts.force) {
      try {
        const stat = await fsp.stat(absPath);
        if (stat.mtimeMs > opts.knownMtimeMs + 1) {
          return { ok: false, mtimeMs: stat.mtimeMs, stale: true };
        }
      } catch {
        // file doesn't exist anymore — proceed (we'll create it)
      }
    }
    await fsp.writeFile(absPath, content, 'utf-8');
    const stat = await fsp.stat(absPath);
    return { ok: true, mtimeMs: stat.mtimeMs, stale: false };
  }

  exec(command: string, args: readonly string[], opts: ExecOpts): Promise<ExecResult> {
    return new Promise((resolve) => {
      const env = { ...process.env, ...(opts.env ?? {}) } as NodeJS.ProcessEnv;
      const child = execFile(
        command,
        [...args],
        {
          cwd: opts.cwd,
          env,
          timeout: opts.timeoutMs,
          maxBuffer: opts.maxStdoutBytes ?? 8 * 1024 * 1024,
          killSignal: 'SIGKILL',
          encoding: 'utf-8',
        },
        (err, stdout, stderr) => {
          const timedOut = !!(err && (err as NodeJS.ErrnoException).code === 'ETIMEDOUT');
          const code = timedOut
            ? null
            : err && typeof (err as { code?: unknown }).code === 'number'
              ? (err as { code: number }).code
              : child.exitCode ?? 0;
          resolve({
            stdout: String(stdout),
            stderr: String(stderr),
            code,
            timedOut,
          });
        }
      );
      if (opts.stdin != null) writeStdin(child, opts.stdin);
    });
  }

  execBuffer(command: string, args: readonly string[], opts: ExecOpts): Promise<ExecBufferResult> {
    return new Promise((resolve) => {
      const env = { ...process.env, ...(opts.env ?? {}) } as NodeJS.ProcessEnv;
      const child = spawn(command, [...args], { cwd: opts.cwd, env });
      const out: Buffer[] = [];
      const errBufs: Buffer[] = [];
      let stdoutLen = 0;
      const stdoutCap = opts.maxStdoutBytes ?? 8 * 1024 * 1024;
      let timedOut = false;
      const timer = opts.timeoutMs
        ? setTimeout(() => {
            timedOut = true;
            try { child.kill('SIGKILL'); } catch { /* ignore */ }
          }, opts.timeoutMs)
        : null;

      child.stdout.on('data', (c: Buffer) => {
        stdoutLen += c.length;
        if (stdoutLen <= stdoutCap) out.push(c);
      });
      child.stderr.on('data', (c: Buffer) => errBufs.push(c));
      child.on('error', () => {
        if (timer) clearTimeout(timer);
        resolve({
          stdout: Buffer.concat(out),
          stderr: Buffer.concat(errBufs),
          code: null,
          timedOut,
        });
      });
      child.on('close', (code) => {
        if (timer) clearTimeout(timer);
        resolve({
          stdout: Buffer.concat(out),
          stderr: Buffer.concat(errBufs),
          code,
          timedOut,
        });
      });
      if (opts.stdin != null) writeStdin(child, opts.stdin);
    });
  }

  async spawnPty(opts: PtySpawnOpts): Promise<PtyHandle> {
    const ptyProcess = pty.spawn(opts.command, opts.args, {
      name: 'xterm-256color',
      cols: opts.cols,
      rows: opts.rows,
      cwd: opts.cwd,
      env: opts.env,
    });
    return wrapPty(ptyProcess);
  }
}

/** Pipe stdin to a child process spawned with stdin: 'pipe'. */
function writeStdin(child: { stdin: NodeJS.WritableStream | null }, data: string | Buffer | Readable): void {
  if (!child.stdin) return;
  if (data instanceof Readable) {
    data.pipe(child.stdin);
    return;
  }
  try {
    child.stdin.write(data);
    child.stdin.end();
  } catch { /* ignore — process probably exited fast */ }
}

export function wrapPty(ptyProcess: pty.IPty, onCleanup?: () => void): PtyHandle {
  let alive = true;
  return {
    pid: ptyProcess.pid,
    write(data) {
      if (!alive) return;
      ptyProcess.write(data);
    },
    resize(cols, rows) {
      if (!alive) return;
      ptyProcess.resize(cols, rows);
    },
    kill(signal) {
      if (!alive) return;
      alive = false;
      try {
        ptyProcess.kill(signal ?? 'SIGTERM');
      } catch { /* pty might already be gone */ }
      try { onCleanup?.(); } catch { /* ignore */ }
    },
    pause() {
      if (!alive) return;
      try { ptyProcess.kill('SIGSTOP'); } catch { /* already gone */ }
    },
    resume() {
      if (!alive) return;
      try { ptyProcess.kill('SIGCONT'); } catch { /* already gone */ }
    },
    onData(handler) {
      const sub = ptyProcess.onData((s) => handler(Buffer.from(s, 'utf-8')));
      return () => sub.dispose();
    },
    onExit(handler) {
      const sub = ptyProcess.onExit((e) => {
        try { onCleanup?.(); } catch { /* ignore */ }
        handler(e.exitCode ?? null, e.signal ?? null);
      });
      return () => sub.dispose();
    },
  };
}

// Suppress unused-import warning when path module isn't used by this
// implementation (kept for future use).
void path;
