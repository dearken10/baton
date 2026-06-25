/**
 * Maestro action approval + revert (PRD F15.6).
 *
 * The Approve button on a Maestro action card lands here. The flow:
 *
 *   1. Validate target — session must exist + be at a prompt (status
 *      ∈ { idle, needs-input, done }, NOT running or paused). Refuse
 *      otherwise; the user can retry once the agent's idle.
 *
 *   2. Checkpoint — `git tag baton/maestro/<action-id>/pre HEAD` plus
 *      `git stash create` (records the stash commit object without
 *      touching the index or working tree, so it's safe to run before
 *      ANY action). We also snapshot the agent's JSONL transcript
 *      offset — Revert truncates back to it so the Claude Code session
 *      is restored to its pre-action memory state.
 *
 *   3. Persist — INSERT the row with state='in_flight'. This is the
 *      gate: if the row write fails for any reason, we abort BEFORE
 *      sending the prompt. The revert button later reads this row.
 *
 *   4. Inject — paste the prompt, wait, then send `\r` separately so
 *      the agent's REPL sees it as a real Enter keypress. (Writing
 *      `prompt + '\r'` in one call lands as a single stdin read, which
 *      Claude Code treats as paste and stuffs the literal CR into the
 *      input buffer instead of submitting.)
 *
 * Revert is the symmetric op:
 *   - `git reset --hard <pre_tag>` + `git stash apply <stash_ref>`
 *     (worktree rewinds to approve-time)
 *   - kill the agent's live PTY (wait for exit)
 *   - truncate the JSONL transcript to the recorded byte offset
 *   - `claude --resume <uuid>` via sessionManager.resume — the new
 *     Claude Code process reads the rewound JSONL, so its memory of
 *     the action we just rolled back is gone.
 *   - mark the row state='reverted'.
 * Always available until the user explicitly cleans up the row.
 *
 * Prompt-injection caveat: a prompt with embedded newlines may insert
 * line breaks in the agent's multi-line editor instead of submitting.
 * Today's Maestro prompts are single-paragraph; the bridge between
 * `\n` and the editor's "shift+enter" semantics is a TODO.
 */

import { execFile } from 'node:child_process';
import { existsSync, statSync, truncateSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import type { ResponseOf } from '../../shared/ipc.js';
import { getDatabase } from '../database/index.js';
import { getSessionManager } from './sessionManager.js';
import { getProject } from './projectStore.js';

const exec = promisify(execFile);

type ApproveAction = NonNullable<ResponseOf<'maestro.getSession'>['ticks'][number]['plan']>['actions'][number];
type ActionRecord = ResponseOf<'maestro.listActions'>['actions'][number];

/** Statuses where the target agent is at a prompt and safe to inject
 *  into. `running` means a tool call is in flight; injecting now would
 *  collide with the agent's own stdin. `paused` means the user
 *  explicitly stopped the session. */
const INJECTABLE_STATUSES = new Set(['idle', 'needs-input', 'done']);

/** Hard limit on prompt size we'll inject in a single PTY write. The
 *  underlying pty accepts more, but anything bigger than this almost
 *  certainly means a planner bug. */
const MAX_PROMPT_BYTES = 16 * 1024;

/** Milliseconds between writing the prompt and writing the CR. Long
 *  enough that Claude Code's REPL drains the prompt-paste through its
 *  text-buffer code path BEFORE the CR arrives, short enough that the
 *  human-perceptible delay is invisible. 80 ms picked empirically from
 *  similar TUI input bridges. */
const SUBMIT_DELAY_MS = 80;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

interface ApproveOpts {
  action: ApproveAction;
}

interface ApproveResult {
  ok: boolean;
  /** Echo of action.actionId on success so the renderer can correlate. */
  actionId: string;
  /** When ok=false, human-readable reason. */
  reason: string | null;
}

interface RevertResult {
  ok: boolean;
  reason: string | null;
}

interface SessionRow {
  id: string;
  status: string;
  worktree_path: string;
  project_id: string;
  claude_session_id: string | null;
}

function lookupSession(sessionId: string): SessionRow | null {
  const row = getDatabase()
    .prepare(
      `SELECT id, status, worktree_path, project_id, claude_session_id
         FROM sessions
        WHERE id = ?`
    )
    .get(sessionId) as SessionRow | undefined;
  return row ?? null;
}

/** Match Claude Code's `~/.claude/projects/` naming: replace `/`, `.`,
 *  and `_` in the agent's cwd with `-`. Same sanitizer baton already
 *  uses for the master-session transcript reader. */
function sanitizeCwdForClaude(cwd: string): string {
  return cwd.replace(/[/._]/g, '-');
}

/** Absolute path of the agent's JSONL transcript, derived from its
 *  worktree (cwd) + the captured claude_session_id. Null when we
 *  don't have both pieces. */
function jsonlPathFor(worktree: string, claudeSessionId: string | null): string | null {
  if (!claudeSessionId) return null;
  return join(
    homedir(),
    '.claude',
    'projects',
    sanitizeCwdForClaude(worktree),
    `${claudeSessionId}.jsonl`,
  );
}

function fileSizeOr0(p: string): number {
  try {
    if (!existsSync(p)) return 0;
    return statSync(p).size;
  } catch {
    return 0;
  }
}

/** Run a git command inside the worktree. Returns stdout (trimmed) on
 *  success; throws Error with stderr on non-zero exit. */
async function git(cwd: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await exec('git', args, { cwd, timeout: 30_000 });
    return stdout.trim();
  } catch (e) {
    const err = e as { stderr?: string; message?: string };
    throw new Error(err.stderr?.trim() || err.message || `git ${args[0]} failed`);
  }
}

