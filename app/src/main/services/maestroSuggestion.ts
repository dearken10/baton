/**
 * Per-session Maestro suggestion service (variant A: inline card).
 *
 * A different orchestration mode from the periodic tick daemon: rather
 * than scanning every candidate on a 15-minute cadence, we fire the
 * option4 proposer for ONE session immediately after that session
 * stops processing (running → idle/needs-input/done). The result is
 * held in-memory keyed by sessionId and surfaced to the renderer as
 * an editable card above the terminal input.
 *
 * Lifecycle:
 *   1. subscribe to session.status_changed
 *   2. filter to running → (idle|needs-input|done) transitions
 *   3. gate: F15.1 (session Maestro-enabled? claude-code? has jsonl?)
 *   4. spawn poc/maestro/option4-per-session-clone/propose-for-session.mjs
 *   5. stash result in this.suggestions
 *   6. emit maestro.suggestion.updated so the renderer re-renders
 *
 * Non-goals for MVP:
 *   - persistence (a restart drops in-flight suggestions; the next
 *     transition regenerates)
 *   - full 3-phase fallback (per-session proposer is phase 1 only)
 *   - concurrent proposers per session (a second transition while a
 *     proposer is still running is coalesced — we discard the old
 *     inflight result once the new one starts)
 */

import { app } from 'electron';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { batonHome } from '../paths.js';
import { emit, subscribe } from './eventBus.js';
import { resolveMaestroPromptPath } from './maestroPrompts.js';
import { getSessionManager } from './sessionManager.js';
import { getProject } from './projectStore.js';
import type { MaestroSuggestion, Session, SessionStatus } from '../../shared/ipc.js';

const execFileAsync = promisify(execFile);

/** Statuses that mark the agent as "stopped processing" — we fire a
 *  proposer when the session transitions into one of these from
 *  `running`. `done` is included because a finished session can still
 *  usefully receive a follow-up prompt (that's a resume in effect). */
const TRIGGER_STATUSES: ReadonlySet<SessionStatus> = new Set(['idle', 'needs-input', 'done']);

/** Cap on how long the proposer can take before we give up. The clone
 *  + one claude --print call is usually 20–60 s; 3 min is generous. */
const PROPOSER_TIMEOUT_MS = 180_000;

interface SuggestionState {
  /** Non-null while the proposer is in flight — used both to
   *  short-circuit duplicate fires and to correlate "cancel this one,
   *  the next transition superseded it". */
  runId: number | null;
  /** Whatever the last completed proposer wrote, or null if never run
   *  / dismissed / failed. Cleared when the user Sends or Dismisses. */
  suggestion: MaestroSuggestion | null;
}

let started = false;
let unsubscribe: (() => void) | null = null;
const state = new Map<string, SuggestionState>();
let runIdSeq = 0;

/** Repo-relative path to the option4 proposer. Node child; inherits
 *  BATON_HOME from the current env so it targets the right db. */
function proposerScriptPath(): string {
  const repoRoot = join(app.getAppPath(), '..');
  return join(
    repoRoot,
    'poc',
    'maestro',
    'option4-per-session-clone',
    'propose-for-session.mjs',
  );
}

/** F15.1 gate for a single session. Mirrors the filter in
 *  per-session-tick.mjs / inventory.mjs but works off the live
 *  in-memory Session + the project row. Returns null when eligible
 *  or a reason string for the debug log when not. */
function ineligibleReason(session: Session): string | null {
  if (session.backendId !== 'claude-code') return 'not-claude-code';
  if (session.snoozedAt != null) return 'session-snoozed';
  if (!session.claudeSessionId) return 'no-jsonl';

  const project = getProject(session.projectId);
  if (!project) return 'unknown-project';
  if (project.snoozedAt != null) return 'project-snoozed';

  // Three-tier resolution: session override wins, then project.
  const effective =
    session.maestroEnabled != null
      ? session.maestroEnabled
      : project.maestroEnabled;
  if (!effective) return 'maestro-disabled';

  return null;
}

/** Kick off a proposer run for a session. Non-throwing — logs on
 *  failure and clears the in-flight marker so the next transition can
 *  try again. */
