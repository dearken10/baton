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
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  Channels,
  type AgentBackendId,
  type Session,
  type SessionStatus,
} from '../../shared/ipc.js';
import { getDatabase } from '../database/index.js';
import type { AgentBackend, AgentHandle } from './agentBackend.js';
import { ClaudeCodeBackend } from './claudeCodeBackend.js';
import { ShellBackend } from './shellBackend.js';
import { LifecycleQueue } from './lifecycleQueue.js';
import { emit } from './eventBus.js';
import { getHookServer, type HookEvent } from './hookServer.js';
import { readCurrentBranch } from './gitReader.js';
import {
  createWorktree,
  removeWorktree,
  renameWorktree,
} from './worktreeManager.js';
import { getProject, setProjectSnoozed } from './projectStore.js';
import { trace, shortSid } from './statusTrace.js';
import { readTranscriptUsage } from './transcriptReader.js';
import { runSetupScript } from './setupScript.js';
import { summarizeSession, summarizeTerminal } from './intentSummarizer.js';

interface LiveSession {
  meta: Session;
  handle: AgentHandle;
  /** Wall-clock ms of the most recent transition INTO 'idle' (or null
   *  if the session has never been idle). Used by the idle-pause
   *  sweeper (PRD F11.4). Cleared when status moves off 'idle'. */
  lastIdleAt: number | null;
  /** Recent raw pty bytes — the last RECENT_PTY_CAP bytes the pty has
   *  emitted. Used so a TerminalPane mounting AFTER pty data started
   *  flowing (typical for shell sessions, whose welcome banner is
   *  printed in milliseconds) can still replay the initial state. */
  recentPtyBytes: Buffer;
}

const RECENT_PTY_CAP = 1_000_000;

/** Default idle threshold for auto-pause. Per-project override (F11.4)
 *  comes later; for now a single global value. Override at runtime
 *  with BATON_IDLE_PAUSE_AFTER_SEC for testing (e.g. 30 = 30 sec). */
const IDLE_PAUSE_AFTER_MS = (() => {
  const raw = process.env['BATON_IDLE_PAUSE_AFTER_SEC'];
  if (raw) {
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0) return n * 1000;
  }
  return 30 * 60 * 1000;
})();
/** How often the sweeper scans live sessions. */
const IDLE_SWEEP_INTERVAL_MS = (() => {
  // For dev-overridden thresholds shorter than the default 60s scan,
  // tick more often so the pause feels prompt.
  const min = Math.min(60_000, Math.max(2_000, Math.floor(IDLE_PAUSE_AFTER_MS / 4)));
  return min;
})();

/**
 * Claude organises its transcript files under
 * `~/.claude/projects/<sanitised-cwd>/<session_id>.jsonl`. Verified
 * empirically against real dirs: both `/` and `.` collapse to `-`,
 * so `/Users/x/proj/.baton/worktrees/wip-a` becomes
 * `-Users-x-proj--baton-worktrees-wip-a` (note the double dash from
 * `/.`).
 *
 * Why we check: Claude only writes the transcript on the first user
 * prompt. If a session got SessionStart (we captured an id) but the
 * user never typed anything before the app was closed, no .jsonl
 * exists, and `claude --resume <id>` will exit non-zero. That used
 * to leave the chip stuck on "errored" after restart.
 */
function claudeTranscriptPath(cwd: string, claudeSessionId: string): string {
  // Claude:
  //   1. Resolves symlinks on the cwd (so /var/folders → /private/var/folders).
  //   2. Replaces `/`, `.`, AND `_` with `-` (verified empirically by
  //      looking at the dir name Claude creates for a /var/folders path
  //      with underscores in it).
  // Anything we miss here means autoResume looks at the wrong path,
  // doesn't find the transcript, clears the captured id, and the
  // session shows "ended" after restart.
  let real = cwd;
  try { real = fs.realpathSync(cwd); } catch { /* fall back to cwd */ }
  const sanitized = real.replace(/[/._]/g, '-');
  return path.join(
    os.homedir(),
    '.claude',
    'projects',
    sanitized,
    `${claudeSessionId}.jsonl`
  );
}

function claudeTranscriptExists(cwd: string, claudeSessionId: string): boolean {
  try {
    return fs.existsSync(claudeTranscriptPath(cwd, claudeSessionId));
  } catch {
    return false;
  }
}

export class SessionManager {
  private live = new Map<string, LiveSession>();
  private queue = new LifecycleQueue();
  private backends: Record<AgentBackendId, AgentBackend>;
  private hooksReady = false;
  /** Session ids the manager itself just killed as part of a planned
   *  respawn (YOLO toggle, future restart-on-config-change, …). When
   *  the pty exit fires, markExited consults this set and swallows
   *  the status_changed/exit events so the renderer doesn't see a
   *  brief "errored" flash before the new spawn lands. */
  private intentionalKills = new Set<string>();
  /** When the most recent UserPromptSubmit fired for each session.
   *  Used to log "time from user enter → chip flipped" and
   *  "time from user enter → summary generated" so we can see where
   *  the perceived latency actually lives. Cleared on Stop. */
  private promptSubmittedAt = new Map<string, number>();

  constructor() {
    this.backends = {
      'claude-code': new ClaudeCodeBackend(),
      'shell':       new ShellBackend(),
    } as unknown as Record<AgentBackendId, AgentBackend>;
  }