export async function approveAction(opts: ApproveOpts): Promise<ApproveResult> {
  const a = opts.action;

  if (a.kind === 'defer') {
    return { ok: false, actionId: a.actionId, reason: 'defer actions cannot be approved' };
  }
  if (a.kind === 'initiate') {
    return approveInitiate(a);
  }
  if (!a.targetSessionId) {
    return { ok: false, actionId: a.actionId, reason: 'action has no target session' };
  }
  if (!a.prompt || a.prompt.length === 0) {
    return { ok: false, actionId: a.actionId, reason: 'action has no prompt to send' };
  }
  if (a.prompt.length > MAX_PROMPT_BYTES) {
    return { ok: false, actionId: a.actionId, reason: 'prompt exceeds 16 KB safety cap' };
  }

  const session = lookupSession(a.targetSessionId);
  if (!session) {
    return { ok: false, actionId: a.actionId, reason: 'target session no longer exists' };
  }
  if (!INJECTABLE_STATUSES.has(session.status)) {
    return {
      ok: false,
      actionId: a.actionId,
      reason: `target session is ${session.status} — wait until it's idle or needs-input`,
    };
  }

  // Idempotency: if there's already an in_flight row for this action
  // id, refuse. (Failed/reverted ones are fine to retry; we'd start a
  // fresh row but reuse the action id — UPSERT.)
  const existing = getDatabase()
    .prepare(
      `SELECT state FROM maestro_actions WHERE action_id = ?`
    )
    .get(a.actionId) as { state: string } | undefined;
  if (existing && existing.state === 'in_flight') {
    return {
      ok: false,
      actionId: a.actionId,
      reason: 'action is already in flight',
    };
  }

  // Step 2: checkpoint. The tag name doubles as the revert handle.
  const preTag = `baton/maestro/${a.actionId}/pre`;
  try {
    await git(session.worktree_path, ['tag', '-f', preTag, 'HEAD']);
  } catch (e) {
    return { ok: false, actionId: a.actionId, reason: `git tag failed: ${(e as Error).message}` };
  }

  // stash create records the stash commit object without touching the
  // tree. Empty when the worktree is clean — we record an empty string.
  let stashRef = '';
  try {
    stashRef = (await git(session.worktree_path, ['stash', 'create'])).trim();
  } catch (e) {
    // Roll back the tag so we don't leak it.
    await git(session.worktree_path, ['tag', '-d', preTag]).catch(() => { /* best-effort */ });
    return { ok: false, actionId: a.actionId, reason: `git stash create failed: ${(e as Error).message}` };
  }

  // Snapshot the agent's JSONL transcript size at this instant — we
  // gated on status=idle/needs-input/done above, so the file is at a
  // clean line boundary. Revert truncates back to this byte offset.
  const jsonlPath = jsonlPathFor(session.worktree_path, session.claude_session_id);
  const jsonlOffset = jsonlPath ? fileSizeOr0(jsonlPath) : null;

  // Step 3: persist. The row write gates the next step — if it fails
  // we DON'T send the prompt.
  try {
    getDatabase()
      .prepare(
        `INSERT INTO maestro_actions
           (action_id, kind, target_session_id, target_project_id,
            worktree_path, pre_tag, stash_ref, prompt, rationale,
            confidence, state, created_at, jsonl_path, jsonl_offset)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'in_flight', ?, ?, ?)
         ON CONFLICT(action_id) DO UPDATE SET
           kind              = excluded.kind,
           target_session_id = excluded.target_session_id,
           target_project_id = excluded.target_project_id,
           worktree_path     = excluded.worktree_path,
           pre_tag           = excluded.pre_tag,
           stash_ref         = excluded.stash_ref,
           prompt            = excluded.prompt,
           rationale         = excluded.rationale,
           confidence        = excluded.confidence,
           state             = 'in_flight',
           state_detail      = NULL,
           created_at        = excluded.created_at,
           reverted_at       = NULL,
           jsonl_path        = excluded.jsonl_path,
           jsonl_offset      = excluded.jsonl_offset`
      )
      .run(
        a.actionId,
        a.kind,
        a.targetSessionId,
        a.targetProjectId,
        session.worktree_path,
        preTag,
        stashRef,
        a.prompt,
        a.rationale,
        a.confidence,
        Date.now(),
        jsonlPath,
        jsonlOffset,
      );
  } catch (e) {
    await git(session.worktree_path, ['tag', '-d', preTag]).catch(() => { /* best-effort */ });
    return { ok: false, actionId: a.actionId, reason: `ledger write failed: ${(e as Error).message}` };
  }

  // Step 4: inject. Two separate writes so the CR lands as its own
  // stdin event — Claude Code's REPL treats a `prompt\r` bundle as a
  // paste and writes the CR into the input buffer; splitting the
  // writes makes the second one register as a real Enter keypress.
  const mgr = getSessionManager();
  try {
    mgr.write(a.targetSessionId, a.prompt);
  } catch (e) {
    markFailed(a.actionId, `pty write (prompt) failed: ${(e as Error).message}`);
    return { ok: false, actionId: a.actionId, reason: (e as Error).message };
  }

  await delay(SUBMIT_DELAY_MS);

  try {
    mgr.write(a.targetSessionId, '\r');
  } catch (e) {
    // The prompt landed but Enter didn't — leave the row in_flight so
    // the user can hit Enter manually in the terminal pane.
    markFailed(a.actionId, `pty write (submit) failed: ${(e as Error).message}`);
    return { ok: false, actionId: a.actionId, reason: (e as Error).message };
  }

  return { ok: true, actionId: a.actionId, reason: null };
}

