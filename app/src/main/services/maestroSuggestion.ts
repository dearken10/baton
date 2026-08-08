/**
 * Per-session Maestro suggestion service (variant A: inline card).
 *
 * A different orchestration mode from the periodic tick daemon: rather
 * than scanning every candidate on a 15-minute cadence, we fire the
 * option5 PM-as-outsider proposer for ONE session immediately after
 * that session stops processing (running → idle/needs-input/done).
 * The result is held in-memory keyed by sessionId and surfaced to the
 * renderer as an editable card above the terminal input.
 *
 * Where option4 clones the target's JSONL and asks IT to reflect on
 * itself, option5 spins up a FRESH claude -p with a Product Manager
 * persona (from goal.md — editable in Settings → Maestro), feeds it
 * the goal + a plain-text summary of the target's recent turns, and
 * asks what the engineer should be told to do next. Same JSON reply
 * shape either way, so downstream renderer + normalizer don't care.
 *
 * Lifecycle:
 *   1. subscribe to session.status_changed
 *   2. filter to running → (idle|needs-input|done) transitions
 *   3. gate: F15.1 (session Maestro-enabled? claude-code? has jsonl?)
 *   4. spawn poc/maestro/option5-product-manager/pm-propose.mjs with the
 *      target's Claude session id
 *   5. stash result in this.suggestions
 *   6. emit maestro.suggestion.updated so the renderer re-renders
 *
 * Non-goals for MVP:
 *   - persistence (a restart drops in-flight suggestions; the next
 *     transition regenerates)
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
import { buildLoginEnv } from './loginSessions.js';
import { resolveMaestroPromptPath } from './maestroPrompts.js';
import { getSessionManager } from './sessionManager.js';
import { getProject } from './projectStore.js';
import type { MaestroMode, MaestroSuggestion, Session, SessionStatus } from '../../shared/ipc.js';

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

/** Repo-relative path to the option5 PM proposer. Node child; inherits
 *  BATON_HOME from the current env so it targets the right db. */
function proposerScriptPath(): string {
  const repoRoot = join(app.getAppPath(), '..');
  return join(
    repoRoot,
    'poc',
    'maestro',
    'option5-product-manager',
    'pm-propose.mjs',
  );
}

/** HARD gates — the proposer physically can't run without these.
 *  Applied to both the auto (running → idle) trigger AND the manual
 *  Suggest button. Returns null when clear, else a reason string. */
function hardIneligibleReason(session: Session): string | null {
  if (session.backendId !== 'claude-code') return 'not-claude-code';
  if (!session.claudeSessionId) return 'no-jsonl';
  const project = getProject(session.projectId);
  if (!project) return 'unknown-project';
  return null;
}

/** Resolve the effective dock visibility for a session. Session
 *  override wins; else project default; else true. */
export function effectiveMaestroShow(session: Session): boolean {
  if (session.maestroShow != null) return session.maestroShow;
  const project = getProject(session.projectId);
  return project?.maestroShow ?? true;
}

/** Resolve the effective auto-fire mode for a session. Session
 *  override wins; else project default; else 'suggest'. */
export function effectiveMaestroMode(session: Session): MaestroMode {
  if (session.maestroMode != null) return session.maestroMode;
  const project = getProject(session.projectId);
  return project?.maestroMode ?? 'suggest';
}

/** SOFT gates — the user opted out for auto mode (dock hidden, mode
 *  set to manual, snooze). A manual Suggest click SHOULD still work
 *  when the dock is visible, so we only apply these on the auto path. */
function softIneligibleReason(session: Session): string | null {
  if (session.snoozedAt != null) return 'session-snoozed';
  const project = getProject(session.projectId);
  if (project?.snoozedAt != null) return 'project-snoozed';
  if (!effectiveMaestroShow(session)) return 'maestro-hidden';
  if (effectiveMaestroMode(session) === 'manual') return 'maestro-manual';
  return null;
}

/** F15.1 gate for a single session — full check, both hard + soft.
 *  Mirrors per-session-tick.mjs / inventory.mjs. Used by the auto
 *  trigger; the manual Suggest path only checks the hard reasons. */
