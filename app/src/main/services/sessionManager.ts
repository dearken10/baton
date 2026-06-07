/**
 * SessionManager — owns the in-memory set of live agent sessions,
 * persists them to SQLite, and emits AppEvents on lifecycle changes.
 *
 * Status state machine (PRD F3.2):
 *   - spawn                        → running
 *   - hook: PreToolUse (after idle) → running
 *   - hook: Notification           → needs-input
 *   - hook: Stop                   → idle
 *   - hook: SessionEnd | pty exit  → done | errored
 *
 * Hooks always fail-open: handler returns `{}` so Claude is never
 * blocked even if our state machine throws (F2.7).
 *
 * Pty pipe path (F8.5): pty.onData → SessionManager → renderer via
 * `Channels.ptyData` push (NOT via the control bus or the event
 * stream). We never write to xterm directly from the pty callback.
 */

import { BrowserWindow } from 'electron';
import { randomUUID } from 'node:crypto';
import {
  Channels,
  type AgentBackendId,
  type Session,
  type SessionStatus,
} from '../../shared/ipc.js';
import { getDatabase } from '../database/index.js';
import type { AgentBackend, AgentHandle } from './agentBackend.js';
import { ClaudeCodeBackend } from './claudeCodeBackend.js';
import { LifecycleQueue } from './lifecycleQueue.js';
import { emit } from './eventBus.js';
import { getHookServer, type HookEvent } from './hookServer.js';

interface LiveSession {
  meta: Session;
  handle: AgentHandle;
}

export class SessionManager {
  private live = new Map<string, LiveSession>();
  private queue = new LifecycleQueue();
  private backends: Record<AgentBackendId, AgentBackend>;
  private hooksReady = false;

  constructor() {
    this.backends = {
      'claude-code': new ClaudeCodeBackend(),
    } as unknown as Record<AgentBackendId, AgentBackend>;
  }

  async startHookServer(): Promise<void> {
    if (this.hooksReady) return;
    await getHookServer().start((e) => this.handleHookEvent(e));
    this.hooksReady = true;
  }

  async spawn(opts: {
    projectId: string;
    backendId: AgentBackendId;
    cwd: string;
  }): Promise<Session> {
    await this.startHookServer();

    const backend = this.backends[opts.backendId];
    if (!backend) throw new Error(`Unknown backend: ${opts.backendId}`);

    const sessionId = randomUUID();
    return this.queue.run(sessionId, async () => {
      const installed = await backend.isInstalled();
      if (!installed) {
        throw new Error(
          `${opts.backendId} CLI not found on PATH. Install it and try again.`
        );
      }

      const handle = await backend.spawn({
        sessionId,
        cwd: opts.cwd,
        cols: 100,
        rows: 32,
      });

      const session: Session = {
        id: sessionId,
        projectId: opts.projectId,
        backendId: opts.backendId,
        branch: 'main', // TODO: read from git in W2.5
        worktreePath: opts.cwd,
        status: 'running',
        startedAt: Date.now(),
        endedAt: null,
        tokensIn: 0,
        tokensOut: 0,
        lastSummary: null,
      };

      getDatabase()
        .prepare(
          `INSERT INTO sessions (id, project_id, backend_id, branch, worktree_path, status, started_at, ended_at, tokens_in, tokens_out, last_summary)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          session.id,
          session.projectId,
          session.backendId,
          session.branch,
          session.worktreePath,
          session.status,
          session.startedAt,
          null,
          0,
          0,
          null
        );

      // Wire pty → renderer via the dedicated pty.data channel.
      handle.onData((chunk) => {
        const frame = {
          sessionId,
          data: chunk.toString('base64'),
        };
        for (const win of BrowserWindow.getAllWindows()) {
          if (!win.isDestroyed()) win.webContents.send(Channels.ptyData, frame);
        }
      });

      handle.onExit((exitCode) => {
        this.markExited(sessionId, exitCode);
      });

      this.live.set(sessionId, { meta: session, handle });

      emit({ type: 'session.spawned', session });
      return session;
    });
  }

  write(sessionId: string, data: string): void {
    const live = this.live.get(sessionId);
    if (!live) throw new Error(`session not live: ${sessionId}`);
    live.handle.write(data);
  }

  resize(sessionId: string, cols: number, rows: number): void {
    const live = this.live.get(sessionId);
    if (!live) return;
    live.handle.resize(cols, rows);
  }

  async kill(sessionId: string): Promise<void> {
    return this.queue.run(sessionId, async () => {
      const live = this.live.get(sessionId);
      if (!live) return;
      live.handle.kill('SIGTERM');
    });
  }

  list(): Session[] {
    return [...this.live.values()].map((l) => l.meta);
  }

  /** Apply a status transition, persist, and emit if it changed. */
  private setStatus(sessionId: string, next: SessionStatus): void {
    const live = this.live.get(sessionId);
    if (!live) return;
    const prev = live.meta.status;
    if (prev === next) return;
    live.meta = { ...live.meta, status: next };
    try {
      getDatabase()
        .prepare('UPDATE sessions SET status = ? WHERE id = ?')
        .run(next, sessionId);
    } catch {
      // fail-open on persistence — never block the agent
    }
    emit({
      type: 'session.status_changed',
      sessionId,
      from: prev,
      to: next,
    });
  }

  private markExited(sessionId: string, exitCode: number | null): void {
    const live = this.live.get(sessionId);
    if (!live) return;

    const next: SessionStatus = exitCode === 0 ? 'done' : 'errored';
    const prev = live.meta.status;
    live.meta = {
      ...live.meta,
      status: next,
      endedAt: Date.now(),
    };

    try {
      getDatabase()
        .prepare('UPDATE sessions SET status = ?, ended_at = ? WHERE id = ?')
        .run(next, live.meta.endedAt, sessionId);
    } catch { /* best-effort */ }

    if (prev !== next) {
      emit({
        type: 'session.status_changed',
        sessionId,
        from: prev,
        to: next,
      });
    }
    emit({ type: 'session.exited', sessionId, exitCode });

    this.live.delete(sessionId);
  }

  /**
   * Translate Claude Code hook events into status transitions.
   * Always returns `{}` so Claude proceeds normally (F2.7 fail-open).
   */
  private handleHookEvent(event: HookEvent): object {
    try {
      const live = this.live.get(event.sessionId);
      if (!live) return {};

      switch (event.event) {
        case 'PreToolUse':
          // Claude is actively working — only flip status if we're
          // currently idle (i.e. between turns) so we don't churn
          // the chip on every tool call inside one turn.
          if (live.meta.status === 'idle' || live.meta.status === 'needs-input') {
            this.setStatus(event.sessionId, 'running');
          }
          break;

        case 'Notification':
          this.setStatus(event.sessionId, 'needs-input');
          break;

        case 'Stop':
          this.setStatus(event.sessionId, 'idle');
          break;

        case 'SessionEnd':
          // pty exit will follow; treat as done preemptively.
          this.setStatus(event.sessionId, 'done');
          break;
      }
    } catch {
      // Never throw out to Claude.
    }
    return {};
  }

  killAll(): void {
    for (const { handle } of this.live.values()) {
      try {
        handle.kill('SIGTERM');
      } catch { /* best effort during shutdown */ }
    }
    getHookServer().stop();
  }
}

let instance: SessionManager | null = null;
export function getSessionManager(): SessionManager {
  if (!instance) instance = new SessionManager();
  return instance;
}
