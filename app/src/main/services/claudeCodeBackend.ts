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
import { HOOK_FORWARDER_SCRIPT } from './hookForwarderSource.js';
import { trustDirectoryForClaude } from './claudeTrust.js';
import type { BatonFs } from './fs/types.js';
import { RemoteFs } from './fs/remoteFs.js';

const execFileAsync = promisify(execFile);

export interface ClaudeCodeSpawnOpts extends AgentSpawnOpts {
  /** Used to scope hook events to this session. */
  sessionId: string;
  /** When set, spawn with `claude --resume <id>` to reload the
   *  previous conversation. */
  resumeAgentSessionId?: string;
  /** When true, also pass `--dangerously-skip-permissions` so Claude
   *  auto-approves every tool use (YOLO mode). */
  skipPermissions?: boolean;
  /** Optional `--model <name>` alias (e.g. "sonnet"/"opus"/"haiku").
   *  Undefined → don't pass the flag (Claude uses its configured
   *  default). */
  model?: string | null;
  /** The Fs whose host actually runs claude. LocalFs → claude runs on
   *  this Mac (the original path). RemoteFs → claude runs on the
   *  remote box, pty streamed over SSH. */
  fs?: BatonFs;
}

export class ClaudeCodeBackend implements AgentBackend {
  readonly id = 'claude-code' as const;

  async isInstalled(): Promise<boolean> {
    // Local install only — the remote spawn path probes claude via
    // ssh at spawn time (a quick `command -v claude` lives in the
    // shell line below, gated by a friendly error message).
    try {
      const { stdout } = await execFileAsync('claude', ['--version']);
      return /\d+\.\d+/.test(stdout);
    } catch {
      return false;
    }
  }

