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
  type PermissionMode,
  type Session,
  type SessionStatus,
} from '../../shared/ipc.js';
import { getDatabase } from '../database/index.js';
import { batonHome } from '../paths.js';
import type { AgentBackend, AgentHandle } from './agentBackend.js';
import { ClaudeCodeBackend } from './claudeCodeBackend.js';
import { CodexBackend } from './codexBackend.js';
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
import { getFsForProject } from './fs/registry.js';
import { trace, shortSid } from './statusTrace.js';
import { readTranscriptUsage } from './transcriptReader.js';
import { runSetupScript } from './setupScript.js';
import { summarizeSession, summarizeTerminal } from './intentSummarizer.js';
import {
  codexTranscriptExists,
  findCodexTranscript,
} from './codexTranscriptReader.js';

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

/** Default claude --model when the caller doesn't pin one. Persisted
 *  on the row so the chip always reflects what's actually running.
 *  Keep this in sync with DEFAULT_CLAUDE_MODEL in MiddleColumn.tsx. */
const DEFAULT_CLAUDE_MODEL = 'claude-opus-4-8';

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

/** Where to land a freshly-minted Codex transcript when cloning.
 *  Mirrors Codex's own `rollout-<isoTs>-<sessionId>.jsonl` shape inside
 *  today's `~/.codex/sessions/YYYY/MM/DD` bucket so `findCodexTranscript`
 *  picks it up on the next resume. */
function newCodexTranscriptPath(newSessionId: string): string {
  const root = process.env['CODEX_HOME']
    ? path.join(process.env['CODEX_HOME'] as string, 'sessions')
    : path.join(os.homedir(), '.codex', 'sessions');
  const d = new Date();
  const yyyy = String(d.getUTCFullYear());
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mi = String(d.getUTCMinutes()).padStart(2, '0');
  const ss = String(d.getUTCSeconds()).padStart(2, '0');
  const ts = `${yyyy}-${mm}-${dd}T${hh}-${mi}-${ss}`;
  return path.join(root, yyyy, mm, dd, `rollout-${ts}-${newSessionId}.jsonl`);
}

/** True when the session's project lives on this Mac (local fs). For
 *  remote-pinned projects we can't easily check the transcript from
 *  here — it lives on the remote host under that user's `~/.claude`.
 *  Callers gate the local transcript probe on this so remote sessions
 *  aren't mis-classified as "no transcript" and force-respawned. */
function isLocalSessionProject(projectId: string): boolean {
  try {
    const p = getProject(projectId);
    return !p || p.connectionId === 'local';
  } catch {
    return true;
  }
}

/** Async transcript-existence probe that works for both local and
 *  remote projects. Local: `fs.existsSync` on the Mac path. Remote:
 *  SSH-resolve the remote `$HOME` once, then `[ -f <path> ]`.
 *
 *  Critical for auto-resume: a stale `claude_session_id` (captured
 *  from a previous SessionStart hook before the pty died) points at
 *  a transcript file that may never have been written. Without this
 *  check, `claude --resume <id>` would fail every time on restart
 *  and the session would loop in 'errored'. */