function markFailed(actionId: string, detail: string): void {
  try {
    getDatabase()
      .prepare(
        `UPDATE maestro_actions
            SET state = 'failed', state_detail = ?
          WHERE action_id = ?`
      )
      .run(detail, actionId);
  } catch { /* best-effort */ }
}

/** Maximum wall-clock to wait for the freshly-spawned agent's PTY to
 *  reach an injectable status (idle / needs-input). Claude Code's
 *  REPL boot is ~5-10 s; 30 s is generous. */
const INITIATE_READY_TIMEOUT_MS = 30_000;

/** Poll `sessions.status` until it reaches an injectable state or we
 *  hit the timeout. Returns the final status. */
async function waitForReady(sessionId: string): Promise<string> {
  const deadline = Date.now() + INITIATE_READY_TIMEOUT_MS;
  let lastStatus = '';
  while (Date.now() < deadline) {
    const row = lookupSession(sessionId);
    lastStatus = row?.status ?? '';
    if (INJECTABLE_STATUSES.has(lastStatus)) return lastStatus;
    await delay(300);
  }
  return lastStatus;
}

/** Approve flow for a Phase-3 `initiate` action: spawn a fresh agent
 *  in a new worktree off the project root, wait for the REPL to
 *  settle, then inject the seed prompt. Records in maestro_actions
 *  so Revert can `git worktree remove --force` it later. */