  async spawn(opts: ClaudeCodeSpawnOpts): Promise<AgentHandle> {
    if (opts.fs && !opts.fs.isLocal) {
      return this.spawnRemote(opts, opts.fs as RemoteFs);
    }
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
    if (opts.resumeAgentSessionId) {
      args.push('--resume', opts.resumeAgentSessionId);
    }
    if (opts.skipPermissions) {
      args.push('--dangerously-skip-permissions');
    }
    if (opts.model) {
      args.push('--model', opts.model);
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

  /**
   * Remote spawn — claude runs on the remote box, pty is streamed
   * over SSH. The hook bridge piggybacks on SSH's reverse port forward
   * so our Mac's hookServer still receives PreToolUse / Stop / etc.
   */
  private async spawnRemote(
    opts: ClaudeCodeSpawnOpts,
    remoteFs: RemoteFs,
  ): Promise<AgentHandle> {
    const hooks = getHookServer();
    const tcpPort = hooks.getTcpPort();
    if (!tcpPort) throw new Error('hookServer TCP port not started yet');

    // Probe & install dependencies on the remote. We need `claude` and
    // `node` (for our forwarder).
    //
    // We use `bash -ilc` (interactive login). Ubuntu/Debian's default
    // ~/.bashrc has `case $- in *i*) ;; *) return ;; esac` near the
    // top — a non-interactive shell exits before sourcing nvm,
    // npm-global, asdf, or whatever else adds claude to PATH. Adding
    // -i bypasses that guard. The cost is that an interactive bash
    // might print MOTD/aliases noise to the pty for the spawn case,
    // but that's strictly preferable to "claude not found".
    // Pre-flight: make sure the cwd actually exists. A missing dir
    // makes `cd` fail before the probe even runs, and we'd misreport
    // the failure as "claude not found".
    if (!(await remoteFs.exists(opts.cwd))) {
      throw new Error(
        `Remote project folder does not exist: ${opts.cwd}\n\n` +
        `SSH into ${remoteFs.profile.host} and \`mkdir -p ${opts.cwd}\`, ` +
        `or remove and re-add the project.`
      );
    }
    const probe = await remoteFs.exec(
      'bash', ['-ilc', 'command -v claude && command -v node || true'],
      { cwd: opts.cwd, timeoutMs: 8000 }
    );
    if (probe.code !== 0 || !probe.stdout.includes('claude')) {
      const path = probe.stdout.trim();
      const stderr = probe.stderr.trim();
      throw new Error(
        `claude CLI not found on remote host (${remoteFs.profile.host}).\n\n` +
        `Probe stdout: ${path || '(empty)'}\n` +
        `Probe stderr: ${stderr || '(empty)'}\n` +
        `Probe exit: ${probe.code}\n\n` +
        `SSH into the host and run \`bash -ilc 'which claude'\` to ` +
        `reproduce — that's what baton runs.`
      );
    }

    // Write the per-session settings file and a copy of the forwarder
    // script under ~/.baton on the remote. We can't reuse the local
    // path because Claude on the remote can't see our Mac's disk.
    // Resolve HOME via a one-shot ssh — we need a real absolute path
    // for forwarderPath / settingsPath.
    const homeRes = await remoteFs.exec('bash', ['-ilc', 'echo "$HOME"'], {
      cwd: '/', timeoutMs: 4000,
    });
    const remoteHome = homeRes.stdout.trim() || '/tmp';
    const remoteDir = `${remoteHome}/.baton`;
    const remoteForwarder = `${remoteDir}/hook-forwarder.js`;
    const remoteSettings = `${remoteDir}/baton-claude-${opts.sessionId}.settings.json`;

    await remoteFs.mkdir(remoteDir, { recursive: true });
    // The forwarder script is the same on local + remote — read TCP
    // env first, fall back to BATON_HOOK_SOCK.
    await remoteFs.writeFile(remoteForwarder, HOOK_FORWARDER_SCRIPT);
    // chmod +x — helpful when the user runs it standalone, not
    // strictly required since claude invokes it via `node`.
    await remoteFs.exec('chmod', ['+x', remoteForwarder], {
      cwd: remoteDir, timeoutMs: 4000,
    }).catch(() => { /* best-effort */ });

    const hookCmd = (event: string): string =>
      `node ${shellEscape(remoteForwarder)} ${event}`;
    const settings = {
      hooks: {
        SessionStart: [
          { hooks: [{ type: 'command', command: hookCmd('SessionStart') }] },
        ],
        UserPromptSubmit: [
          { hooks: [{ type: 'command', command: hookCmd('UserPromptSubmit') }] },
        ],
        PreToolUse: [
          { matcher: '*', hooks: [{ type: 'command', command: hookCmd('PreToolUse') }] },
        ],
        Notification: [
          { hooks: [{ type: 'command', command: hookCmd('Notification') }] },
        ],
        Stop: [
          { hooks: [{ type: 'command', command: hookCmd('Stop') }] },
        ],
        SessionEnd: [
          { hooks: [{ type: 'command', command: hookCmd('SessionEnd') }] },
        ],
      },
    };
    await remoteFs.writeFile(remoteSettings, JSON.stringify(settings, null, 2));

    // Pre-trust the worktree on the remote so claude doesn't sit on
    // the "Quick safety check: do you trust this directory?" prompt
    // the first time. Claude reads ~/.claude.json (NOT ~/.claude/
    // config.json — the latter is unrelated). See ./claudeTrust.ts
    // for the local equivalent.
    //
    // We resolve the cwd's realpath (Claude stores the symlink-resolved
    // form), then merge a stub entry into projects[<realpath>]. If the
    // entry already exists with hasTrustDialogAccepted=true, the inner
    // script no-ops. Atomic-ish write via rename.
    await remoteFs.exec('bash', ['-ilc',
      `node -e '` +
      `const fs=require("fs"),p=require("path"); ` +
      `const home=process.env.HOME||"/tmp"; ` +
      `const f=p.join(home,".claude.json"); ` +
      `let cwd=${JSON.stringify(opts.cwd)}; ` +
      `try{cwd=fs.realpathSync(cwd);}catch(e){} ` +
      `let cfg={}; try{cfg=JSON.parse(fs.readFileSync(f,"utf8"));}catch(e){} ` +
      `cfg.projects=cfg.projects||{}; ` +
      `const stub={"allowedTools":[],"mcpContextUris":[],"mcpServers":{},"enabledMcpjsonServers":[],"disabledMcpjsonServers":[],"hasTrustDialogAccepted":true}; ` +
      `cfg.projects[cwd]=Object.assign({},stub,cfg.projects[cwd]||{},{"hasTrustDialogAccepted":true}); ` +
      `try{const tmp=f+".baton.tmp";fs.writeFileSync(tmp,JSON.stringify(cfg,null,2));fs.renameSync(tmp,f);}catch(e){}'`,
    ], { cwd: remoteHome, timeoutMs: 5000 }).catch(() => { /* best-effort */ });

    const claudeArgs: string[] = ['--settings', remoteSettings];
    if (opts.resumeAgentSessionId) {
      claudeArgs.push('--resume', opts.resumeAgentSessionId);
    }
    if (opts.skipPermissions) {
      claudeArgs.push('--dangerously-skip-permissions');
    }
    if (opts.model) {
      claudeArgs.push('--model', opts.model);
    }

    const remoteEnv: Record<string, string> = {
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
      BATON_HOOK_TCP: `127.0.0.1:${tcpPort}`,
      BATON_SESSION_ID: opts.sessionId,
      ...(opts.env ?? {}),
    };

    // Wrap the claude exec in `bash -ilc` to match the probe (see the
    // long comment above on the probe). Without -i, Ubuntu/Debian's
    // default ~/.bashrc returns early for non-interactive shells and
    // any PATH adjustments there (nvm, npm-global, asdf, …) don't
    // apply. The probe finding claude but the spawn not would be a
    // miserable failure mode.
    const innerCmd = `exec claude ${claudeArgs.map(shellEscape).join(' ')}`;
    const handle = await remoteFs.spawnPty({
      command: 'bash',
      args: ['-ilc', innerCmd],
      cwd: opts.cwd,
      env: remoteEnv,
      cols: opts.cols,
      rows: opts.rows,
      // Forward the remote's `<tcpPort>` to our Mac's hook listener
      // through the existing master. Same port number on both ends
      // keeps the env var simple.
      reverseForward: [{ remotePort: tcpPort, localPort: tcpPort }],
    });

    // Clean up the settings file when the session ends. Use the
    // pty's onExit subscription so we don't leak per-session JSONs.
    handle.onExit(() => {
      void remoteFs.rm(remoteSettings, { force: true }).catch(() => { /* ignore */ });
    });
    return handle;
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