async function runProposer(sessionId: string): Promise<void> {
  const st = state.get(sessionId) ?? { runId: null, suggestion: null };
  const runId = ++runIdSeq;
  st.runId = runId;
  state.set(sessionId, st);

  const script = proposerScriptPath();
  if (!existsSync(script)) {
    console.warn('[maestro.suggestion] proposer script missing at', script);
    if (state.get(sessionId)?.runId === runId) {
      const cur = state.get(sessionId)!;
      cur.runId = null;
      state.set(sessionId, cur);
    }
    return;
  }

  // Variant A uses the dedicated `goal` prompt (see prompts/goal.md;
  // editable in Settings → Maestro). The proposer's `--prompt` flag
  // takes an absolute path; falls back to the proposer's own default
  // (which is `next-action.md`) when the goal file was deleted.
  const promptPath = resolveMaestroPromptPath('goal');
  const args = promptPath
    ? [script, sessionId, '--prompt', promptPath]
    : [script, sessionId];

  let parsed: unknown;
  try {
    const { stdout } = await execFileAsync('node', args, {
      timeout: PROPOSER_TIMEOUT_MS,
      maxBuffer: 8 * 1024 * 1024,
      env: {
        ...process.env,
        BATON_HOME: batonHome(),
      },
    });
    parsed = JSON.parse(stdout);
  } catch (e) {
    // Timeout, bad JSON, missing session — silently drop; the
    // next transition will retry.
    console.warn(`[maestro.suggestion] proposer failed for ${sessionId.slice(0, 8)}:`, (e as Error).message);
    const cur = state.get(sessionId);
    if (cur && cur.runId === runId) {
      cur.runId = null;
      state.set(sessionId, cur);
    }
    return;
  }

  // If the state was superseded (dismissed, or a newer proposer
  // started), discard our result.
  const cur = state.get(sessionId);
  if (!cur || cur.runId !== runId) return;

  const suggestion = normalizeProposal(parsed, sessionId);
  cur.runId = null;
  cur.suggestion = suggestion;
  state.set(sessionId, cur);

  emit({
    type: 'maestro.suggestion.updated',
    sessionId,
    suggestion,
  });
}

/** Shape the proposer's JSON output into the renderer-friendly
 *  MaestroSuggestion. Returns null only when the proposal shape is
 *  malformed OR when it's a `resume` with an empty prompt (the card
 *  can't render anything actionable). `wait`/`defer` are surfaced as
 *  passive-state suggestions so the user can see Maestro ran + why
 *  it chose to defer, and hit Regenerate if the state changed. */
function normalizeProposal(raw: unknown, sessionId: string): MaestroSuggestion | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as { proposal?: unknown; baton_session_id?: unknown; target_project_id?: unknown };
  const p = r.proposal;
  if (!p || typeof p !== 'object') return null;
  const proposal = p as {
    action?: unknown;
    prompt?: unknown;
    rationale?: unknown;
    confidence?: unknown;
    assumption?: unknown;
    if_wrong?: unknown;
  };
  const kind: MaestroSuggestion['kind'] =
    proposal.action === 'resume'
      ? 'resume'
      : proposal.action === 'defer'
        ? 'defer'
        : 'wait';   // anything else (wait / unknown) is a passive card

  const prompt = typeof proposal.prompt === 'string' ? proposal.prompt.trim() : '';
  // A `resume` without a prompt is a proposer bug — nothing to inject
  // and no rationale-only card would make sense — drop it.
  if (kind === 'resume' && prompt.length === 0) return null;

  const confidenceBucket: Record<string, number> = { high: 0.85, medium: 0.60, low: 0.35 };
  const confidence =
    typeof proposal.confidence === 'string'
      ? (confidenceBucket[proposal.confidence] ?? 0.5)
      : typeof proposal.confidence === 'number'
        ? proposal.confidence
        : 0.5;

  return {
    sessionId,
    kind,
    prompt: kind === 'resume' ? prompt : '',
    rationale: typeof proposal.rationale === 'string' ? proposal.rationale : null,
    assumption: typeof proposal.assumption === 'string' ? proposal.assumption : null,
    ifWrong: typeof proposal.if_wrong === 'string' ? proposal.if_wrong : null,
    confidence,
    proposedAt: Date.now(),
  };
}