async function approveInitiate(a: ApproveAction): Promise<ApproveResult> {
  if (!a.targetProjectId) {
    return { ok: false, actionId: a.actionId, reason: 'initiate action has no target project' };
  }
  const branch = a.targetBranch ?? null;
  if (!branch || branch.trim().length === 0) {
    return { ok: false, actionId: a.actionId, reason: 'initiate action has no branch name' };
  }
  if (!a.prompt || a.prompt.length === 0) {
    return { ok: false, actionId: a.actionId, reason: 'initiate action has no seed prompt' };
  }
  if (a.prompt.length > MAX_PROMPT_BYTES) {
    return { ok: false, actionId: a.actionId, reason: 'seed prompt exceeds 16 KB safety cap' };
  }
  const project = getProject(a.targetProjectId);
  if (!project) {
    return { ok: false, actionId: a.actionId, reason: 'target project not found' };
  }

  // Spawn — sessionManager creates the worktree + boots the agent.
  // newWorktreeBranch is the branch the worktree gets created at;
  // cwd is the project root (the parent repo) where `git worktree
  // add` is invoked. If that branch already exists we fail-fast
  // so the user picks a different name on retry.
  const mgr = getSessionManager();
  let session;
  try {
    session = await mgr.spawn({
      projectId: project.id,
      backendId: 'claude-code',
      cwd: project.path,
      newWorktreeBranch: branch,
    });
  } catch (e) {
    return { ok: false, actionId: a.actionId, reason: `spawn failed: ${(e as Error).message}` };
  }

  // Wait for the REPL to be ready. The user-facing path goes:
  //   starting → spawned → running (claude boot) → idle (at prompt)
  // We only inject when status is in INJECTABLE_STATUSES.
  const status = await waitForReady(session.id);
  if (!INJECTABLE_STATUSES.has(status)) {
    // Spawn succeeded but the REPL didn't settle in time — record
    // what we have so Revert can clean up, but report the partial
    // failure to the renderer.
    try {
      getDatabase()
        .prepare(
          `INSERT INTO maestro_actions
             (action_id, kind, target_session_id, target_project_id,
              worktree_path, pre_tag, stash_ref, prompt, rationale,
              confidence, state, state_detail, created_at, target_branch)
           VALUES (?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?, 'failed', ?, ?, ?)
           ON CONFLICT(action_id) DO UPDATE SET
             state = 'failed', state_detail = excluded.state_detail`
        )
        .run(
          a.actionId, a.kind, session.id, a.targetProjectId,
          session.worktreePath, a.prompt, a.rationale, a.confidence,
          `agent not ready after ${INITIATE_READY_TIMEOUT_MS}ms (status=${status || 'unknown'})`,
          Date.now(), branch,
        );
    } catch { /* best-effort */ }
    return {
      ok: false,
      actionId: a.actionId,
      reason: `worktree created but agent didn't reach a prompt within ${INITIATE_READY_TIMEOUT_MS / 1000}s — use Revert to clean up`,
    };
  }

  // Record in the ledger BEFORE injecting — same gate logic as the
  // resume path. If the ledger write fails we don't send the prompt.
  try {
    getDatabase()
      .prepare(
        `INSERT INTO maestro_actions
           (action_id, kind, target_session_id, target_project_id,
            worktree_path, pre_tag, stash_ref, prompt, rationale,
            confidence, state, created_at, target_branch)
         VALUES (?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?, 'in_flight', ?, ?)
         ON CONFLICT(action_id) DO UPDATE SET
           kind              = excluded.kind,
           target_session_id = excluded.target_session_id,
           target_project_id = excluded.target_project_id,
           worktree_path     = excluded.worktree_path,
           prompt            = excluded.prompt,
           rationale         = excluded.rationale,
           confidence        = excluded.confidence,
           state             = 'in_flight',
           state_detail      = NULL,
           created_at        = excluded.created_at,
           reverted_at       = NULL,
           target_branch     = excluded.target_branch`
      )
      .run(
        a.actionId, a.kind, session.id, a.targetProjectId,
        session.worktreePath, a.prompt, a.rationale, a.confidence,
        Date.now(), branch,
      );
  } catch (e) {
    return { ok: false, actionId: a.actionId, reason: `ledger write failed: ${(e as Error).message}` };
  }

  // Inject: same split-write trick as the resume path.
  try {
    mgr.write(session.id, a.prompt);
  } catch (e) {
    markFailed(a.actionId, `pty write (prompt) failed: ${(e as Error).message}`);
    return { ok: false, actionId: a.actionId, reason: (e as Error).message };
  }
  await delay(SUBMIT_DELAY_MS);
  try {
    mgr.write(session.id, '\r');
  } catch (e) {
    markFailed(a.actionId, `pty write (submit) failed: ${(e as Error).message}`);
    return { ok: false, actionId: a.actionId, reason: (e as Error).message };
  }

  return { ok: true, actionId: a.actionId, reason: null };
}