  async startHookServer(): Promise<void> {
    if (this.hooksReady) return;
    await getHookServer().start((e) => this.handleHookEvent(e));
    this.hooksReady = true;
    // Idle-pause sweeper runs alongside the hook server (PRD F11.4).
    // Cheap: it's a single map iteration once per minute.
    this.startIdleSweeper();
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
      // 1. Sessions left in a live state (running/idle/etc.) from
      //    before the app was closed — their ptys are gone, mark
      //    them done.
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

      // 2. Errored rows whose claude_session_id points to a
      //    transcript that doesn't exist — left over from a previous
      //    failed auto-resume (typically a worktree session that was
      //    never used before being closed, so Claude never wrote a
      //    .jsonl). Clear the dead id and flip back to done so the
      //    chip stops shouting "error" and we don't try resuming
      //    again on the next boot.
      const orphans = getDatabase()
        .prepare(
          `SELECT id, claude_session_id, worktree_path
             FROM sessions
            WHERE status = 'errored'
              AND claude_session_id IS NOT NULL`
        )
        .all() as {
          id: string; claude_session_id: string; worktree_path: string;
        }[];
      const orphanIds = orphans
        .filter((o) => !claudeTranscriptExists(o.worktree_path, o.claude_session_id))
        .map((o) => o.id);
      if (orphanIds.length > 0) {
        const ph = orphanIds.map(() => '?').join(',');
        getDatabase()
          .prepare(
            `UPDATE sessions
                SET claude_session_id = NULL, status = 'done'
              WHERE id IN (${ph})`
          )
          .run(...orphanIds);
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
    // 30-minute window catches typical "quit then restart" cycles.
    // Older sessions are treated as "the user let them die" and stay
    // ended. Override for tests; reconciled IDs were a 1:1 list of
    // sessions we KNOW were live at quit time, but we no longer scope
    // by them because shell sessions that ended cleanly via SIGTERM
    // get their markExited written to DB BEFORE app close — so they're
    // already 'done' at next boot and reconcile doesn't see them.
    const maxAge = opts.maxAgeMs ?? 30 * 60 * 1000;
    const limit = opts.limit ?? 10;
    const now = Date.now();
    let rows: {
      id: string;
      backend_id: string;
      claude_session_id: string | null;
      worktree_path: string;
      status: string;
    }[];
    try {
      // Include shell sessions (which have no claude_session_id by
      // design) so the user's terminals reappear after restart with a
      // fresh shell. Claude sessions still need a claude_session_id
      // to attempt --resume — otherwise we just fall through to the
      // respawn branch below.
      if (opts.candidateIds && opts.candidateIds.length > 0) {
        const placeholders = opts.candidateIds.map(() => '?').join(',');
        rows = getDatabase()
          .prepare(
            `SELECT id, backend_id, claude_session_id, worktree_path, status
               FROM sessions
              WHERE id IN (${placeholders})
                AND ended_at > ?
              ORDER BY ended_at DESC
              LIMIT ?`
          )
          .all(...opts.candidateIds, now - maxAge, limit) as never;
      } else {
        rows = getDatabase()
          .prepare(
            `SELECT id, backend_id, claude_session_id, worktree_path, status
               FROM sessions
              WHERE status IN ('done', 'errored')
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
      // Shell sessions have nothing to restore — just respawn a fresh
      // pty at the same cwd. Same for Claude sessions whose transcript
      // is gone (the conversation can't be reloaded).
      const shellSession = r.backend_id === 'shell';
      const needsRespawn =
        shellSession ||
        !r.claude_session_id ||
        !claudeTranscriptExists(r.worktree_path, r.claude_session_id);
      if (needsRespawn) {
        try {
          await this.respawn(r.id);
        } catch (err) {
          // Respawn can still legitimately fail (e.g. worktree was
          // deleted out from under us). Fall back to the old behaviour:
          // clear the dead id and mark the row done so the renderer
          // shows a recoverable "Session ended" placeholder.
          // eslint-disable-next-line no-console
          console.warn(`[baton] auto-respawn of ${r.id} failed:`, err);
          try {
            getDatabase()
              .prepare(
                `UPDATE sessions SET claude_session_id = NULL, status = 'done' WHERE id = ?`
              )
              .run(r.id);
          } catch { /* best-effort */ }
          const prev = r.status as SessionStatus;
          if (prev !== 'done') {
            emit({
              type: 'session.status_changed',
              sessionId: r.id,
              from: prev,
              to: 'done',
            });
          }
          const fresh = this.listAll().find((s) => s.id === r.id);
          if (fresh) emit({ type: 'session.refreshed', session: fresh });
        }
        continue;
      }

      try {
        await this.resume(r.id);
      } catch (err) {
        // Resume can fail for legitimate reasons (Claude's transcript
        // was deleted, --resume rejects the id, etc.). Don't let one
        // bad row stop the rest.
        // eslint-disable-next-line no-console
        console.warn(`[baton] auto-resume of ${r.id} failed:`, err);
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
                claude_session_id, skip_permissions, snoozed_at
           FROM sessions
          ORDER BY display_order ASC, started_at ASC`
      )
      .all() as {
        id: string; project_id: string; backend_id: string;
        branch: string; worktree_path: string; status: string;
        started_at: number; ended_at: number | null;
        tokens_in: number; tokens_out: number; last_summary: string | null;
        claude_session_id: string | null;
        skip_permissions: number;
        snoozed_at: number | null;
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
        skipPermissions: r.skip_permissions === 1,
        snoozedAt: r.snoozed_at,
      };
    });
  }

  async spawn(opts: {
    projectId: string;
    backendId: AgentBackendId;
    /** Either the project root (shared workspace) OR a worktree
     *  path. Set via `newWorktreeBranch` below for the worktree path. */
    cwd: string;
    /** When set, reuse this baton session row (the user clicked
     *  "Resume" on an ended row) instead of inserting a fresh one. */
    reuseSessionId?: string;
    /** When set, spawn Claude with `--resume <id>`. */
    resumeClaudeSessionId?: string;
    /** When set, create a new git worktree at this branch FIRST,
     *  then spawn the agent inside it. The session's `cwd` will be
     *  the new worktree path, not the project root. */
    newWorktreeBranch?: string;
    /** When true, launch Claude with --dangerously-skip-permissions.
     *  Defaults to false. */
    skipPermissions?: boolean;
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

      // If the caller asked for a fresh worktree, create it before
      // anything else and redirect cwd into it. Branch + cwd for the
      // session will reflect the worktree, not the project root.
      let cwd = opts.cwd;
      if (opts.newWorktreeBranch) {
        const wt = await createWorktree({
          projectId: opts.projectId,
          projectRoot: opts.cwd,
          branchName: opts.newWorktreeBranch,
        });
        cwd = wt.path;

        // Per PRD F1.4: run the project's optional setup hook so the
        // new worktree has its deps / env prepared before the agent
        // touches anything. We block spawn until the script finishes
        // so the user sees a clear error if it fails, rather than
        // Claude landing in a half-initialised tree.
        const setup = await runSetupScript({
          projectRoot: opts.cwd,
          worktreePath: cwd,
          branch: opts.newWorktreeBranch,
        });
        if (setup.ran && setup.exitCode !== 0) {
          throw new Error(
            `Setup script failed (${setup.scriptPath}, exit ${setup.exitCode}):\n` +
            (setup.stderr || setup.stdout || '<no output>')
          );
        }
      }

      // Read git metadata BEFORE the pty is spawned. If we did this
      // after spawn, there'd be a window where Claude is alive (and
      // could fire SessionStart) but `this.live` doesn't yet contain
      // the session — the hook would silently no-op.
      const branch = (await readCurrentBranch(cwd)) ?? 'no git';

      const skipPermissions = opts.skipPermissions ?? false;
      const spawnOpts: {
        sessionId: string;
        cwd: string;
        cols: number;
        rows: number;
        resumeClaudeSessionId?: string;
        skipPermissions?: boolean;
      } = {
        sessionId,
        cwd,
        cols: 100,
        rows: 32,
      };
      if (opts.resumeClaudeSessionId) {
        spawnOpts.resumeClaudeSessionId = opts.resumeClaudeSessionId;
      }
      if (skipPermissions) spawnOpts.skipPermissions = true;
      const handle = await (backend as { spawn: (o: typeof spawnOpts) => Promise<AgentHandle> }).spawn(spawnOpts);

      // When reusing an existing row (resume / respawn / auto-resume on
      // restart), seed the in-memory meta from the persisted DB row
      // for fields that should survive across runs but aren't re-emitted
      // on spawn: lastSummary, tokensIn, tokensOut. The DB row's
      // last_summary is NOT touched by the upsert below, so it's the
      // authoritative source; without this seeding, listAll() would
      // return live.meta with `lastSummary: null` and the chip would
      // lose the intent label between restarts.
      let savedSummary: string | null = null;
      let savedTokensIn = 0;
      let savedTokensOut = 0;
      let savedSnoozedAt: number | null = null;
      if (opts.reuseSessionId) {
        try {
          const prev = getDatabase()
            .prepare('SELECT last_summary, tokens_in, tokens_out, snoozed_at FROM sessions WHERE id = ?')
            .get(opts.reuseSessionId) as
            | { last_summary: string | null; tokens_in: number; tokens_out: number; snoozed_at: number | null }
            | undefined;
          if (prev) {
            savedSummary = prev.last_summary;
            savedTokensIn = prev.tokens_in ?? 0;
            savedTokensOut = prev.tokens_out ?? 0;
            savedSnoozedAt = prev.snoozed_at;
          }
        } catch { /* best-effort */ }
      }

      const session: Session = {
        id: sessionId,
        projectId: opts.projectId,
        backendId: opts.backendId,
        branch,
        worktreePath: cwd,
        status: 'running',
        startedAt: Date.now(),
        endedAt: null,
        tokensIn: savedTokensIn,
        tokensOut: savedTokensOut,
        lastSummary: savedSummary,
        claudeSessionId: opts.resumeClaudeSessionId ?? null,
        skipPermissions,
        snoozedAt: savedSnoozedAt,
      };

      // Make the session visible to the hook handler IMMEDIATELY,
      // before any IO that could race against SessionStart firing.
      this.live.set(sessionId, {
        meta: session,
        handle,
        lastIdleAt: null,
        recentPtyBytes: Buffer.alloc(0),
      });

      // Insert OR revive (resume): on conflict, restore the row.
      // We also update skip_permissions on conflict because the user
      // may have flipped YOLO mode between runs.
      getDatabase()
        .prepare(
          `INSERT INTO sessions (id, project_id, backend_id, branch, worktree_path, status, started_at, ended_at, tokens_in, tokens_out, last_summary, claude_session_id, skip_permissions)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             status           = excluded.status,
             ended_at         = NULL,
             worktree_path    = excluded.worktree_path,
             skip_permissions = excluded.skip_permissions`
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
          session.claudeSessionId,
          session.skipPermissions ? 1 : 0
        );

      // Wire pty → renderer via the dedicated pty.data channel.
      handle.onData((chunk) => {
        // Stash a copy in the recent-bytes ring so a TerminalPane that
        // mounts AFTER pty data started flowing (very common for shell
        // sessions, whose prompt is printed in ms) can still replay
        // the initial state via scrollback.load.
        const live = this.live.get(sessionId);
        if (live) {
          live.recentPtyBytes = Buffer.concat([live.recentPtyBytes, chunk]);
          if (live.recentPtyBytes.length > RECENT_PTY_CAP) {
            live.recentPtyBytes = live.recentPtyBytes.subarray(
              live.recentPtyBytes.length - RECENT_PTY_CAP
            );
          }
        }
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

      trace('SPAWN', {
        sid: shortSid(session.id),
        backend: session.backendId,
        reuse: !!opts.reuseSessionId,
        resumeClaude: !!opts.resumeClaudeSessionId,
      });
      emit({ type: 'session.spawned', session });
      return session;
    });
  }

  write(sessionId: string, data: string): void {
    const live = this.live.get(sessionId);
    if (!live) throw new Error(`session not live: ${sessionId}`);
    // Auto-resume from idle-pause: any user input means the user is
    // back. SIGCONT + flip status BEFORE we write so Claude actually
    // sees the bytes when it wakes up (PRD F11.4).
    if (live.meta.status === 'paused') {
      try { live.handle.resume(); } catch { /* best-effort */ }
      this.setStatus(sessionId, 'idle', 'write:auto-resume');
    }
    live.handle.write(data);
    // Shell sessions don't get Claude's UserPromptSubmit/Stop hooks,
    // so we treat a CR/LF in the user's input as a command boundary
    // and fire the terminal summariser. Small delay so the command's
    // own output has time to land in recentPtyBytes before Haiku reads
    // it. Throttled inside summarizeTerminal (90s) — long agent loops
    // or fast `enter`-mashers don't burn tokens.
    if (live.meta.backendId === 'shell' && /[\r\n]/.test(data)) {
      setTimeout(() => {
        void this.updateTerminalSummary(sessionId).catch(() => { /* best-effort */ });
      }, 500);
    }
  }

  resize(sessionId: string, cols: number, rows: number): void {
    const live = this.live.get(sessionId);
    if (!live) return;
    live.handle.resize(cols, rows);
  }

  /**
   * Resume an ended session: re-uses the original baton session id
   * and passes the captured Claude session id to `claude --resume`.
   * The user's prior conversation history is restored by Claude itself.
   */
  async resume(sessionId: string): Promise<Session> {
    const row = getDatabase()
      .prepare(
        `SELECT id, project_id, backend_id, branch, worktree_path,
                claude_session_id, skip_permissions
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
          skip_permissions: number;
        }
      | undefined;
    if (!row) throw new Error(`No such session: ${sessionId}`);
    if (this.live.has(sessionId)) throw new Error(`Already live: ${sessionId}`);
    if (!row.claude_session_id) {
      throw new Error(
        'Cannot resume — no Claude session id was captured for this session.'
      );
    }
    if (!claudeTranscriptExists(row.worktree_path, row.claude_session_id)) {
      // Claude only writes the transcript after the first user
      // prompt. If the session ended before that, there's nothing
      // to resume from — surface a clean message instead of letting
      // claude fail and the chip go red.
      throw new Error(
        'Cannot resume — Claude has no transcript for this session ' +
        '(it likely ended before any user message was sent). ' +
        'Start a new session instead.'
      );
    }
    return this.spawn({
      projectId: row.project_id,
      backendId: row.backend_id as AgentBackendId,
      cwd: row.worktree_path,
      reuseSessionId: row.id,
      resumeClaudeSessionId: row.claude_session_id,
      skipPermissions: row.skip_permissions === 1,
    });
  }

  /**
   * Start a fresh Claude session inside an existing ended session's
   * cwd, reusing the baton session id (so its place in the left
   * column stays put). No `--resume` — prior conversation history is
   * not reloaded. Used when there's nothing to resume (no transcript)
   * but the user still wants to pick up work in the same worktree.
   */
  async respawn(sessionId: string): Promise<Session> {
    const row = getDatabase()
      .prepare(
        `SELECT id, project_id, backend_id, worktree_path, skip_permissions
           FROM sessions WHERE id = ?`
      )
      .get(sessionId) as
      | {
          id: string; project_id: string; backend_id: string;
          worktree_path: string; skip_permissions: number;
        }
      | undefined;
    if (!row) throw new Error(`No such session: ${sessionId}`);
    if (this.live.has(sessionId)) throw new Error(`Already live: ${sessionId}`);
    return this.spawn({
      projectId: row.project_id,
      backendId: row.backend_id as AgentBackendId,
      cwd: row.worktree_path,
      skipPermissions: row.skip_permissions === 1,
      reuseSessionId: row.id,
    });
  }

  /**
   * Flip the session's skipPermissions flag and restart Claude with
   * the new value (using `--resume` so the conversation history
   * survives). If the session is currently live we kill it first.
   *
   * Falls back gracefully if there's no captured claude_session_id —
   * just respawns without --resume (i.e. starts a fresh conversation
   * in the same worktree).
   */
  async toggleYolo(sessionId: string): Promise<Session> {
    const row = getDatabase()
      .prepare(
        `SELECT id, project_id, backend_id, worktree_path,
                claude_session_id, skip_permissions
           FROM sessions WHERE id = ?`
      )
      .get(sessionId) as
      | {
          id: string; project_id: string; backend_id: string;
          worktree_path: string; claude_session_id: string | null;
          skip_permissions: number;
        }
      | undefined;
    if (!row) throw new Error(`No such session: ${sessionId}`);

    const next = row.skip_permissions === 1 ? false : true;
    // Persist BEFORE the kill so a crash mid-toggle still leaves the
    // intended state in the DB.
    try {
      getDatabase()
        .prepare('UPDATE sessions SET skip_permissions = ? WHERE id = ?')
        .run(next ? 1 : 0, sessionId);
    } catch { /* best-effort */ }

    // Kill any live pty so we can re-spawn with the new flag. We mark
    // it as an intentional kill so markExited doesn't briefly emit
    // 'errored' between the kill and the new spawn — the chip stays
    // on its current status until the new pty's SessionStart hook
    // flips it to 'idle'.
    const wasLive = this.live.has(sessionId);
    if (wasLive) {
      this.intentionalKills.add(sessionId);
      try { this.live.get(sessionId)?.handle.kill('SIGTERM'); }
      catch { /* already gone */ }
      await new Promise<void>((resolve) => setTimeout(resolve, 600));
      // If the exit handler hasn't fired yet, force-clear so spawn
      // doesn't refuse with "Already live".
      this.live.delete(sessionId);
    }

    const useResume =
      !!row.claude_session_id &&
      claudeTranscriptExists(row.worktree_path, row.claude_session_id);

    return this.spawn({
      projectId: row.project_id,
      backendId: row.backend_id as AgentBackendId,
      cwd: row.worktree_path,
      reuseSessionId: row.id,
      skipPermissions: next,
      ...(useResume && row.claude_session_id
        ? { resumeClaudeSessionId: row.claude_session_id }
        : {}),
    });
  }

  async kill(sessionId: string): Promise<void> {
    return this.queue.run(sessionId, async () => {
      const live = this.live.get(sessionId);
      if (!live) return;
      live.handle.kill('SIGTERM');
    });
  }

  /**
   * Rename a worktree session's branch + move its dir to match.
   * Refuses for live sessions (files would shift while Claude is
   * holding them) and for project-root sessions (renaming the
   * project's main branch would surprise every other session
   * sharing it). Emits `session.renamed` so the renderer's chip
   * label updates without a full reload.
   */
  async rename(sessionId: string, newBranchName: string): Promise<Session> {
    return this.queue.run(sessionId, async () => {
      if (this.live.has(sessionId)) {
        throw new Error(
          'Stop this session before renaming — files in the worktree are in use.'
        );
      }
      const row = getDatabase()
        .prepare(
          `SELECT id, project_id, backend_id, branch, worktree_path, status,
                  started_at, ended_at, tokens_in, tokens_out, last_summary,
                  claude_session_id, skip_permissions, snoozed_at
             FROM sessions WHERE id = ?`
        )
        .get(sessionId) as
        | {
            id: string; project_id: string; backend_id: string;
            branch: string; worktree_path: string; status: string;
            started_at: number; ended_at: number | null;
            tokens_in: number; tokens_out: number;
            last_summary: string | null; claude_session_id: string | null;
            skip_permissions: number;
            snoozed_at: number | null;
          }
        | undefined;
      if (!row) throw new Error(`No such session: ${sessionId}`);

      const project = getProject(row.project_id);
      const isWorktreeSession =
        !!project &&
        row.worktree_path !== project.path &&
        row.worktree_path.startsWith(project.path);
      if (!project || !isWorktreeSession) {
        throw new Error(
          'Rename only applies to worktree sessions. Renaming the project root branch would affect every session on this project.'
        );
      }

      const updated = await renameWorktree({
        projectRoot: project.path,
        worktreePath: row.worktree_path,
        newBranchName,
      });

      getDatabase()
        .prepare(
          'UPDATE sessions SET branch = ?, worktree_path = ? WHERE id = ?'
        )
        .run(updated.branch, updated.path, sessionId);

      const next: Session = {
        id: row.id,
        projectId: row.project_id,
        backendId: row.backend_id as Session['backendId'],
        branch: updated.branch,
        worktreePath: updated.path,
        status: row.status as Session['status'],
        startedAt: row.started_at,
        endedAt: row.ended_at,
        tokensIn: row.tokens_in,
        tokensOut: row.tokens_out,
        snoozedAt: row.snoozed_at,
        lastSummary: row.last_summary,
        claudeSessionId: row.claude_session_id,
        skipPermissions: row.skip_permissions === 1,
      };
      emit({
        type: 'session.renamed',
        sessionId,
        newBranch: updated.branch,
        newWorktreePath: updated.path,
      });
      return next;
    });
  }

  /**
   * Hard-delete a session: kill if live, optionally remove its
   * worktree, then DELETE the row from SQLite and emit
   * `session.deleted` so the renderer drops it from view. The
   * conversation transcript Claude saves at
   * `~/.claude/projects/<sanitised>/<claude_session_id>.jsonl` is
   * NOT removed — that's the user's data, in Claude's space. They
   * can clear it from their own `~/.claude/` if they want.
   */
  async delete(
    sessionId: string,
    opts: { removeWorktree?: boolean } = {}
  ): Promise<{ worktreeRemoved: boolean }> {
    return this.queue.run(sessionId, async () => {
      // Snapshot what we need before deleting anything.
      const row = getDatabase()
        .prepare(
          'SELECT project_id, worktree_path FROM sessions WHERE id = ?'
        )
        .get(sessionId) as
        | { project_id: string; worktree_path: string }
        | undefined;
      if (!row) return { worktreeRemoved: false };

      // Kill the pty if it's still running. Wait briefly so the exit
      // handler doesn't race with the row DELETE.
      const live = this.live.get(sessionId);
      if (live) {
        try { live.handle.kill('SIGTERM'); } catch { /* already gone */ }
        await new Promise<void>((resolve) => setTimeout(resolve, 250));
        this.live.delete(sessionId);
      }

      // Auto-detect "this is a worktree session" — the worktree path
      // sits inside the project's .baton/worktrees/. If the caller
      // explicitly set removeWorktree, honor that; otherwise default
      // to true for worktree sessions, false for project-root sessions.
      const project = getProject(row.project_id);
      const isWorktreeSession =
        !!project &&
        row.worktree_path !== project.path &&
        row.worktree_path.startsWith(project.path);
      const shouldRemoveWt = opts.removeWorktree ?? isWorktreeSession;

      let worktreeRemoved = false;
      if (shouldRemoveWt && project && isWorktreeSession) {
        try {
          await removeWorktree(project.path, row.worktree_path);
          worktreeRemoved = true;
        } catch {
          // best-effort — the row still goes away
        }
      }

      // Drop the row and tell the renderer to forget it.
      getDatabase().prepare('DELETE FROM sessions WHERE id = ?').run(sessionId);
      // Best-effort: clean up the per-session scrollback file (F8.8).
      try {
        fs.unlinkSync(path.join(os.homedir(), '.baton', 'scrollback', `${sessionId}.bin`));
      } catch { /* already gone */ }
      emit({ type: 'session.deleted', sessionId });

      return { worktreeRemoved };
    });
  }

  list(): Session[] {
    return [...this.live.values()].map((l) => l.meta);
  }

  /** Snapshot of recent pty bytes for `sessionId`, used by
   *  scrollback.load as a fallback when no disk scrollback exists
   *  yet. Returns null if the session isn't live. */
  getRecentPtyBytes(sessionId: string): Buffer | null {
    return this.live.get(sessionId)?.recentPtyBytes ?? null;
  }

  /** Toggle the per-session snooze flag. `snoozed=true` stamps
   *  snoozed_at = now; `snoozed=false` clears it. The live in-memory
   *  meta is kept in sync so listAll() reflects the change without
   *  needing a full re-fetch. */
  setSnoozed(sessionId: string, snoozed: boolean): Session {
    const value = snoozed ? Date.now() : null;
    const res = getDatabase()
      .prepare('UPDATE sessions SET snoozed_at = ? WHERE id = ?')
      .run(value, sessionId);
    if (res.changes === 0) throw new Error(`No such session: ${sessionId}`);
    const live = this.live.get(sessionId);
    if (live) live.meta = { ...live.meta, snoozedAt: value };
    const session = this.listAll().find((s) => s.id === sessionId);
    if (!session) throw new Error(`Session disappeared after snooze toggle: ${sessionId}`);
    emit({ type: 'session.refreshed', session });
    return session;
  }

  /** Re-stamp display_order for the given sessions in order. The
   *  renderer scopes this per-project, so we don't enforce a single
   *  cross-project sequence. */
  reorderSessions(orderedIds: string[]): void {
    const stmt = getDatabase().prepare(
      'UPDATE sessions SET display_order = ? WHERE id = ?'
    );
    const tx = getDatabase().transaction((ids: string[]) => {
      ids.forEach((id, i) => stmt.run(i, id));
    });
    tx(orderedIds);
    emit({ type: 'session.reordered', orderedIds });
  }

  /**
   * Recompute running token totals for a session from Claude's
   * transcript .jsonl. Idempotent — safe to call any time. Emits
   * `session.tokens_updated` only when the totals actually change.
   * (F11.1: per-session token spend.)
   */
  private updateTokenUsage(sessionId: string): void {
    const live = this.live.get(sessionId);
    const claudeSid = live?.meta.claudeSessionId
      ?? (getDatabase()
            .prepare('SELECT claude_session_id FROM sessions WHERE id = ?')
            .get(sessionId) as { claude_session_id: string | null } | undefined)
              ?.claude_session_id;
    if (!claudeSid) return;
    const cwd = live?.meta.worktreePath
      ?? (getDatabase()
            .prepare('SELECT worktree_path FROM sessions WHERE id = ?')
            .get(sessionId) as { worktree_path: string } | undefined)
              ?.worktree_path;
    if (!cwd) return;

    const transcriptPath = claudeTranscriptPath(cwd, claudeSid);
    const { tokensIn, tokensOut } = readTranscriptUsage(transcriptPath);
    if (tokensIn === 0 && tokensOut === 0) return;

    // Read prior totals once so we don't emit a noisy event when
    // nothing changed (Stop fires more often than usage shifts).
    const prior = getDatabase()
      .prepare('SELECT tokens_in, tokens_out FROM sessions WHERE id = ?')
      .get(sessionId) as { tokens_in: number; tokens_out: number } | undefined;
    if (prior && prior.tokens_in === tokensIn && prior.tokens_out === tokensOut) return;

    try {
      getDatabase()
        .prepare('UPDATE sessions SET tokens_in = ?, tokens_out = ? WHERE id = ?')
        .run(tokensIn, tokensOut, sessionId);
    } catch { /* best-effort */ }
    if (live) live.meta = { ...live.meta, tokensIn, tokensOut };
    emit({
      type: 'session.tokens_updated',
      sessionId,
      tokensIn,
      tokensOut,
    });
  }

  /**
   * Ask Haiku for a short intent summary of the most recent turn and
   * persist it on the session row + emit. Throttled inside
   * intentSummarizer.ts to once per 90s per session. (PRD F4)
   */
  /** For shell sessions: ask Haiku to summarise the terminal's recent
   *  output and persist the result on the session row. Fire-and-forget
   *  caller; throttled inside summarizeTerminal unless `force: true`. */
  async updateTerminalSummary(sessionId: string, opts?: { force?: boolean }): Promise<void> {
    const live = this.live.get(sessionId);
    if (!live) return;
    if (live.meta.backendId !== 'shell') return;
    const recent = live.recentPtyBytes;
    if (recent.length === 0) return;
    const summary = await summarizeTerminal({
      sessionId,
      recentBytes: recent,
      ...(opts?.force ? { force: true } : {}),
      previousSummary: live.meta.lastSummary,
    });
    if (!summary) return;
    try {
      getDatabase()
        .prepare('UPDATE sessions SET last_summary = ? WHERE id = ?')
        .run(summary, sessionId);
    } catch { /* best-effort */ }
    live.meta = { ...live.meta, lastSummary: summary };
    emit({ type: 'session.summarized', sessionId, summary });
  }

  private async updateIntentSummary(sessionId: string, opts?: { force?: boolean }): Promise<void> {
    const live = this.live.get(sessionId);
    const claudeSid = live?.meta.claudeSessionId
      ?? (getDatabase()
            .prepare('SELECT claude_session_id FROM sessions WHERE id = ?')
            .get(sessionId) as { claude_session_id: string | null } | undefined)
              ?.claude_session_id;
    trace('SUMM_START', {
      sid: shortSid(sessionId),
      force: !!opts?.force,
      hasLive: !!live,
      claudeSid: claudeSid ? claudeSid.slice(0, 8) : '∅',
    });
    if (!claudeSid) {
      trace('SUMM_SKIP_NO_CLAUDESID', { sid: shortSid(sessionId) });
      return;
    }
    const cwd = live?.meta.worktreePath
      ?? (getDatabase()
            .prepare('SELECT worktree_path FROM sessions WHERE id = ?')
            .get(sessionId) as { worktree_path: string } | undefined)
              ?.worktree_path;
    if (!cwd) {
      trace('SUMM_SKIP_NO_CWD', { sid: shortSid(sessionId) });
      return;
    }

    const transcriptPath = claudeTranscriptPath(cwd, claudeSid);
    const previousSummary = live?.meta.lastSummary
      ?? ((getDatabase()
            .prepare('SELECT last_summary FROM sessions WHERE id = ?')
            .get(sessionId) as { last_summary: string | null } | undefined)
              ?.last_summary
          ?? null);
    const summary = await summarizeSession({
      sessionId,
      transcriptPath,
      previousSummary,
      ...(opts?.force ? { force: true } : {}),
    });
    if (!summary) {
      trace('SUMM_RESULT_NULL', { sid: shortSid(sessionId) });
      return;
    }

    try {
      getDatabase()
        .prepare('UPDATE sessions SET last_summary = ? WHERE id = ?')
        .run(summary, sessionId);
    } catch (err) {
      trace('SUMM_DB_ERR', {
        sid: shortSid(sessionId),
        err: String(err).slice(0, 80).replace(/\s+/g, '_'),
      });
    }
    if (live) live.meta = { ...live.meta, lastSummary: summary };
    const t0 = this.promptSubmittedAt.get(sessionId);
    trace('SUMM_EMIT', {
      sid: shortSid(sessionId),
      summary: summary.slice(0, 40).replace(/\s+/g, '_'),
      sincePromptMs: t0 ? Date.now() - t0 : -1,
    });
    emit({ type: 'session.summarized', sessionId, summary });
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

  /** Apply a status transition, persist, and emit if it changed.
   *  `reason` is a short tag (e.g. `hook:Stop`, `sweep:idle-pause`)
   *  logged to ~/.baton/logs/status-trace.log for debugging stuck
   *  chips — every transition documents WHY it happened. */
  private setStatus(sessionId: string, next: SessionStatus, reason = 'unknown'): void {
    const live = this.live.get(sessionId);
    if (!live) {
      trace('SET_STATUS_NO_LIVE', { sid: shortSid(sessionId), to: next, reason });
      return;
    }
    const prev = live.meta.status;
    if (prev === next) {
      trace('SET_STATUS_NOOP', {
        sid: shortSid(sessionId), status: prev, reason,
      });
      return;
    }
    const t0 = this.promptSubmittedAt.get(sessionId);
    trace('SET_STATUS', {
      sid: shortSid(sessionId), from: prev, to: next, reason,
      sincePromptMs: t0 ? Date.now() - t0 : -1,
    });
    live.meta = { ...live.meta, status: next };
    // Track when we entered 'idle' so the sweeper can decide who's
    // been quiet too long. Clear on any other transition so a session
    // that briefly went idle and then started working again gets a
    // fresh clock.
    live.lastIdleAt = next === 'idle' ? Date.now() : null;
    try {
      getDatabase()
        .prepare('UPDATE sessions SET status = ? WHERE id = ?')
        .run(next, sessionId);
    } catch (err) {
      trace('SET_STATUS_DB_ERR', {
        sid: shortSid(sessionId),
        err: String(err).slice(0, 80).replace(/\s+/g, '_'),
      });
      // fail-open on persistence — never block the agent
    }
    emit({
      type: 'session.status_changed',
      sessionId,
      from: prev,
      to: next,
    });
  }

  /** Scan live sessions and SIGSTOP any that have been idle longer
   *  than the threshold. Pairs with resume-on-write so the user
   *  doesn't notice the pause unless they look at the chip. */
  private sweepIdleSessions(): void {
    const now = Date.now();
    let liveCount = 0;
    let idleCount = 0;
    let runningCount = 0;
    for (const [sid, live] of this.live) {
      liveCount++;
      if (live.meta.status === 'running') runningCount++;
      if (live.meta.status !== 'idle') continue;
      idleCount++;
      if (live.lastIdleAt == null) continue;
      const idleFor = now - live.lastIdleAt;
      if (idleFor < IDLE_PAUSE_AFTER_MS) continue;
      try { live.handle.pause(); } catch { /* best-effort */ }
      trace('IDLE_PAUSED', { sid: shortSid(sid), idleForMs: idleFor });
      this.setStatus(sid, 'paused', 'sweep:idle-pause');
    }
    trace('IDLE_SWEEP', {
      liveCount, idleCount, runningCount,
    });
  }

  private idleSweeperHandle: NodeJS.Timeout | null = null;
  private startIdleSweeper(): void {
    if (this.idleSweeperHandle) return;
    this.idleSweeperHandle = setInterval(
      () => this.sweepIdleSessions(),
      IDLE_SWEEP_INTERVAL_MS
    );
  }

  private markExited(sessionId: string, exitCode: number | null): void {
    const live = this.live.get(sessionId);
    if (!live) {
      trace('EXIT_NO_LIVE', { sid: shortSid(sessionId), exitCode });
      return;
    }
    trace('EXIT', {
      sid: shortSid(sessionId),
      exitCode,
      prevStatus: live.meta.status,
    });

    // Planned kills (YOLO toggle, etc.) skip every event + DB write —
    // the caller is about to immediately respawn the same row, so the
    // renderer should never see this transient exit.
    if (this.intentionalKills.delete(sessionId)) {
      trace('EXIT_INTENTIONAL', { sid: shortSid(sessionId) });
      this.live.delete(sessionId);
      return;
    }

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
      const curStatus = live ? live.meta.status : null;
      trace('HOOK_DISPATCH', {
        sid: shortSid(event.sessionId),
        event: event.event,
        curStatus: curStatus ?? '∅',
        hasLive: !!live,
      });

      // SessionStart is special: Claude can fire it during the tiny
      // window between `pty.spawn` returning and `this.live.set(...)`,
      // i.e. before the live entry exists. We MUST still persist the
      // claude_session_id to the DB or the session can't be resumed
      // after a restart. recordClaudeSessionId writes to DB
      // unconditionally; only the live.meta update + setStatus depend
      // on the in-memory entry.
      if (event.event === 'SessionStart') {
        const body = event.body as { session_id?: string } | undefined;
        const claudeSid = body?.session_id;
        if (claudeSid) this.recordClaudeSessionId(event.sessionId, claudeSid);
        if (live) this.setStatus(event.sessionId, 'idle', 'hook:SessionStart');
        return {};
      }

      if (!live) {
        trace('HOOK_NO_LIVE', { sid: shortSid(event.sessionId), event: event.event });
        return {};
      }

      switch (event.event) {

        case 'UserPromptSubmit': {
          // User hit enter on a prompt — Claude is about to (or already
          // is) generating a response. This is the only signal that
          // works for pure-text responses, where no PreToolUse fires.
          const t0 = Date.now();
          this.promptSubmittedAt.set(event.sessionId, t0);
          trace('USER_PROMPT', { sid: shortSid(event.sessionId), t0 });
          // Talking to a session implicitly un-snoozes it: the user is
          // clearly engaged with this work again, so the chip should
          // become visible. No-op if not snoozed.
          if (live.meta.snoozedAt != null) {
            trace('AUTO_UNSNOOZE', { sid: shortSid(event.sessionId) });
            try { this.setSnoozed(event.sessionId, false); }
            catch { /* best-effort */ }
          }
          // Same logic at the project level: if the parent project is
          // snoozed, the user is engaging with it again, so move it back
          // to the Active tab.
          try {
            const project = getProject(live.meta.projectId);
            if (project?.snoozedAt != null) {
              trace('AUTO_UNSNOOZE_PROJECT', {
                sid: shortSid(event.sessionId),
                projectId: project.id.slice(0, 8),
              });
              setProjectSnoozed(project.id, false);
            }
          } catch { /* best-effort */ }
          this.setStatus(event.sessionId, 'running', 'hook:UserPromptSubmit');
          // Refresh the intent summary right away so the left-column
          // chip reflects what the user JUST asked, not what they were
          // working on five minutes ago. Force-bypass the throttle —
          // user-initiated triggers should always run. Small delay so
          // Claude has flushed the prompt line into the transcript.
          setTimeout(() => {
            void this.updateIntentSummary(event.sessionId, { force: true });
          }, 300);
          break;
        }

        case 'PreToolUse':
          // Claude is actively working — only flip status if we're
          // currently idle (i.e. between turns) so we don't churn
          // the chip on every tool call inside one turn.
          if (live.meta.status === 'idle' || live.meta.status === 'needs-input') {
            this.setStatus(event.sessionId, 'running', 'hook:PreToolUse');
          } else {
            trace('HOOK_NOOP', {
              sid: shortSid(event.sessionId),
              event: 'PreToolUse',
              reason: `curStatus=${live.meta.status}`,
            });
          }
          break;

        case 'Notification':
          this.setStatus(event.sessionId, 'needs-input', 'hook:Notification');
          break;

        case 'Stop':
          this.setStatus(event.sessionId, 'idle', 'hook:Stop');
          // Claude just finished a turn — the transcript line for the
          // assistant message includes a `usage` object. Recompute the
          // running totals so the chip shows the new spend (F11.1).
          // There can be a tiny lag between Stop firing and Claude
          // flushing the line; a 250ms delay catches the common case
          // without making the UI feel slow.
          setTimeout(() => {
            this.updateTokenUsage(event.sessionId);
            // PRD F4: at the same time, fire off a Haiku summariser
            // so the left-column chip can read "Refactoring auth"
            // instead of an opaque branch id. Fire-and-forget — the
            // hook never waits on it.
            void this.updateIntentSummary(event.sessionId);
          }, 250);
          break;

        case 'SessionEnd':
          // pty exit will follow; treat as done preemptively.
          this.setStatus(event.sessionId, 'done', 'hook:SessionEnd');
          // One last token sweep so the final total is right even if
          // the session ends without a trailing Stop.
          this.updateTokenUsage(event.sessionId);
          break;
      }
    } catch (err) {
      trace('HOOK_HANDLER_ERR', {
        sid: shortSid(event.sessionId),
        event: event.event,
        err: String(err).slice(0, 80).replace(/\s+/g, '_'),
      });
      // Never throw out to Claude.
    }
    return {};
  }

  killAll(): void {
    if (this.idleSweeperHandle) {
      clearInterval(this.idleSweeperHandle);
      this.idleSweeperHandle = null;
    }
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
