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
import { readCurrentBranch } from './gitReader.js';

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

  /**
   * Boot housekeeping: SQLite may still have sessions marked
   * `running` / `needs-input` / `idle` from before the app was last
   * closed. Their pty processes are gone — mark them ended so the
   * UI doesn't lie. (PRD F2.4 says restore must never leave stale
   * state.) Returns the ids that were swept so callers can auto-
   * resume them.
   */
  reconcileStaleSessions(): string[] {
    try {
      const stale = getDatabase()
        .prepare(
          `SELECT id FROM sessions
            WHERE status IN ('running', 'needs-input', 'idle', 'paused', 'disconnected')`
        )
        .all() as { id: string }[];
      const ids = stale.map((s) => s.id);
      if (ids.length > 0) {
        const now = Date.now();
        const placeholders = ids.map(() => '?').join(',');
        getDatabase()
          .prepare(
            `UPDATE sessions
               SET status = 'done',
                   ended_at = COALESCE(ended_at, ?)
             WHERE id IN (${placeholders})`
          )
          .run(now, ...ids);
      }
      return ids;
    } catch {
      // best-effort — never block boot
      return [];
    }
  }

  /**
   * Auto-resume sessions that the app didn't gracefully close. Called
   * once after the window finishes loading so the renderer is
   * subscribed to events. Limits and recency thresholds avoid
   * spawning a horde of Claude processes from old runs.
   */
  async autoResumeRecent(opts: {
    candidateIds?: string[];
    maxAgeMs?: number;
    limit?: number;
  } = {}): Promise<void> {
    const maxAge = opts.maxAgeMs ?? 24 * 60 * 60 * 1000;
    const limit = opts.limit ?? 10;
    const now = Date.now();
    let rows: { id: string; claude_session_id: string | null }[];
    try {
      if (opts.candidateIds && opts.candidateIds.length > 0) {
        const placeholders = opts.candidateIds.map(() => '?').join(',');
        rows = getDatabase()
          .prepare(
            `SELECT id, claude_session_id
               FROM sessions
              WHERE id IN (${placeholders})
                AND claude_session_id IS NOT NULL
                AND ended_at > ?
              ORDER BY ended_at DESC
              LIMIT ?`
          )
          .all(...opts.candidateIds, now - maxAge, limit) as never;
      } else {
        rows = getDatabase()
          .prepare(
            `SELECT id, claude_session_id
               FROM sessions
              WHERE status IN ('done', 'errored')
                AND claude_session_id IS NOT NULL
                AND ended_at > ?
              ORDER BY ended_at DESC
              LIMIT ?`
          )
          .all(now - maxAge, limit) as never;
      }
    } catch {
      return;
    }

    for (const r of rows) {
      try {
        await this.resume(r.id);
      } catch (err) {
        // Resume can fail for legitimate reasons (Claude's transcript
        // was deleted, --resume rejects the id, etc.). Don't let one
        // bad row stop the rest.
        // eslint-disable-next-line no-console
        console.warn(`[code24] auto-resume of ${r.id} failed:`, err);
      }
    }
  }

  /**
   * All sessions known to SQLite + live in-memory state. Live rows
   * win because they're authoritative for status while the app is
   * running. Ordered most-recently-started first.
   */
  listAll(): Session[] {
    const rows = getDatabase()
      .prepare(
        `SELECT id, project_id, backend_id, branch, worktree_path, status,
                started_at, ended_at, tokens_in, tokens_out, last_summary,
                claude_session_id
           FROM sessions
          ORDER BY started_at DESC`
      )
      .all() as {
        id: string; project_id: string; backend_id: string;
        branch: string; worktree_path: string; status: string;
        started_at: number; ended_at: number | null;
        tokens_in: number; tokens_out: number; last_summary: string | null;
        claude_session_id: string | null;
      }[];

    return rows.map((r) => {
      const live = this.live.get(r.id);
      if (live) return live.meta;
      return {
        id: r.id,
        projectId: r.project_id,
        backendId: r.backend_id as Session['backendId'],
        branch: r.branch,
        worktreePath: r.worktree_path,
        status: r.status as Session['status'],
        startedAt: r.started_at,
        endedAt: r.ended_at,
        tokensIn: r.tokens_in,
        tokensOut: r.tokens_out,
        lastSummary: r.last_summary,
        claudeSessionId: r.claude_session_id,
      };
    });
  }

  async spawn(opts: {
    projectId: string;
    backendId: AgentBackendId;
    cwd: string;
    /** When set, reuse this code24 session row (the user clicked
     *  "Resume" on an ended row) instead of inserting a fresh one. */
    reuseSessionId?: string;
    /** When set, spawn Claude with `--resume <id>`. */
    resumeClaudeSessionId?: string;
  }): Promise<Session> {
    await this.startHookServer();

    const backend = this.backends[opts.backendId];
    if (!backend) throw new Error(`Unknown backend: ${opts.backendId}`);

    const sessionId = opts.reuseSessionId ?? randomUUID();
    return this.queue.run(sessionId, async () => {
      const installed = await backend.isInstalled();
      if (!installed) {
        throw new Error(
          `${opts.backendId} CLI not found on PATH. Install it and try again.`
        );
      }

      // Read git metadata BEFORE the pty is spawned. If we did this
      // after spawn, there'd be a window where Claude is alive (and
      // could fire SessionStart) but `this.live` doesn't yet contain
      // the session — the hook would silently no-op.
      const branch = (await readCurrentBranch(opts.cwd)) ?? 'no git';

      const spawnOpts: {
        sessionId: string;
        cwd: string;
        cols: number;
        rows: number;
        resumeClaudeSessionId?: string;
      } = {
        sessionId,
        cwd: opts.cwd,
        cols: 100,
        rows: 32,
      };
      if (opts.resumeClaudeSessionId) {
        spawnOpts.resumeClaudeSessionId = opts.resumeClaudeSessionId;
      }
      const handle = await (backend as { spawn: (o: typeof spawnOpts) => Promise<AgentHandle> }).spawn(spawnOpts);

      const session: Session = {
        id: sessionId,
        projectId: opts.projectId,
        backendId: opts.backendId,
        branch,
        worktreePath: opts.cwd,
        status: 'running',
        startedAt: Date.now(),
        endedAt: null,
        tokensIn: 0,
        tokensOut: 0,
        lastSummary: null,
        claudeSessionId: opts.resumeClaudeSessionId ?? null,
      };

      // Make the session visible to the hook handler IMMEDIATELY,
      // before any IO that could race against SessionStart firing.
      this.live.set(sessionId, { meta: session, handle });

      // Insert OR revive (resume): on conflict, restore the row.
      getDatabase()
        .prepare(
          `INSERT INTO sessions (id, project_id, backend_id, branch, worktree_path, status, started_at, ended_at, tokens_in, tokens_out, last_summary, claude_session_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             status     = excluded.status,
             ended_at   = NULL,
             worktree_path = excluded.worktree_path`
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
          null,
          session.claudeSessionId
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

  /**
   * Resume an ended session: re-uses the original code24 session id
   * and passes the captured Claude session id to `claude --resume`.
   * The user's prior conversation history is restored by Claude itself.
   */
  async resume(sessionId: string): Promise<Session> {
    const row = getDatabase()
      .prepare(
        `SELECT id, project_id, backend_id, branch, worktree_path,
                claude_session_id
           FROM sessions WHERE id = ?`
      )
      .get(sessionId) as
      | {
          id: string;
          project_id: string;
          backend_id: string;
          branch: string;
          worktree_path: string;
          claude_session_id: string | null;
        }
      | undefined;
    if (!row) throw new Error(`No such session: ${sessionId}`);
    if (this.live.has(sessionId)) throw new Error(`Already live: ${sessionId}`);
    if (!row.claude_session_id) {
      throw new Error(
        'Cannot resume — no Claude session id was captured for this session.'
      );
    }
    return this.spawn({
      projectId: row.project_id,
      backendId: row.backend_id as AgentBackendId,
      cwd: row.worktree_path,
      reuseSessionId: row.id,
      resumeClaudeSessionId: row.claude_session_id,
    });
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

  /** Capture Claude's internal session id (from SessionStart payload). */
  private recordClaudeSessionId(sessionId: string, claudeSid: string): void {
    const live = this.live.get(sessionId);
    if (live) live.meta = { ...live.meta, claudeSessionId: claudeSid };
    try {
      getDatabase()
        .prepare('UPDATE sessions SET claude_session_id = ? WHERE id = ?')
        .run(claudeSid, sessionId);
    } catch {
      // best-effort
    }
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
        case 'SessionStart': {
          // Capture Claude's internal session id from the hook payload
          // so we can `claude --resume <id>` later (PRD F2.4). Verified
          // schema: { session_id, transcript_path, cwd, hook_event_name,
          // source, model, ... }.
          const body = event.body as { session_id?: string } | undefined;
          const claudeSid = body?.session_id;
          if (claudeSid) this.recordClaudeSessionId(event.sessionId, claudeSid);
          // Claude finished loading and is at the prompt waiting for
          // the user's first message — that's idle, not running.
          this.setStatus(event.sessionId, 'idle');
          break;
        }

        case 'UserPromptSubmit':
          // User hit enter on a prompt — Claude is about to (or already
          // is) generating a response. This is the only signal that
          // works for pure-text responses, where no PreToolUse fires.
          this.setStatus(event.sessionId, 'running');
          break;

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