export async function revertAction(actionId: string): Promise<RevertResult> {
  const row = getDatabase()
    .prepare(
      `SELECT action_id, kind, target_session_id, worktree_path,
              pre_tag, stash_ref, state, jsonl_path, jsonl_offset,
              target_branch
         FROM maestro_actions
        WHERE action_id = ?`
    )
    .get(actionId) as
    | {
        action_id: string;
        kind: string;
        target_session_id: string | null;
        worktree_path: string;
        pre_tag: string | null;
        stash_ref: string | null;
        state: string;
        jsonl_path: string | null;
        jsonl_offset: number | null;
        target_branch: string | null;
      }
    | undefined;

  if (!row) return { ok: false, reason: 'no such action in the ledger' };
  if (row.state === 'reverted') return { ok: false, reason: 'already reverted' };

  // Initiate revert path: the whole worktree IS the checkpoint, so
  // there's no git tag to reset to. Kill the agent + `git worktree
  // remove --force` + drop the session row.
  if (row.kind === 'initiate') {
    return revertInitiate(row.action_id, row.target_session_id);
  }

  if (!row.pre_tag) return { ok: false, reason: 'no checkpoint tag recorded' };

  // ── Step 1: rewind the worktree ──────────────────────────────────
  try {
    await git(row.worktree_path, ['reset', '--hard', row.pre_tag]);
  } catch (e) {
    return { ok: false, reason: `git reset failed: ${(e as Error).message}` };
  }

  // Stash-apply is non-fatal: if it conflicts the tree is still
  // reset to the checkpoint, just without the user's pre-action
  // uncommitted edits restored. Note the partial-revert and keep
  // going so the agent rewind still happens.
  let stashApplyWarning: string | null = null;
  if (row.stash_ref && row.stash_ref.length > 0) {
    try {
      await git(row.worktree_path, ['stash', 'apply', row.stash_ref]);
    } catch (e) {
      stashApplyWarning = `stash apply conflicted: ${(e as Error).message}`;
    }
  }

  // ── Step 2: rewind the agent's Claude Code session ───────────────
  // Best-effort — if any of these steps fail, the git revert still
  // landed. We report what happened in stateDetail so the user knows
  // the agent might still have stale memory.
  let agentRewindWarning: string | null = null;
  if (row.target_session_id && row.jsonl_path && row.jsonl_offset !== null) {
    try {
      const mgr = getSessionManager();
      // Kill + wait so the agent's JSONL writes stop before we truncate.
      await mgr.killAndAwait(row.target_session_id);
      // Truncate the transcript file. Safe even if file doesn't exist —
      // we just skip in that case.
      if (existsSync(row.jsonl_path)) {
        try {
          truncateSync(row.jsonl_path, row.jsonl_offset);
        } catch (e) {
          agentRewindWarning = `truncate failed: ${(e as Error).message}`;
        }
      }
      // Bring the agent back via `claude --resume <uuid>`, which now
      // reads the rewound transcript. If resume fails (e.g. transcript
      // probe says "no history"), the session row stays in ended state
      // and the user can manually respawn.
      if (!agentRewindWarning) {
        try {
          await mgr.resume(row.target_session_id);
        } catch (e) {
          agentRewindWarning = `respawn failed: ${(e as Error).message}`;
        }
      }
    } catch (e) {
      agentRewindWarning = `agent rewind failed: ${(e as Error).message}`;
    }
  } else if (row.target_session_id) {
    agentRewindWarning = 'no JSONL snapshot — agent memory not rewound';
  }

  // Drop the tag — the row stays so the Inbox can show "reverted at".
  await git(row.worktree_path, ['tag', '-d', row.pre_tag]).catch(() => { /* best-effort */ });

  // Combined warning for the user, when relevant.
  const warnings = [stashApplyWarning, agentRewindWarning]
    .filter((s): s is string => !!s)
    .join(' · ');

  getDatabase()
    .prepare(
      `UPDATE maestro_actions
          SET state = 'reverted',
              state_detail = ?,
              reverted_at = ?
        WHERE action_id = ?`
    )
    .run(warnings || null, Date.now(), actionId);

  return { ok: true, reason: warnings || null };
}