function ineligibleReason(session: Session): string | null {
  return hardIneligibleReason(session) ?? softIneligibleReason(session);
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

  // Look up the target session's claude_session_id. The option5 script
  // finds the JSONL by <claude-session-id>.jsonl under ~/.claude/
  // projects/, so we need the CLAUDE id here, not the baton id (which
  // is what our own sessionId param is). ineligibleReason already
  // guarded on this above but we re-check to keep runProposer
  // self-contained.
  const session = getSessionManager().listAll().find((s) => s.id === sessionId);
  if (!session || !session.claudeSessionId) {
    const cur = state.get(sessionId);
    if (cur && cur.runId === runId) {
      cur.runId = null;
      state.set(sessionId, cur);
    }
    return;
  }
  const claudeSessionId = session.claudeSessionId;

  // Variant A uses the dedicated `goal` prompt (see poc/maestro/
  // option5-product-manager/prompts/goal.md; editable in Settings →
  // Maestro; the Settings editor writes to <BATON_HOME>/maestro/
  // prompts/goal.md which resolveMaestroPromptPath picks up first).
  // Falls back to the script's own default when the goal file was
  // deleted entirely.
  const promptPath = resolveMaestroPromptPath('goal');
  const args = promptPath
    ? [script, claudeSessionId, '--prompt', promptPath]
    : [script, claudeSessionId];

  // Match the target session's login for the PM's claude -p call so
  // the proposer authenticates against (and bills to) the same
  // account as the engineer. Fallback chain matches sessionManager
  // .resolveEffectiveLogin:
  //   session.loginSessionId → project.claudeLoginSessionId → global.
  // buildLoginEnv handles the null case → returns the empty env → the
  // spawn just inherits the parent's machine-global login.
  const project = getProject(session.projectId);
  const effectiveLoginId =
    session.loginSessionId
    ?? project?.claudeLoginSessionId
    ?? null;
  const loginEnv = buildLoginEnv(effectiveLoginId, 'claude-code');

  // Merge login env into the child's env. A '' value from
  // buildLoginEnv is the "unset the inherited var" sentinel — don't
  // pass an empty string through, which some CLIs treat as "set but
  // blank" and use to shadow the login's own auth.
  const spawnEnv: NodeJS.ProcessEnv = {
    ...process.env,
    BATON_HOME: batonHome(),
  };
  for (const [k, v] of Object.entries(loginEnv)) {
    if (v === '') delete spawnEnv[k];
    else spawnEnv[k] = v;
  }

  let parsed: unknown;
  try {
    const { stdout } = await execFileAsync('node', args, {
      timeout: PROPOSER_TIMEOUT_MS,
      maxBuffer: 8 * 1024 * 1024,
      env: spawnEnv,
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

  // Auto-execute path — when the user has set mode='execute' (per
  // session or per project), a `resume` proposal is auto-sent to the
  // target session's PTY without waiting for a manual Send click.
  // `wait`/`defer` proposals are left as passive cards (no prompt to
  // send). Manual Suggest clicks reuse the same path, so a click in
  // execute mode still auto-runs — that matches user expectation:
  // execute means execute, regardless of how the run was triggered.
  if (suggestion?.kind === 'resume' && suggestion.prompt.length > 0) {
    const session = getSessionManager().listAll().find((s) => s.id === sessionId);
    if (session && effectiveMaestroMode(session) === 'execute') {
      try {
        const r = await acceptMaestroSuggestion(sessionId, suggestion.prompt);
        if (!r.ok) {
          console.warn(`[maestro.suggestion] auto-execute failed for ${sessionId.slice(0, 8)}: ${r.reason}`);
        }
      } catch (e) {
        console.warn(`[maestro.suggestion] auto-execute threw for ${sessionId.slice(0, 8)}:`, e);
      }
    }
  }
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

/** User asked for a suggestion — either the ✨ Suggest button (first
 *  time) or ↻ Regenerate (already have one). Manual clicks bypass
 *  the SOFT gates (maestro_enabled off, session/project snoozed)
 *  because the flag is for auto-mode opt-out; an explicit user
 *  click is the strongest possible "yes, please run" signal. HARD
 *  gates (must be claude-code, must have a JSONL) still apply since
 *  the proposer physically can't run without them. */
export async function regenerateMaestroSuggestion(sessionId: string): Promise<{ ok: boolean; reason: string | null }> {
  const session = getSessionManager().listAll().find((s) => s.id === sessionId);
  if (!session) return { ok: false, reason: 'no such session' };
  const reason = hardIneligibleReason(session);
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