async function transcriptExistsFor(
  projectId: string,
  cwd: string,
  claudeSessionId: string,
): Promise<boolean> {
  try {
    const project = getProject(projectId);
    if (!project || project.connectionId === 'local') {
      return claudeTranscriptExists(cwd, claudeSessionId);
    }
    const batonFs = getFsForProject(projectId);
    // Resolve the remote $HOME so we can construct the same path
    // shape Claude uses. We hit the master so this is cheap once
    // it's warm.
    const homeRes = await batonFs.exec('bash', ['-lc', 'echo "$HOME"'], {
      cwd: '/',
      timeoutMs: 5000,
    });
    if (homeRes.code !== 0) return false;
    const remoteHome = homeRes.stdout.trim();
    if (!remoteHome) return false;
    // Same sanitization Claude itself does (slash, dot, underscore → dash).
    const sanitized = cwd.replace(/[/._]/g, '-');
    const transcriptPath =
      `${remoteHome}/.claude/projects/${sanitized}/${claudeSessionId}.jsonl`;
    return await batonFs.exists(transcriptPath);
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
      'codex':       new CodexBackend(),
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
      // Errored agent rows whose transcript is gone on disk — left
      // over from a failed auto-resume (typically a worktree session
      // that was never used before being closed, so the agent never
      // wrote a transcript). Clear the dead id and flip back to done
      // so the chip stops shouting "error" and we don't try resuming
      // again on the next boot. Per-backend transcript layout:
      //   claude-code → ~/.claude/projects/<slug>/<id>.jsonl
      //   codex       → ~/.codex/sessions/YYYY/MM/DD/rollout-*-<id>.jsonl
      const orphans = getDatabase()
        .prepare(
          `SELECT id, project_id, claude_session_id, worktree_path, backend_id
             FROM sessions
            WHERE status = 'errored'
              AND claude_session_id IS NOT NULL
              AND backend_id IN ('claude-code', 'codex')`
        )
        .all() as {
          id: string;
          project_id: string;
          claude_session_id: string;
          worktree_path: string;
          backend_id: string;
        }[];
      // Remote sessions get a pass here: their transcript lives on the
      // remote host and we can't probe it from the Mac without paying
      // an SSH round-trip per row. Trust the captured claude_session_id
      // and let `claude --resume` decide. If the transcript really is
      // gone, claude exits non-zero and the session stays "errored" —
      // exactly where it was.
      const orphanIds = orphans
        .filter((o) => {
          // Remote projects: skip orphan sweep — transcript lives on
          // the remote host and we can't probe it from here without an
          // SSH round-trip per row. Stays errored, exactly where it was.
          if (!isLocalSessionProject(o.project_id)) return false;
          return o.backend_id === 'codex'
            ? !codexTranscriptExists(o.claude_session_id)
            : !claudeTranscriptExists(o.worktree_path, o.claude_session_id);
        })
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

  /** Read the ids that `autoResumeRecent` would pick at boot, without
   *  actually spawning anything. The IPC `session.list` handler returns
   *  this list so the renderer can flip rows to "Starting…" atomically
   *  with loading them, avoiding the flash of stale chips before the
   *  per-session `session.starting` events arrive. */
  autoResumeCandidateIds(maxAgeMs: number = 30 * 24 * 60 * 60 * 1000, limit: number = 30): string[] {
    try {
      const now = Date.now();
      const rows = getDatabase()
        .prepare(
          `SELECT s.id
             FROM sessions s
             JOIN projects p ON p.id = s.project_id
            WHERE s.status IN ('done', 'errored')
              AND s.ended_at > ?
              AND p.snoozed_at IS NULL
            ORDER BY s.ended_at DESC
            LIMIT ?`
        )
        .all(now - maxAgeMs, limit) as { id: string }[];
      return rows.map((r) => r.id);
    } catch {
      return [];
    }
  }

  /**
   * Auto-resume sessions that the app didn't gracefully close. Called
   * once after the window finishes loading so the renderer is
   * subscribed to events.
   *
   * Window: 30 days (was 30 min). The old window left long-tail
   * sessions stranded — user closes the app for the weekend, comes
   * back Monday, has to click every row to bring sessions up. With
   * 30 days, "every session the user has been touching" comes back
   * automatically. Snoozed projects are skipped (snooze acts as the
   * user's opt-out from auto-resume), and the limit is bumped to
   * 30 so users with many parallel agents still see them all.
   */
  async autoResumeRecent(opts: {
    candidateIds?: string[];
    maxAgeMs?: number;
    limit?: number;
  } = {}): Promise<void> {
    const maxAge = opts.maxAgeMs ?? 30 * 24 * 60 * 60 * 1000;
    const limit = opts.limit ?? 30;
    const now = Date.now();
    let rows: {
      id: string;
      project_id: string;
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
            `SELECT id, project_id, backend_id, claude_session_id, worktree_path, status
               FROM sessions
              WHERE id IN (${placeholders})
                AND ended_at > ?
              ORDER BY ended_at DESC
              LIMIT ?`
          )
          .all(...opts.candidateIds, now - maxAge, limit) as never;
      } else {
        // Skip snoozed projects — snooze is the user's opt-out from
        // background activity, including auto-resume.
        rows = getDatabase()
          .prepare(
            `SELECT s.id, s.project_id, s.backend_id, s.claude_session_id,
                    s.worktree_path, s.status
               FROM sessions s
               JOIN projects p ON p.id = s.project_id
              WHERE s.status IN ('done', 'errored')
                AND s.ended_at > ?
                AND p.snoozed_at IS NULL
              ORDER BY s.ended_at DESC
              LIMIT ?`
          )
          .all(now - maxAge, limit) as never;
      }
    } catch {
      return;
    }

    // Fan out the spawns in parallel. With 30 sessions and sequential
    // 5-10s SSH round-trips, sequential would take 2-3 minutes — long
    // enough that the user sees "everything is starting…" forever.
    // Parallel: bounded by SshConnection's ControlMaster (shared
    // socket, cheap subsequent channels) and node-pty (no shared
    // resource). Per-session `queue.run` lock in spawn() prevents
    // ordering surprises within a single session.
    await Promise.all(rows.map(async (r) => {
      // Shell sessions have nothing to restore — just respawn a fresh
      // pty at the same cwd. Agent sessions try to resume if their
      // transcript still exists on disk (Claude under
      // ~/.claude/projects, Codex under ~/.codex/sessions); otherwise
      // fall back to a fresh respawn at the same cwd.
      const shellSession = r.backend_id === 'shell';
      // Probe whether the previous transcript still exists on the
      // right filesystem. For claude-code we use the async helper that
      // SSH-stats remote `~/.claude/projects/…` so remote-pinned
      // sessions don't loop in a resume-fail cycle. Codex transcripts
      // are only checked locally (`~/.codex/sessions/…`); on remote
      // we treat that as "no transcript" and fall through to respawn.
      let hasTranscript = false;
      if (r.claude_session_id) {
        if (r.backend_id === 'claude-code') {
          hasTranscript = await transcriptExistsFor(
            r.project_id, r.worktree_path, r.claude_session_id,
          );
        } else if (r.backend_id === 'codex') {
          hasTranscript =
            isLocalSessionProject(r.project_id) &&
            codexTranscriptExists(r.claude_session_id);
        }
      }
      const needsRespawn = shellSession || !r.claude_session_id || !hasTranscript;
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
        return;
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
    }));
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
                started_at, last_active_at, ended_at, tokens_in, tokens_out, last_summary,
                claude_session_id, permission_mode, model, snoozed_at, parent_session_id
           FROM sessions
          ORDER BY display_order ASC, started_at ASC`
      )
      .all() as {
        id: string; project_id: string; backend_id: string;
        branch: string; worktree_path: string; status: string;
        started_at: number; last_active_at: number | null; ended_at: number | null;
        tokens_in: number; tokens_out: number; last_summary: string | null;
        claude_session_id: string | null;
        permission_mode: string;
        model: string | null;
        snoozed_at: number | null;
        parent_session_id: string | null;
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
        lastActiveAt: r.last_active_at ?? r.started_at,
        endedAt: r.ended_at,
        tokensIn: r.tokens_in,
        tokensOut: r.tokens_out,
        lastSummary: r.last_summary,
        claudeSessionId: r.claude_session_id,
        permissionMode: r.permission_mode as PermissionMode,
        model: r.model,
        snoozedAt: r.snoozed_at,
        parentSessionId: r.parent_session_id,
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
    /** When set, ask the backend to resume a prior agent session by
     *  that backend's own session id. For Claude → `claude --resume
     *  <id>`; for Codex → `codex resume <id>`. Backend-agnostic at
     *  this layer; each backend interprets per its CLI. */
    resumeAgentSessionId?: string;
    /** When set, create a new git worktree at this branch FIRST,
     *  then spawn the agent inside it. The session's `cwd` will be
     *  the new worktree path, not the project root. */
    newWorktreeBranch?: string;
    /** Tool-permission posture passed to the agent via
     *  `--permission-mode`. Defaults to 'default' (ask before each tool). */
    permissionMode?: PermissionMode;
    /** Optional `--model <name>` alias (claude-code only). Null/
     *  undefined → don't pass the flag. */
    model?: string | null;
    /** When set, this is a companion shell terminal attached to the agent
     *  session with this id. Persisted so it survives restarts and stays
     *  grouped under the agent in the middle column. */
    parentSessionId?: string | null;
  }): Promise<Session> {
    await this.startHookServer();

    const backend = this.backends[opts.backendId];
    if (!backend) throw new Error(`Unknown backend: ${opts.backendId}`);

    const sessionId = opts.reuseSessionId ?? randomUUID();
    // Tell the renderer "we're starting this one" the instant we
    // accept the spawn. Without this, the row stays on a stale
    // `done`/`errored` chip for the duration of the SSH round-trip
    // (5–10 s for remote) while the user wonders if anything is
    // happening. session.spawned (success) or session.exited
    // (failure) will clear the marker.
    if (opts.reuseSessionId) {
      emit({ type: 'session.starting', sessionId });
    }
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
      const batonFs = getFsForProject(opts.projectId);
      if (opts.newWorktreeBranch) {
        const wt = await createWorktree({
          projectId: opts.projectId,
          projectRoot: opts.cwd,
          branchName: opts.newWorktreeBranch,
          fs: batonFs,
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
      const branch = (await readCurrentBranch(batonFs, cwd)) ?? 'no git';

      const permissionMode = opts.permissionMode ?? 'default';
      // claude-code sessions default to the newest Opus when the caller
      // doesn't pin a model. We persist the resolved id so the chip
      // always reflects what's actually running and so a future
      // "default" change doesn't silently swap models under live sessions.
      const model = opts.model
        ?? (opts.backendId === 'claude-code' ? DEFAULT_CLAUDE_MODEL : null);
      const spawnOpts: {
        sessionId: string;
        cwd: string;
        cols: number;
        rows: number;
        resumeAgentSessionId?: string;
        permissionMode?: PermissionMode;
        model?: string | null;
        fs?: typeof batonFs;
      } = {
        sessionId,
        cwd,
        cols: 100,
        rows: 32,
        fs: batonFs,
      };
      if (opts.resumeAgentSessionId) {
        spawnOpts.resumeAgentSessionId = opts.resumeAgentSessionId;
      }
      if (permissionMode !== 'default') spawnOpts.permissionMode = permissionMode;
      if (model && opts.backendId === 'claude-code') spawnOpts.model = model;
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
      // Preserve the prior last-activity time across resume/respawn.
      // Reconnecting a session on app launch is NOT user/agent activity
      // — if we re-stamped it to now (like startedAt does), the boot-time
      // auto-resume loop would collapse every session's "active" time
      // onto the same instant. Genuine activity (status→running, tokens,
      // summaries) bumps it forward from here. Null → fresh spawn → now.
      let savedLastActiveAt: number | null = null;
      if (opts.reuseSessionId) {
        try {
          const prev = getDatabase()
            .prepare('SELECT last_summary, tokens_in, tokens_out, snoozed_at, last_active_at FROM sessions WHERE id = ?')
            .get(opts.reuseSessionId) as
            | { last_summary: string | null; tokens_in: number; tokens_out: number; snoozed_at: number | null; last_active_at: number | null }
            | undefined;
          if (prev) {
            savedSummary = prev.last_summary;
            savedTokensIn = prev.tokens_in ?? 0;
            savedTokensOut = prev.tokens_out ?? 0;
            savedSnoozedAt = prev.snoozed_at;
            savedLastActiveAt = prev.last_active_at;
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
        lastActiveAt: savedLastActiveAt ?? Date.now(),
        endedAt: null,
        tokensIn: savedTokensIn,
        tokensOut: savedTokensOut,
        lastSummary: savedSummary,
        claudeSessionId: opts.resumeAgentSessionId ?? null,
        permissionMode,
        model,
        snoozedAt: savedSnoozedAt,
        parentSessionId: opts.parentSessionId ?? null,
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
      // We also update permission_mode on conflict because the user
      // may have changed it between runs.
      getDatabase()
        .prepare(
          `INSERT INTO sessions (id, project_id, backend_id, branch, worktree_path, status, started_at, last_active_at, ended_at, tokens_in, tokens_out, last_summary, claude_session_id, permission_mode, model, parent_session_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             status          = excluded.status,
             ended_at        = NULL,
             worktree_path   = excluded.worktree_path,
             permission_mode = excluded.permission_mode,
             model           = excluded.model`
        )
        .run(
          session.id,
          session.projectId,
          session.backendId,
          session.branch,
          session.worktreePath,
          session.status,
          session.startedAt,
          session.lastActiveAt,
          null,
          0,
          0,
          null,
          session.claudeSessionId,
          session.permissionMode,
          session.model,
          session.parentSessionId
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
          if (win.isDestroyed()) continue;
          const wc = win.webContents;
          if (wc.isDestroyed() || wc.isCrashed()) continue;
          // Even with the guards above, the render frame can be in the
          // middle of being swapped (reload / nav) when pty data arrives.
          // Electron throws "Render frame was disposed before WebFrameMain
          // could be accessed" — harmless, but loud. Swallow it.
          try { wc.send(Channels.ptyData, frame); } catch { /* frame gone */ }
        }
      });

      handle.onExit((exitCode) => {
        this.markExited(sessionId, exitCode);
      });

      trace('SPAWN', {
        sid: shortSid(session.id),
        backend: session.backendId,
        reuse: !!opts.reuseSessionId,
        resumeClaude: !!opts.resumeAgentSessionId,
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
                claude_session_id, permission_mode, model
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
          permission_mode: string;
          model: string | null;
        }
      | undefined;
    if (!row) throw new Error(`No such session: ${sessionId}`);
    if (this.live.has(sessionId)) throw new Error(`Already live: ${sessionId}`);
    if (!row.claude_session_id) {
      throw new Error(
        'Cannot resume — no agent session id was captured for this session.'
      );
    }
    // Pre-flight: the agent only writes its transcript after the
    // first user prompt, so if it's missing the `--resume` (Claude)
    // / `resume <id>` (Codex) call will fail. Catch upstream of
    // pty.spawn so the chip doesn't go red.
    //
    // Claude probe is async so it can SSH-stat the right
    // `~/.claude/projects/…` path on the remote for remote-pinned
    // projects — local stat would false-negative every remote session
    // and loop them forever. Codex transcript probe is sync + local
    // for now (remote codex transcripts not handled until daemon).
    const transcriptOk = row.backend_id === 'codex'
      ? codexTranscriptExists(row.claude_session_id)
      : row.backend_id === 'claude-code'
        ? (await transcriptExistsFor(row.project_id, row.worktree_path, row.claude_session_id))
        : true; // shells / unknown — let the spawn path decide.
    if (!transcriptOk) {
      const label = row.backend_id === 'codex' ? 'Codex' : 'Claude';
      throw new Error(
        `Cannot resume — ${label} has no transcript for this session ` +
        '(it likely ended before any user message was sent). ' +
        'Start a new session instead.'
      );
    }
    return this.spawn({
      projectId: row.project_id,
      backendId: row.backend_id as AgentBackendId,
      cwd: row.worktree_path,
      reuseSessionId: row.id,
      resumeAgentSessionId: row.claude_session_id,
      permissionMode: row.permission_mode as PermissionMode,
      model: row.model,
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
        `SELECT id, project_id, backend_id, worktree_path, permission_mode, model, parent_session_id
           FROM sessions WHERE id = ?`
      )
      .get(sessionId) as
      | {
          id: string; project_id: string; backend_id: string;
          worktree_path: string; permission_mode: string;
          model: string | null;
          parent_session_id: string | null;
        }
      | undefined;
    if (!row) throw new Error(`No such session: ${sessionId}`);
    if (this.live.has(sessionId)) throw new Error(`Already live: ${sessionId}`);
    return this.spawn({
      projectId: row.project_id,
      backendId: row.backend_id as AgentBackendId,
      cwd: row.worktree_path,
      permissionMode: row.permission_mode as PermissionMode,
      model: row.model,
      reuseSessionId: row.id,
      // Keep companion terminals attached to their agent across respawn —
      // otherwise the live meta loses parentSessionId and the row would
      // re-surface as a standalone sidebar session until the next restart.
      parentSessionId: row.parent_session_id,
    });
  }

  /**
   * Fork a claude-code / codex session: copy the on-disk transcript
   * under a fresh agent session id, then spawn a brand new baton
   * session that --resumes from the copy. The original row is
   * untouched, so the user can branch into an alternate timeline
   * without giving up the trunk. Local-fs projects only — remote
   * clone would need an SSH copy of the agent's transcript dir, which
   * we haven't built yet.
   */
  async clone(sessionId: string): Promise<Session> {
    const row = getDatabase()
      .prepare(
        `SELECT id, project_id, backend_id, worktree_path,
                claude_session_id, permission_mode, model
           FROM sessions WHERE id = ?`
      )
      .get(sessionId) as
      | {
          id: string; project_id: string; backend_id: string;
          worktree_path: string; claude_session_id: string | null;
          permission_mode: string; model: string | null;
        }
      | undefined;
    if (!row) throw new Error(`No such session: ${sessionId}`);
    if (row.backend_id !== 'claude-code' && row.backend_id !== 'codex') {
      throw new Error(
        `Cannot clone a ${row.backend_id} session — only claude-code and codex are supported.`
      );
    }
    if (!row.claude_session_id) {
      throw new Error(
        'Cannot clone — no agent session id was captured for this session yet.'
      );
    }
    if (!isLocalSessionProject(row.project_id)) {
      throw new Error(
        'Cannot clone — the source session lives on a remote host, ' +
        'and remote transcript copy is not supported yet.'
      );
    }

    const newAgentId = randomUUID();
    if (row.backend_id === 'claude-code') {
      const src = claudeTranscriptPath(row.worktree_path, row.claude_session_id);
      if (!fs.existsSync(src)) {
        throw new Error(
          'Cannot clone — Claude has no transcript for this session ' +
          '(it likely ended before any user message was sent).'
        );
      }
      const dst = claudeTranscriptPath(row.worktree_path, newAgentId);
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.copyFileSync(src, dst);
    } else {
      const src = findCodexTranscript(row.claude_session_id);
      if (!src) {
        throw new Error(
          'Cannot clone — Codex has no transcript for this session ' +
          '(it likely ended before any user message was sent).'
        );
      }
      // Codex looks up by sessionId regardless of the date folder, so
      // we land the copy in today's bucket: matches how a fresh codex
      // session would name its own file. `findCodexTranscript` walks
      // YYYY/MM/DD back 14 days from "today" — placing the clone in
      // today's folder keeps it discoverable for the longest window.
      const dst = newCodexTranscriptPath(newAgentId);
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.copyFileSync(src, dst);
    }

    return this.spawn({
      projectId: row.project_id,
      backendId: row.backend_id as AgentBackendId,
      cwd: row.worktree_path,
      resumeAgentSessionId: newAgentId,
      permissionMode: row.permission_mode as PermissionMode,
      model: row.model,
    });
  }

  /**
   * Set the session's permission mode and restart the agent with the
   * new `--permission-mode` (using `--resume` so the conversation
   * history survives). If the session is currently live we kill it
   * first.
   *
   * Falls back gracefully if there's no captured claude_session_id —
   * just respawns without --resume (i.e. starts a fresh conversation
   * in the same worktree).
   */
  async setPermissionMode(sessionId: string, mode: PermissionMode): Promise<Session> {
    const row = getDatabase()
      .prepare(
        `SELECT id, project_id, backend_id, worktree_path,
                claude_session_id, model
           FROM sessions WHERE id = ?`
      )
      .get(sessionId) as
      | {
          id: string; project_id: string; backend_id: string;
          worktree_path: string; claude_session_id: string | null;
          model: string | null;
        }
      | undefined;
    if (!row) throw new Error(`No such session: ${sessionId}`);

    // Persist BEFORE the kill so a crash mid-change still leaves the
    // intended state in the DB.
    try {
      getDatabase()
        .prepare('UPDATE sessions SET permission_mode = ? WHERE id = ?')
        .run(mode, sessionId);
    } catch { /* best-effort */ }

    // Kill any live pty so we can re-spawn with the new mode. We mark
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

    // Only attempt --resume if the transcript file actually exists
    // (probed on the right side — local fs for local projects, SSH
    // for remote ones). Falls back to a fresh spawn otherwise so the
    // mode change doesn't get stuck on a stale claude_session_id.
    const useResume =
      !!row.claude_session_id &&
      (await transcriptExistsFor(
        row.project_id, row.worktree_path, row.claude_session_id,
      ));

    return this.spawn({
      projectId: row.project_id,
      backendId: row.backend_id as AgentBackendId,
      cwd: row.worktree_path,
      reuseSessionId: row.id,
      permissionMode: mode,
      model: row.model,
      ...(useResume && row.claude_session_id
        ? { resumeAgentSessionId: row.claude_session_id }
        : {}),
    });
  }

  /**
   * Persist a new model choice for the session and restart it with
   * the new `--model` (using `--resume` so the conversation history
   * survives). `model: null` clears the override so Claude uses the
   * user's configured default. Mirrors setPermissionMode's kill/respawn
   * dance — including the intentionalKills marker so the chip doesn't
   * briefly flash `errored` between the kill and the new spawn.
   */
  async setModel(sessionId: string, model: string | null): Promise<Session> {
    const row = getDatabase()
      .prepare(
        `SELECT id, project_id, backend_id, worktree_path,
                claude_session_id, permission_mode, model
           FROM sessions WHERE id = ?`
      )
      .get(sessionId) as
      | {
          id: string; project_id: string; backend_id: string;
          worktree_path: string; claude_session_id: string | null;
          permission_mode: string;
          model: string | null;
        }
      | undefined;
    if (!row) throw new Error(`No such session: ${sessionId}`);

    // Persist BEFORE the kill so a crash mid-change still leaves the
    // intended state in the DB.
    try {
      getDatabase()
        .prepare('UPDATE sessions SET model = ? WHERE id = ?')
        .run(model, sessionId);
    } catch { /* best-effort */ }

    // No-op when the model didn't actually change AND the session is
    // already in its desired state — just return the persisted row.
    if ((row.model ?? null) === (model ?? null) && !this.live.has(sessionId)) {
      const session = this.listAll().find((s) => s.id === sessionId);
      if (session) return session;
    }

    const wasLive = this.live.has(sessionId);
    if (wasLive) {
      this.intentionalKills.add(sessionId);
      try { this.live.get(sessionId)?.handle.kill('SIGTERM'); }
      catch { /* already gone */ }
      await new Promise<void>((resolve) => setTimeout(resolve, 600));
      this.live.delete(sessionId);
    }

    const useResume =
      !!row.claude_session_id &&
      (await transcriptExistsFor(
        row.project_id, row.worktree_path, row.claude_session_id,
      ));

    return this.spawn({
      projectId: row.project_id,
      backendId: row.backend_id as AgentBackendId,
      cwd: row.worktree_path,
      reuseSessionId: row.id,
      permissionMode: row.permission_mode as PermissionMode,
      model,
      ...(useResume && row.claude_session_id
        ? { resumeAgentSessionId: row.claude_session_id }
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
                  started_at, last_active_at, ended_at, tokens_in, tokens_out, last_summary,
                  claude_session_id, permission_mode, model, snoozed_at, parent_session_id
             FROM sessions WHERE id = ?`
        )
        .get(sessionId) as
        | {
            id: string; project_id: string; backend_id: string;
            branch: string; worktree_path: string; status: string;
            started_at: number; last_active_at: number | null; ended_at: number | null;
            tokens_in: number; tokens_out: number;
            last_summary: string | null; claude_session_id: string | null;
            permission_mode: string;
            model: string | null;
            snoozed_at: number | null;
            parent_session_id: string | null;
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

      const renameFs = getFsForProject(project.id);
      const updated = await renameWorktree({
        projectRoot: project.path,
        worktreePath: row.worktree_path,
        newBranchName,
        fs: renameFs,
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
        lastActiveAt: row.last_active_at ?? row.started_at,
        endedAt: row.ended_at,
        tokensIn: row.tokens_in,
        tokensOut: row.tokens_out,
        snoozedAt: row.snoozed_at,
        lastSummary: row.last_summary,
        claudeSessionId: row.claude_session_id,
        permissionMode: row.permission_mode as PermissionMode,
        model: row.model,
        parentSessionId: row.parent_session_id,
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
          const removeFs = getFsForProject(project.id);
          await removeWorktree(removeFs, project.path, row.worktree_path);
          worktreeRemoved = true;
        } catch {
          // best-effort — the row still goes away
        }
      }

      // Drop the row and tell the renderer to forget it.
      getDatabase().prepare('DELETE FROM sessions WHERE id = ?').run(sessionId);
      // Best-effort: clean up the per-session scrollback file (F8.8).
      try {
        fs.unlinkSync(path.join(batonHome(), 'scrollback', `${sessionId}.bin`));
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
    // Token totals are sourced from Claude's per-turn usage object;
    // Codex's rollout doesn't include a comparable field at the line
    // level, so we skip it for Codex sessions. The chip will show 0
    // tokens — acceptable until we add a Codex usage source.
    const backendId = live?.meta.backendId
      ?? (getDatabase()
            .prepare('SELECT backend_id FROM sessions WHERE id = ?')
            .get(sessionId) as { backend_id: string } | undefined)
              ?.backend_id;
    if (backendId !== 'claude-code') return;
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
    // Fresh token usage means the agent just did work — count it as activity.
    this.bumpActivity(sessionId);
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
    // A refreshed terminal summary is the main activity signal for shell
    // sessions (no tokens, status pinned to 'running') — keep them ranked.
    this.bumpActivity(sessionId);
    emit({ type: 'session.summarized', sessionId, summary });
  }

  private async updateIntentSummary(sessionId: string, opts?: { force?: boolean }): Promise<void> {
    const live = this.live.get(sessionId);
    const dbRow = getDatabase()
      .prepare(
        'SELECT claude_session_id, worktree_path, last_summary, backend_id ' +
        'FROM sessions WHERE id = ?'
      )
      .get(sessionId) as
      | {
          claude_session_id: string | null;
          worktree_path: string;
          last_summary: string | null;
          backend_id: string;
        }
      | undefined;
    const agentSid = live?.meta.claudeSessionId ?? dbRow?.claude_session_id;
    const backendId =
      live?.meta.backendId ?? (dbRow?.backend_id as AgentBackendId | undefined);
    trace('SUMM_START', {
      sid: shortSid(sessionId),
      force: !!opts?.force,
      hasLive: !!live,
      claudeSid: agentSid ? agentSid.slice(0, 8) : '∅',
    });
    if (!agentSid) {
      trace('SUMM_SKIP_NO_CLAUDESID', { sid: shortSid(sessionId) });
      return;
    }
    if (backendId !== 'claude-code' && backendId !== 'codex') {
      // Shells and unknown backends don't have a transcript-style
      // summariser — they go through updateTerminalSummary instead.
      trace('SUMM_SKIP_BACKEND', { sid: shortSid(sessionId), backendId: backendId ?? '∅' });
      return;
    }
    const cwd = live?.meta.worktreePath ?? dbRow?.worktree_path;
    if (!cwd) {
      trace('SUMM_SKIP_NO_CWD', { sid: shortSid(sessionId) });
      return;
    }

    // Claude's transcript path is deterministic from the cwd; Codex
    // stores rollouts by date so we have to scan.
    const transcriptPath = backendId === 'codex'
      ? findCodexTranscript(agentSid)
      : claudeTranscriptPath(cwd, agentSid);
    if (!transcriptPath) {
      trace('SUMM_SKIP_NO_TRANSCRIPT', {
        sid: shortSid(sessionId),
        backendId,
      });
      return;
    }
    const previousSummary = live?.meta.lastSummary ?? dbRow?.last_summary ?? null;
    const summary = await summarizeSession({
      sessionId,
      backendId,
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
    this.bumpActivity(sessionId);
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

  /** Stamp a session's most-recent-activity time, in memory + DB. Drives
   *  the Timeline view's ordering and "active N ago" label. Best-effort:
   *  never throws into the caller's path. The matching renderer-side
   *  bump rides on the event each caller already emits (every event
   *  carries `ts`), so the UI updates without a dedicated message. */
  private bumpActivity(sessionId: string, ts: number = Date.now()): void {
    const live = this.live.get(sessionId);
    if (live) live.meta = { ...live.meta, lastActiveAt: ts };
    try {
      getDatabase()
        .prepare('UPDATE sessions SET last_active_at = ? WHERE id = ?')
        .run(ts, sessionId);
    } catch { /* best-effort */ }
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
    // Becoming 'running' (agent working) or 'needs-input' (wants the
    // user) is real activity — stamp it so the Timeline view floats this
    // session up. Other transitions (idle/paused/done) are quiescence,
    // not activity, so they leave the clock alone.
    if (next === 'running' || next === 'needs-input') {
      this.bumpActivity(sessionId);
    }
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
          // Renderer-facing nudge: TurnsPane re-fetches session.turns
          // when this fires. The transcript file is the source of truth,
          // so the event carries no payload — just a "refresh now" ping.
          emit({ type: 'session.prompt_submitted', sessionId: event.sessionId });
          // A submitted prompt is unambiguous activity. Bump here rather
          // than relying on the setStatus('running') below — if the
          // session was ALREADY running (e.g. a long turn, or a row stuck
          // running since boot), that call no-ops and emits nothing, so
          // the Timeline would never reorder. The renderer mirrors this
          // off the prompt_submitted event it just received.
          this.bumpActivity(event.sessionId, t0);
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
