/**
 * HookServer — receives Claude Code hook events forwarded by our
 * hook-forwarder.js script over a Unix socket, dispatches them
 * to a handler, and writes the handler's reply back to the script
 * (which writes it to Claude's stdout).
 *
 * Per PRD F2.7: handlers must complete within a bounded time. The
 * forwarder script also has its own 1500 ms timeout so even a
 * deadlocked main process never freezes Claude.
 */

import { app } from 'electron';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as path from 'node:path';
import { HOOK_FORWARDER_SCRIPT } from './hookForwarderSource.js';
import { trace, shortSid } from './statusTrace.js';

export interface HookEvent {
  sessionId: string;
  /** PreToolUse / Notification / Stop / SessionEnd / etc. */
  event: string;
  body: unknown;
}

export type HookHandler = (e: HookEvent) => Promise<object | undefined> | object | undefined;

export class HookServer {
  private server: net.Server | null = null;
  private handler: HookHandler | null = null;

  /** Path to the unix socket main listens on.
   *
   *  Includes our pid so two baton instances (e.g. an installed build
   *  and a dev `electron-vite dev` running out of a worktree) don't
   *  fight over the same socket path. Without this, the later starter
   *  would `unlink()` the earlier one's socket and steal all of its
   *  Claude sessions' hooks, leaving the earlier instance's chips
   *  permanently stuck at `running`. */
  sockPath(): string {
    return path.join(app.getPath('home'), '.baton', `hooks-${process.pid}.sock`);
  }

  /** Path of the hook-forwarder.js script on disk. */
  forwarderPath(): string {
    return path.join(app.getPath('home'), '.baton', 'hook-forwarder.js');
  }

  /** Best-effort: remove `hooks-*.sock` files whose owner process is
   *  gone. Stops the directory from accumulating dead sockets when
   *  baton crashes or is force-killed. Never throws — a leaked socket
   *  is harmless; aborting startup over it would be worse. */
  private sweepStaleSockets(dir: string): void {
    let entries: string[];
    try { entries = fs.readdirSync(dir); } catch { return; }
    for (const name of entries) {
      const m = /^hooks-(\d+)\.sock$/.exec(name);
      if (!m) continue;
      const pid = Number(m[1]);
      if (pid === process.pid) continue;
      let alive = false;
      try {
        // Signal 0 just tests for liveness without delivering one.
        process.kill(pid, 0);
        alive = true;
      } catch { /* ESRCH — no such process */ }
      if (alive) continue;
      try { fs.unlinkSync(path.join(dir, name)); } catch { /* ignore */ }
    }
  }

  /** Write the forwarder script and start listening. Safe to call multiple times. */
  async start(handler: HookHandler): Promise<void> {
    this.handler = handler;

    const dir = path.join(app.getPath('home'), '.baton');
    fs.mkdirSync(dir, { recursive: true });

    // Write (or rewrite) the forwarder script and make it executable.
    fs.writeFileSync(this.forwarderPath(), HOOK_FORWARDER_SCRIPT, { mode: 0o755 });

    this.sweepStaleSockets(dir);

    const sockPath = this.sockPath();
    // Our pid is unique to this process, so any file at this path is a
    // leftover from a prior crashed run with the same pid — safe to
    // remove. (sweepStaleSockets handles other pids.)
    try { fs.unlinkSync(sockPath); } catch { /* no prior socket */ }

    this.server = net.createServer((client) => this.onClient(client));
    await new Promise<void>((resolve, reject) => {
      this.server!.once('error', reject);
      this.server!.listen(sockPath, () => {
        this.server!.off('error', reject);
        resolve();
      });
    });
  }

  stop(): void {
    if (this.server) {
      this.server.close();
      this.server = null;
    }
    try { fs.unlinkSync(this.sockPath()); } catch { /* ignore */ }
  }

  private onClient(client: net.Socket): void {
    let buf = '';
    let done = false;

    const finishWith = (reply: object): void => {
      if (done) return;
      done = true;
      try {
        client.write(JSON.stringify(reply) + '\n', () => client.end());
      } catch {
        try { client.destroy(); } catch { /* ignore */ }
      }
    };

    client.setTimeout(2000);
    client.on('timeout', () => finishWith({}));
    client.on('error', () => finishWith({}));

    client.on('data', async (chunk) => {
      buf += chunk.toString('utf8');
      const nlIdx = buf.indexOf('\n');
      if (nlIdx < 0) return;
      const line = buf.slice(0, nlIdx);
      try {
        const event = JSON.parse(line) as HookEvent;
        trace('HOOK_RECV', {
          sid: shortSid(event.sessionId),
          event: event.event,
          bodyKeys: event.body && typeof event.body === 'object'
            ? Object.keys(event.body as object).join(',') || '∅'
            : '∅',
        });
        const reply = (await this.handler?.(event)) ?? {};
        finishWith(reply);
      } catch (err) {
        trace('HOOK_PARSE_ERR', {
          err: String(err).slice(0, 80).replace(/\s+/g, '_'),
          preview: line.slice(0, 60).replace(/\s+/g, '_'),
        });
        finishWith({});
      }
    });
  }
}

let instance: HookServer | null = null;
export function getHookServer(): HookServer {
  if (!instance) instance = new HookServer();
  return instance;
}