/** Revert an initiate action: kill the spawned agent + remove its
 *  worktree + delete the session row. The whole worktree was the
 *  checkpoint, so we don't need git tag/stash machinery. */
async function revertInitiate(
  actionId: string,
  targetSessionId: string | null,
): Promise<RevertResult> {
  let cleanupWarning: string | null = null;

  if (targetSessionId) {
    const mgr = getSessionManager();
    try {
      // delete() takes care of killing the PTY + git worktree remove
      // --force + removing the sessions row. removeWorktree defaults
      // to true for worktree sessions (which initiate always is).
      await mgr.delete(targetSessionId, { removeWorktree: true });
    } catch (e) {
      cleanupWarning = `delete failed: ${(e as Error).message}`;
    }
  } else {
    cleanupWarning = 'no target session to delete';
  }

  getDatabase()
    .prepare(
      `UPDATE maestro_actions
          SET state = 'reverted',
              state_detail = ?,
              reverted_at = ?
        WHERE action_id = ?`
    )
    .run(cleanupWarning, Date.now(), actionId);

  return { ok: true, reason: cleanupWarning };
}

export function listActions(targetSessionId?: string): { actions: ActionRecord[] } {
  const rows = targetSessionId
    ? getDatabase()
        .prepare(
          `SELECT * FROM maestro_actions
            WHERE target_session_id = ?
            ORDER BY created_at DESC`
        )
        .all(targetSessionId)
    : getDatabase()
        .prepare(`SELECT * FROM maestro_actions ORDER BY created_at DESC`)
        .all();
  return {
    actions: (rows as Array<Record<string, unknown>>).map((r) => ({
      actionId:        r.action_id as string,
      kind:            r.kind as 'resume' | 'initiate',
      targetSessionId: (r.target_session_id as string | null) ?? null,
      targetProjectId: (r.target_project_id as string | null) ?? null,
      targetBranch:    (r.target_branch as string | null) ?? null,
      worktreePath:    r.worktree_path as string,
      preTag:          (r.pre_tag as string | null) ?? null,
      stashRef:        (r.stash_ref as string | null) ?? null,
      prompt:          r.prompt as string,
      rationale:       (r.rationale as string | null) ?? null,
      confidence:      (r.confidence as number | null) ?? null,
      state:           r.state as 'in_flight' | 'reverted' | 'failed',
      stateDetail:     (r.state_detail as string | null) ?? null,
      createdAt:       r.created_at as number,
      revertedAt:      (r.reverted_at as number | null) ?? null,
    })),
  };
}
