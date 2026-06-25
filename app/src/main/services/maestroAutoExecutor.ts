/**
 * Maestro auto-executor (PRD F15.2 act-first).
 *
 * The planner writes `last-plan.json` after every tick. Until this
 * module existed, the file just sat there until a human clicked
 * Approve in the UI — meaning Maestro could never actually act
 * unattended, even with the mode toggle set to "run". This closes
 * that loop:
 *
 *   1. Watch `poc/maestro/option2-claude-skill/last-plan.json` for
 *      mtime changes.
 *   2. On change, if `mode == act-first` AND not paused, iterate the
 *      plan's actions in confidence-descending order.
 *   3. For each, run a defense-in-depth safety bar (the planner is
 *      supposed to enforce these too, but we don't trust it):
 *        - kind != defer
 *        - parent project has `maestro_enabled = 1`
 *        - target session + parent project are not snoozed
 *        - no existing `in_flight` ledger row for this action_id
 *        - confidence ≥ MAESTRO_AUTO_MIN_CONFIDENCE (default 0)
 *      `approveAction()` itself re-checks injectable status, the
 *      checkpoint, ledger write, and prompt size — we don't duplicate
 *      those here.
 *   4. Call `approveAction({ action })`. Append the decision +
 *      outcome to `<batonHome()>/maestro/auto-exec.log` so the user
 *      can tail it. (batonHome() honors BATON_HOME, so multiple
 *      baton instances get their own log + state.)
 *
 * Lifecycle: started from main/index.ts after `reconcileMaestroOnStartup`.
 * Polls every POLL_INTERVAL_MS. There's no separate stop path —
 * Electron quit terminates the timer with the process. Tests can call
 * the exported `stopMaestroAutoExecutor()` to clear the interval.
 *
 * Why poll instead of fs.watch? Same reason the rest of Maestro
 * polls: mtime is the canonical signal across processes (daemon,
 * shell, Electron), and fs.watch on macOS is unreliable for files
 * rewritten via the typical "write tmp + rename" pattern the skill
 * uses. 5 s poll is fine — the human approve loop took minutes.
 */