/** Get the current suggestion for a session, or null. Renderer polls
 *  this on mount + we push via event on updates. */
export function getMaestroSuggestion(sessionId: string): MaestroSuggestion | null {
  return state.get(sessionId)?.suggestion ?? null;
}

/** User accepted (possibly after editing) the suggestion. Injects the
 *  final prompt into the target session's PTY using the same
 *  split-write trick approveAction uses (paste, 80 ms delay, CR) so
 *  Claude Code's REPL treats the CR as a real Enter rather than
 *  buffering it as paste content.
 *
 *  On success clears the stored suggestion + emits an update. */
export async function acceptMaestroSuggestion(
  sessionId: string,
  finalPrompt: string,
): Promise<{ ok: boolean; reason: string | null }> {
  const trimmed = finalPrompt.trim();
  if (trimmed.length === 0) {
    return { ok: false, reason: 'empty prompt' };
  }
  const mgr = getSessionManager();
  try {
    mgr.write(sessionId, trimmed);
  } catch (e) {
    return { ok: false, reason: `pty write (prompt) failed: ${(e as Error).message}` };
  }
  await new Promise((resolve) => setTimeout(resolve, 80));
  try {
    mgr.write(sessionId, '\r');
  } catch (e) {
    return { ok: false, reason: `pty write (submit) failed: ${(e as Error).message}` };
  }

  // Clear the stored suggestion — the user acted on it.
  const cur = state.get(sessionId);
  if (cur) {
    cur.suggestion = null;
    state.set(sessionId, cur);
  }
  emit({ type: 'maestro.suggestion.updated', sessionId, suggestion: null });
  return { ok: true, reason: null };
}

/** User dismissed the suggestion without sending. Clears state + emits. */
export function dismissMaestroSuggestion(sessionId: string): { ok: true } {
  const cur = state.get(sessionId);
  if (cur) {
    cur.suggestion = null;
    // If a proposer is in flight, mark the runId as stale — its
    // eventual result gets dropped by the "runId superseded" check.
    cur.runId = null;
    state.set(sessionId, cur);
  }
  emit({ type: 'maestro.suggestion.updated', sessionId, suggestion: null });
  return { ok: true as const };
}

/** User asked for a different suggestion. Fires a new proposer run;
 *  the existing suggestion stays visible until the new one lands. */
export async function regenerateMaestroSuggestion(sessionId: string): Promise<{ ok: boolean; reason: string | null }> {
  const session = getSessionManager().listAll().find((s) => s.id === sessionId);
  if (!session) return { ok: false, reason: 'no such session' };
  const reason = ineligibleReason(session);
  if (reason) return { ok: false, reason };
  void runProposer(sessionId);
  return { ok: true, reason: null };
}

/** Wire the status-change subscription. Idempotent. Called once at
 *  main-process boot after the DB + session manager are up. */
export function startMaestroSuggestion(): void {
  if (started) return;
  started = true;
  unsubscribe = subscribe((event) => {
    if (event.type !== 'session.status_changed') return;
    if (event.from !== 'running') return;
    if (!TRIGGER_STATUSES.has(event.to)) return;

    // Look up the fresh session row (the event only carries the
    // status transition, not the whole session).
    const session = getSessionManager().listAll().find((s) => s.id === event.sessionId);
    if (!session) return;

    const reason = ineligibleReason(session);
    if (reason) return;

    // Skip if a proposer is already running for this session — the
    // in-flight run picks up whatever the JSONL had at fire time, so
    // firing twice would just waste tokens.
    if (state.get(event.sessionId)?.runId != null) return;

    void runProposer(event.sessionId);
  });
}

/** Test helper — stop the subscription and drop state. */
export function stopMaestroSuggestion(): void {
  if (!started) return;
  started = false;
  if (unsubscribe) unsubscribe();
  unsubscribe = null;
  state.clear();
}
