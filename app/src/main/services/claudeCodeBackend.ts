/**
 * ClaudeCodeBackend — spawns `claude` (Claude Code CLI) in a pty.
 *
 * Hooks (PRD F3.2): we pass a per-session `--settings <path>` JSON file
 * that registers our hook-forwarder.js script as the handler for the
 * lifecycle events we care about (PreToolUse, Notification, Stop,
 * SessionEnd). The forwarder posts each event over a Unix socket to
 * the main process; main translates it into a `session.status_changed`
 * event on the renderer's event stream.
 *
 * Per F2.7: hooks must fail-open. The forwarder timeouts at 1500 ms
 * and writes "{}" if it can't reach us — never blocks Claude.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as pty from 'node-pty';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type {
  AgentBackend,
  AgentHandle,
  AgentSpawnOpts,
} from './agentBackend.js';
import { getHookServer } from './hookServer.js';
import { trustDirectoryForClaude } from './claudeTrust.js';

const execFileAsync = promisify(execFile);

export interface ClaudeCodeSpawnOpts extends AgentSpawnOpts {
  /** Used to scope hook events to this session. */
  sessionId: string;
  /** When set, spawn with `claude --resume <id>` to reload the
   *  previous conversation. */
  resumeClaudeSessionId?: string;
  /** When true, also pass `--dangerously-skip-permissions` so Claude
   *  auto-approves every tool use (YOLO mode). */
  skipPermissions?: boolean;
}

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

  async spawn(opts: ClaudeCodeSpawnOpts): Promise<AgentHandle> {
    // Pre-trust the cwd in Claude's user config so the CLI doesn't
    // sit on the "Do you trust this directory?" prompt — that prompt
    // blocks SessionStart from firing, which means the session's
    // claude_session_id never lands in our DB, which means restart
    // can't auto-resume. Idempotent + silent on failure.
    trustDirectoryForClaude(opts.cwd);

    const hooks = getHookServer();
    const forwarder = hooks.forwarderPath();

    // Per-session settings file. `--settings <file>` *adds* to the
    // user's existing settings — does NOT replace them. So user auth,
    // model, MCPs, plugins, etc. all still apply.
    const settingsPath = path.join(
      os.tmpdir(),
      `baton-claude-${opts.sessionId}.settings.json`
    );
    const hookCmd = (event: string): string =>
      // `node` is guaranteed available because Claude itself is a Node app.
      `node ${shellEscape(forwarder)} ${event}`;
    const settings = {
      hooks: {
        SessionStart: [
          {
            hooks: [{ type: 'command', command: hookCmd('SessionStart') }],
          },
        ],
        // Fires the instant the user submits a prompt — gives us the
        // "Claude is now working" signal even for pure-text responses
        // (no tool calls would mean PreToolUse never fires).
        UserPromptSubmit: [
          {
            hooks: [{ type: 'command', command: hookCmd('UserPromptSubmit') }],
          },
        ],
        PreToolUse: [
          {
            matcher: '*',
            hooks: [{ type: 'command', command: hookCmd('PreToolUse') }],
          },
        ],
        Notification: [
          {
            hooks: [{ type: 'command', command: hookCmd('Notification') }],
          },
        ],
        Stop: [
          {
            hooks: [{ type: 'command', command: hookCmd('Stop') }],
          },
        ],
        SessionEnd: [
          {
            hooks: [{ type: 'command', command: hookCmd('SessionEnd') }],
          },
        ],
      },
    };
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));

    const env = {
      ...process.env,
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
      BATON_HOOK_SOCK: hooks.sockPath(),
      BATON_SESSION_ID: opts.sessionId,
      ...(opts.env ?? {}),
    } as Record<string, string>;

    const args: string[] = ['--settings', settingsPath];
    if (opts.resumeClaudeSessionId) {
      args.push('--resume', opts.resumeClaudeSessionId);
    }
    if (opts.skipPermissions) {
      args.push('--dangerously-skip-permissions');
    }

    const ptyProcess = pty.spawn('claude', args, {
      name: 'xterm-256color',
      cols: opts.cols,
      rows: opts.rows,
      cwd: opts.cwd,
      env,
    });

    return wrap(ptyProcess, () => {
      try { fs.unlinkSync(settingsPath); } catch { /* best-effort cleanup */ }
    });
  }
}

function wrap(ptyProcess: pty.IPty, onCleanup: () => void): AgentHandle {
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
      onCleanup();
    },
    pause() {
      // SIGSTOP suspends the process without killing it. We do NOT
      // flip `alive` here — the handle is still valid for resize, data
      // subscription, and resume(). The pty just stops scheduling
      // until resume() (SIGCONT) is called.
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
        try { onCleanup(); } catch { /* ignore */ }
        handler(e.exitCode ?? null, e.signal ?? null);
      });
      return () => sub.dispose();
    },
  };
}

/** POSIX shell escape for absolute paths we pass to the hook command. */
function shellEscape(s: string): string {
  if (/^[\w./-]+$/.test(s)) return s;
  return `'${s.replace(/'/g, `'\\''`)}'`;
}
