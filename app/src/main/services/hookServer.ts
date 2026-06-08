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

  /** Path to the unix socket main listens on. */
  sockPath(): string {
    return path.join(app.getPath('home'), '.baton', 'hooks.sock');
  }

  /** Path of the hook-forwarder.js script on disk. */
  forwarderPath(): string {
    return path.join(app.getPath('home'), '.baton', 'hook-forwarder.js');
  }

  /** Write the forwarder script and start listening. Safe to call multiple times. */
  async start(handler: HookHandler): Promise<void> {
    this.handler = handler;

    const dir = path.join(app.getPath('home'), '.baton');
    fs.mkdirSync(dir, { recursive: true });

    // Write (or rewrite) the forwarder script and make it executable.
    fs.writeFileSync(this.forwarderPath(), HOOK_FORWARDER_SCRIPT, { mode: 0o755 });

    const sockPath = this.sockPath();
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
        const reply = (await this.handler?.(event)) ?? {};
        finishWith(reply);
      } catch {
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
