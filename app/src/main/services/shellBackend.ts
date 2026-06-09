/**
 * ShellBackend — spawn the user's login shell in a pty.
 *
 * Same xterm + scrollback + persistence path Claude sessions use; the
 * difference is that we register no hooks and the pty is just
 * `$SHELL -l` instead of `claude`. Used by the project menu's
 * "New Terminal" item.
 */

import * as pty from 'node-pty';
import type {
  AgentBackend,
  AgentHandle,
  AgentSpawnOpts,
} from './agentBackend.js';
import type { BatonFs } from './fs/types.js';
import { RemoteFs } from './fs/remoteFs.js';

export interface ShellSpawnOpts extends AgentSpawnOpts {
  fs?: BatonFs;
}

export class ShellBackend implements AgentBackend {
  readonly id = 'shell' as const;

  async isInstalled(): Promise<boolean> {
    // The user has a shell — `process.env.SHELL` or a sensible default.
    return true;
  }

  async spawn(opts: ShellSpawnOpts): Promise<AgentHandle> {
    if (opts.fs && !opts.fs.isLocal) {
      return this.spawnRemote(opts, opts.fs as RemoteFs);
    }
    const shellPath = process.env['SHELL'] ?? '/bin/zsh';

    // Strip env vars npm + Electron inject into us so the user's
    // shell behaves like Terminal.app launched from Finder. Without
    // this, nvm refuses to load (npm_config_prefix conflict) and
    // builds inherit weird NODE_OPTIONS etc.
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (v === undefined) continue;
      if (k.startsWith('npm_')) continue;       // npm_config_*, npm_lifecycle_*, …
      if (k.startsWith('ELECTRON_')) continue;  // ELECTRON_RUN_AS_NODE, ELECTRON_RENDERER_URL
      if (k === 'INIT_CWD') continue;           // npm sets this
      if (k === 'NODE_OPTIONS') continue;       // electron-vite sets this
      env[k] = v;
    }
    env['TERM'] = 'xterm-256color';
    env['COLORTERM'] = 'truecolor';
    Object.assign(env, opts.env ?? {});

    // `-l` opens a login shell so the user's profile is sourced; that
    // matches what they'd get if they opened Terminal.app and is what
    // they typically expect from "a fresh terminal here".
    const ptyProcess = pty.spawn(shellPath, ['-l'], {
      name: 'xterm-256color',
      cols: opts.cols,
      rows: opts.rows,
      cwd: opts.cwd,
      env,
    });

    return wrap(ptyProcess);
  }

  /** Spawn a login shell on the remote. The user's `~/.profile` etc.
   *  loads naturally because `bash -l` is what runs at the other end
   *  of the SSH session. */
  private async spawnRemote(opts: ShellSpawnOpts, remoteFs: RemoteFs): Promise<AgentHandle> {
    const remoteEnv: Record<string, string> = {
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
      ...(opts.env ?? {}),
    };
    // `bash -il` = interactive login. The user is dropping into a real
    // terminal so they want the full interactive setup (prompt, aliases,
    // nvm, …). Login + interactive both being set also matches what
    // ssh'ing directly into the box gives them.
    const handle = await remoteFs.spawnPty({
      command: 'bash',
      args: ['-il'],
      cwd: opts.cwd,
      env: remoteEnv,
      cols: opts.cols,
      rows: opts.rows,
    });
    return handle;
  }
}

function wrap(ptyProcess: pty.IPty): AgentHandle {
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
      try { ptyProcess.kill(signal ?? 'SIGTERM'); }
      catch { /* pty might already be gone */ }
    },
    pause() {
      if (!alive) return;
      try { ptyProcess.kill('SIGSTOP'); } catch { /* ignore */ }
    },
    resume() {
      if (!alive) return;
      try { ptyProcess.kill('SIGCONT'); } catch { /* ignore */ }
    },
    onData(handler) {
      const sub = ptyProcess.onData((s) => handler(Buffer.from(s, 'utf-8')));
      return () => sub.dispose();
    },
    onExit(handler) {
      const sub = ptyProcess.onExit((e) =>
        handler(e.exitCode ?? null, e.signal ?? null)
      );
      return () => sub.dispose();
    },
  };
}
