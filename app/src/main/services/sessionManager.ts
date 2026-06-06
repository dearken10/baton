/**
 * SessionManager — owns the in-memory set of live agent sessions,
 * persists them to SQLite, and emits AppEvents on lifecycle changes.
 *
 * Per PRD F2.3 + F2.5: panels-first model. v1 MVP exposes a single
 * "agent" panel per session; the data shape already accommodates
 * multiple panels per session for v2.
 *
 * Per PRD F2.6: backends are pluggable. v1 ships ClaudeCodeBackend
 * and MockAgentBackend.
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

interface LiveSession {
  meta: Session;
  handle: AgentHandle;
  /** Coalesced data buffer not yet flushed to renderer (reserved for F8.6). */
  // pending: Buffer[];
}

export class SessionManager {
  private live = new Map<string, LiveSession>();
  private queue = new LifecycleQueue();
  private backends: Record<AgentBackendId, AgentBackend>;

  constructor() {
    this.backends = {
      'claude-code': new ClaudeCodeBackend(),
      // 'codex': new CodexBackend(),  // v2
      // 'mock': new MockAgentBackend(), // wired in next pass
    } as unknown as Record<AgentBackendId, AgentBackend>;
  }

  async spawn(opts: {
    projectId: string;
    backendId: AgentBackendId;
    cwd: string;
  }): Promise<Session> {
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

      // Persist.
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
      // Exit handler will mark the session and emit.
    });
  }

  list(): Session[] {
    return [...this.live.values()].map((l) => l.meta);
  }

  private markExited(sessionId: string, exitCode: number | null): void {
    const live = this.live.get(sessionId);
    if (!live) return;

    const prev = live.meta.status;
    const next: SessionStatus = exitCode === 0 ? 'done' : 'errored';
    live.meta = {
      ...live.meta,
      status: next,
      endedAt: Date.now(),
    };

    getDatabase()
      .prepare(
        'UPDATE sessions SET status = ?, ended_at = ? WHERE id = ?'
      )
      .run(next, live.meta.endedAt, sessionId);

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

  killAll(): void {
    for (const { handle } of this.live.values()) {
      try {
        handle.kill('SIGTERM');
      } catch {
        // best effort during shutdown
      }
    }
  }
}

let instance: SessionManager | null = null;
export function getSessionManager(): SessionManager {
  if (!instance) instance = new SessionManager();
  return instance;
}
