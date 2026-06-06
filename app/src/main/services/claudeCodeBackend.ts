/**
 * ClaudeCodeBackend — spawns `claude` (Claude Code CLI) in a pty.
 *
 * MVP: launches `claude` as a fully interactive TUI in the session's
 * worktree (or project root). pty stdout streams back to the renderer
 * via the `pty.data` channel; the renderer's xterm.js writes user
 * keystrokes back via `pty.write`.
 *
 * No hook installation yet — that's W3+ work, when status surfacing
 * and HITL semaphore land.
 */

import * as pty from 'node-pty';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type {
  AgentBackend,
  AgentHandle,
  AgentSpawnOpts,
} from './agentBackend.js';

const execFileAsync = promisify(execFile);

export class ClaudeCodeBackend implements AgentBackend {
  readonly id = 'claude-code' as const;

  async isInstalled(): Promise<boolean> {
    try {
      const { stdout } = await execFileAsync('claude', ['--version']);
      return /\d+\.\d+/.test(stdout);
    } catch {
      return false;
    }
  }

  async spawn(opts: AgentSpawnOpts): Promise<AgentHandle> {
    const env = {
      ...process.env,
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
      ...(opts.env ?? {}),
    } as Record<string, string>;

    const ptyProcess = pty.spawn('claude', [], {
      name: 'xterm-256color',
      cols: opts.cols,
      rows: opts.rows,
      cwd: opts.cwd,
      env,
    });

    return wrap(ptyProcess);
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
      try {
        ptyProcess.kill(signal ?? 'SIGTERM');
      } catch {
        // pty might already be gone
      }
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