import { existsSync, mkdirSync, readFileSync, statSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { app } from 'electron';

import type { ResponseOf } from '../../shared/ipc.js';
import { getDatabase } from '../database/index.js';
import { batonHome } from '../paths.js';
import { getProject } from './projectStore.js';
import { approveAction } from './maestroAction.js';

type PlanFromState = NonNullable<ResponseOf<'maestro.getState'>['plan']>;
type PlanAction = PlanFromState['actions'][number];

/** Disk shape of `last-plan.json` (snake_case, written by the option 2
 *  skill). Kept narrow — we only read what the executor needs. */
interface PlanFromDisk {
  tick_at: string;
  skip_reason: string | null;
  actions: Array<{
    action_id: string;
    kind: 'resume' | 'initiate' | 'defer';
    target_session_id: string | null;
    target_project_id: string | null;
    target_branch?: string | null;
    prompt: string | null;
    rationale: string;
    confidence: number;
  }>;
}

const POLL_INTERVAL_MS = 5_000;

function planFilePath(): string {
  // Mirrors maestroState.ts: walk one level up from app/ to the repo
  // root, then into the option-2 PoC dir where the skill writes.
  const repoRoot = join(app.getAppPath(), '..');
  return join(repoRoot, 'poc', 'maestro', 'option2-claude-skill', 'last-plan.json');
}

function maestroDir(): string {
  return join(batonHome(), 'maestro');
}
function modeFilePath(): string {
  return join(maestroDir(), 'mode');
}
function pausedFlagPath(): string {
  return join(maestroDir(), 'paused');
}
function autoExecLogPath(): string {
  return join(maestroDir(), 'auto-exec.log');
}

function readMode(): 'propose-first' | 'act-first' {
  try {
    if (!existsSync(modeFilePath())) return 'propose-first';
    const raw = readFileSync(modeFilePath(), 'utf8').trim();
    return raw === 'act-first' ? 'act-first' : 'propose-first';
  } catch {
    return 'propose-first';
  }
}

function readMinConfidence(): number {
  const env = process.env.MAESTRO_AUTO_MIN_CONFIDENCE;
  const n = env ? Number.parseFloat(env) : 0;
  return Number.isFinite(n) ? n : 0;
}

function logLine(line: string): void {
  try {
    mkdirSync(join(autoExecLogPath(), '..'), { recursive: true });
    appendFileSync(autoExecLogPath(), `${new Date().toISOString()} ${line}\n`);
  } catch { /* best-effort */ }
}

interface SessionRow {
  id: string;
  status: string;
  snoozed_at: number | null;
  project_id: string;
}

function lookupSession(sessionId: string): SessionRow | null {
  const row = getDatabase()
    .prepare(
      `SELECT id, status, snoozed_at, project_id FROM sessions WHERE id = ?`
    )
    .get(sessionId) as SessionRow | undefined;
  return row ?? null;
}

function existingActionState(actionId: string): string | null {
  const row = getDatabase()
    .prepare(`SELECT state FROM maestro_actions WHERE action_id = ?`)
    .get(actionId) as { state: string } | undefined;
  return row?.state ?? null;
}

/** Reshape a disk-format action into the camelCase shape `approveAction`
 *  expects (it normally gets it via the IPC layer). The shapes differ
 *  only by case + the assumptions/reversibility fields we don't need
 *  here. */
function diskToApproveAction(a: PlanFromDisk['actions'][number]): PlanAction {
  return {
    actionId:        a.action_id,
    kind:            a.kind,
    targetSessionId: a.target_session_id,
    targetProjectId: a.target_project_id,
    targetBranch:    a.target_branch ?? null,
    prompt:          a.prompt,
    rationale:       a.rationale,
    confidence:      a.confidence,
    assumptionsMade: [],
  };
}

interface SafetyResult {
  ok: boolean;
  reason?: string;
}

/** Defense-in-depth gate. The planner is supposed to filter these
 *  cases too — but it's a model, so we don't trust it. Returns
 *  ok:false with a human-readable reason for the log when the action
 *  should be skipped. */
function safetyCheck(a: PlanAction, minConfidence: number): SafetyResult {
  if (a.kind === 'defer') return { ok: false, reason: 'defer (no-op)' };
  if (a.confidence < minConfidence) {
    return { ok: false, reason: `confidence ${a.confidence.toFixed(2)} < ${minConfidence}` };
  }

  // Existing ledger row gating. `in_flight` means we already approved
  // it; `reverted`/`failed` means the user (or a prior auto-exec) made
  // a choice and we shouldn't re-fire.
  const existing = existingActionState(a.actionId);
  if (existing) {
    return { ok: false, reason: `already in ledger as ${existing}` };
  }

  // Project gate. The chip's per-project toggle is the user's "leave
  // this one alone" signal — honor it even if the planner forgot.
  if (a.targetProjectId) {
    const project = getProject(a.targetProjectId);
    if (!project) return { ok: false, reason: 'unknown project' };
    if (!project.maestroEnabled) return { ok: false, reason: 'project maestro=off' };
    if (project.snoozedAt) return { ok: false, reason: 'project snoozed' };
  }

  // Resume-specific gate: session row must exist, must be the target,
  // must not be snoozed. The "is injectable" check is done by
  // approveAction itself.
  if (a.kind === 'resume') {
    if (!a.targetSessionId) return { ok: false, reason: 'resume w/o session' };
    const session = lookupSession(a.targetSessionId);
    if (!session) return { ok: false, reason: 'session no longer exists' };
    if (session.snoozed_at) return { ok: false, reason: 'session snoozed' };
  }

  // Initiate-specific gate: target_branch + prompt required (the IPC
  // approver re-validates, but we may as well skip cleanly here).
  if (a.kind === 'initiate') {
    if (!a.targetBranch || a.targetBranch.trim().length === 0) {
      return { ok: false, reason: 'initiate w/o branch' };
    }
    if (!a.prompt || a.prompt.trim().length === 0) {
      return { ok: false, reason: 'initiate w/o prompt' };
    }
  }

  return { ok: true };
}

let lastSeenMtimeMs = 0;
let intervalHandle: NodeJS.Timeout | null = null;
let running = false;

async function processPlanFile(): Promise<void> {
  // Re-entrancy guard. A long approveAction (worktree spawn for an
  // initiate is ~15-30 s) can outlast the poll interval; if the next
  // tick fires we silently skip it. Next interval picks up where we
  // left off.
  if (running) return;

  const path = planFilePath();
  if (!existsSync(path)) return;

  let mtimeMs: number;
  try {
    mtimeMs = statSync(path).mtimeMs;
  } catch { return; }

  if (mtimeMs === lastSeenMtimeMs) return;

  // Read first so an unparseable file still bumps the cursor — we don't
  // want to retry a broken plan every 5 seconds.
  let plan: PlanFromDisk;
  try {
    plan = JSON.parse(readFileSync(path, 'utf8')) as PlanFromDisk;
  } catch (e) {
    logLine(`SKIP parse failed: ${(e as Error).message}`);
    lastSeenMtimeMs = mtimeMs;
    return;
  }
  lastSeenMtimeMs = mtimeMs;

  // Mode + paused gates. The user can flip these between ticks; we
  // re-read every time.
  if (existsSync(pausedFlagPath())) {
    logLine(`SKIP paused (tick_at=${plan.tick_at})`);
    return;
  }
  const mode = readMode();
  if (mode !== 'act-first') {
    logLine(`SKIP mode=${mode} (tick_at=${plan.tick_at})`);
    return;
  }
  if (plan.skip_reason) {
    logLine(`SKIP planner skip=${plan.skip_reason} (tick_at=${plan.tick_at})`);
    return;
  }
  if (plan.actions.length === 0) {
    logLine(`SKIP no actions (tick_at=${plan.tick_at})`);
    return;
  }

  const minConfidence = readMinConfidence();
  // Sort by confidence desc — same order the planner itself uses, but
  // we don't rely on the file being sorted.
  const sorted = [...plan.actions]
    .map(diskToApproveAction)
    .sort((a, b) => b.confidence - a.confidence);

  running = true;
  try {
    logLine(`TICK ${plan.tick_at} actions=${sorted.length} mode=${mode} min_conf=${minConfidence}`);
    for (const a of sorted) {
      const sid = a.targetSessionId ? a.targetSessionId.slice(0, 8) : '--------';
      const safety = safetyCheck(a, minConfidence);
      if (!safety.ok) {
        logLine(`SKIP ${a.kind} ${sid} conf=${a.confidence.toFixed(2)} — ${safety.reason}`);
        continue;
      }
      try {
        const result = await approveAction({ action: a });
        if (result.ok) {
          logLine(`OK   ${a.kind} ${sid} conf=${a.confidence.toFixed(2)} action_id=${a.actionId}`);
        } else {
          logLine(`FAIL ${a.kind} ${sid} conf=${a.confidence.toFixed(2)} — ${result.reason ?? 'unknown'}`);
        }
      } catch (e) {
        logLine(`THROW ${a.kind} ${sid} — ${(e as Error).message}`);
      }
    }
  } finally {
    running = false;
  }
}

/** Begin the poll loop. Idempotent — calling twice is a no-op. */
export function startMaestroAutoExecutor(): void {
  if (intervalHandle) return;
  // Seed lastSeenMtimeMs from the file's CURRENT mtime so the executor
  // doesn't re-fire whatever's already on disk at boot. The user
  // already saw that plan and either approved or didn't; treating it
  // as fresh would be a surprise.
  try {
    const path = planFilePath();
    if (existsSync(path)) {
      lastSeenMtimeMs = statSync(path).mtimeMs;
    }
  } catch { /* fine — first real tick advances it */ }

  intervalHandle = setInterval(() => {
    void processPlanFile();
  }, POLL_INTERVAL_MS);
  // Don't block Electron shutdown on this timer.
  if (typeof intervalHandle.unref === 'function') intervalHandle.unref();

  logLine(`START poll=${POLL_INTERVAL_MS}ms watching=${planFilePath()}`);
}

/** Stop the poll loop. Used by tests; production code lets Electron
 *  shutdown clear it. */
export function stopMaestroAutoExecutor(): void {
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = null;
  }
}
