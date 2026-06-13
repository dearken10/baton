/**
 * Maestro PoC state reader.
 *
 * Reads the on-disk state written by the option 3 master-mind PoC
 * (poc/maestro/option3-master-session/) so the renderer's MaestroChip
 * can show what's going on. This is intentionally a thin file-system
 * adapter — the PRD F15 spec calls for first-class baton-service
 * integration, but the PoC is propose-only and lives outside baton's
 * session manager today. v1.x replaces this with proper IPC events
 * driven by an in-process Maestro service.
 *
 * Cache: 2 s. The chip polls at 5 s; this stops aggressive re-reads
 * when the popup is open.
 */

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { app } from 'electron';

import type { ResponseOf } from '../../shared/ipc.js';

type State = ResponseOf<'maestro.getState'>;

interface ActionFromDisk {
  action_id: string;
  kind: 'resume' | 'initiate' | 'defer';
  target_session_id: string | null;
  target_project_id: string | null;
  prompt: string | null;
  rationale: string;
  confidence: number;
  assumptions_made?: Array<{
    question: string;
    assumed_answer: string;
    why?: string;
    if_wrong?: string;
  }>;
  reversibility_note?: string;
}

interface PlanFromDisk {
  tick_at: string;
  skip_reason: string | null;
  reasoning: string;
  actions: ActionFromDisk[];
}

const CACHE_TTL_MS = 2000;
let cache: { at: number; value: State } | null = null;

const DEFAULT_INTERVAL_MIN = 15;

/** Maestro's per-machine state lives in ~/.baton/maestro/ alongside
 *  daemon.pid and the bloat marker. The PAUSED flag is just file
 *  presence (no content); easy to inspect with `ls` and easy for the
 *  shell tick script to honor without parsing JSON. */
function pausedFlagPath(): string {
  return join(homedir(), '.baton', 'maestro', 'paused');
}

function maestroStateDir(): string {
  // The PoC lives under poc/maestro/option3-master-session/state/ in
  // the repo. When the Electron app is unpackaged in dev we can find
  // the repo via app.getAppPath() (points to `app/`). When packaged
  // we don't expect the PoC to be present at all — return a path that
  // won't exist, and the rest of the function deals with it.
  const appPath = app.getAppPath();
  // appPath at dev time → <repo>/app
  // Walk one level up to find the repo root.
  const repoRoot = join(appPath, '..');
  return join(repoRoot, 'poc', 'maestro', 'option3-master-session', 'state');
}

function readTextSafe(p: string): string | null {
  try {
    if (!existsSync(p)) return null;
    return readFileSync(p, 'utf8').trim();
  } catch {
    return null;
  }
}

function readJsonSafe<T>(p: string): T | null {
  try {
    if (!existsSync(p)) return null;
    return JSON.parse(readFileSync(p, 'utf8')) as T;
  } catch {
    return null;
  }
}

function fileMtimeIso(p: string): string | null {
  try {
    if (!existsSync(p)) return null;
    return new Date(statSync(p).mtimeMs).toISOString();
  } catch {
    return null;
  }
}

function readIntervalMin(): number {
  // PoC sources MAESTRO_TICK_INTERVAL_MIN from the environment of the
  // daemon process. baton's renderer can't see that; we fall back to
  // the documented default (15 min) and let v1.x persist it.
  const env = process.env.MAESTRO_TICK_INTERVAL_MIN;
  const n = env ? Number.parseInt(env, 10) : NaN;
  if (Number.isFinite(n) && n > 0) return n;
  return DEFAULT_INTERVAL_MIN;
}

function isDaemonRunning(): boolean {
  const pidPath = join(homedir(), '.baton', 'maestro', 'daemon.pid');
  const pidStr = readTextSafe(pidPath);
  if (!pidStr) return false;
  const pid = Number.parseInt(pidStr, 10);
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    // Signal 0 → liveness probe. ESRCH means the process is gone.
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function normalizePlan(p: PlanFromDisk | null): State['plan'] {
  if (!p) return null;
  return {
    tickAt:     p.tick_at,
    skipReason: p.skip_reason,
    reasoning:  p.reasoning,
    actions: p.actions.map((a) => ({
      actionId:        a.action_id,
      kind:            a.kind,
      targetSessionId: a.target_session_id,
      targetProjectId: a.target_project_id,
      prompt:          a.prompt,
      rationale:       a.rationale,
      confidence:      a.confidence,
      assumptionsMade: (a.assumptions_made ?? []).map((x) => ({
        question:      x.question,
        assumedAnswer: x.assumed_answer,
        why:           x.why,
        ifWrong:       x.if_wrong,
      })),
      reversibilityNote: a.reversibility_note,
    })),
  };
}

export function getMaestroState(): State {
  const now = Date.now();
  if (cache && now - cache.at < CACHE_TTL_MS) return cache.value;

  const stateDir = maestroStateDir();
  const stateRoot = join(stateDir, '..');

  const sessionId = readTextSafe(join(stateDir, 'session-id'));
  const tickCountStr = readTextSafe(join(stateDir, 'tick-count'));
  const tickCount = tickCountStr ? Number.parseInt(tickCountStr, 10) : 0;
  const installed = existsSync(stateDir) || existsSync(stateRoot);
  const bloatWarning = existsSync(join(stateDir, 'bloat-warning'));

  const lastTickAt = fileMtimeIso(join(stateDir, 'last-tick.log'));
  const tickIntervalMin = readIntervalMin();
  const nextTickEtaAt = lastTickAt
    ? new Date(Date.parse(lastTickAt) + tickIntervalMin * 60_000).toISOString()
    : null;

  const planDisk = readJsonSafe<PlanFromDisk>(
    join(stateRoot, 'last-plan.json')
  );

  const value: State = {
    installed,
    sessionId,
    tickCount: Number.isFinite(tickCount) ? tickCount : 0,
    lastTickAt,
    nextTickEtaAt,
    tickIntervalMin,
    daemonRunning: isDaemonRunning(),
    paused: existsSync(pausedFlagPath()),
    bloatWarning,
    plan: normalizePlan(planDisk),
  };
  cache = { at: now, value };
  return value;
}

/** Touch / remove the paused flag. Bypasses + invalidates the read
 *  cache so the next getMaestroState() returns the new value. */
export function setMaestroPaused(paused: boolean): { paused: boolean } {
  const p = pausedFlagPath();
  try {
    mkdirSync(join(p, '..'), { recursive: true });
  } catch { /* dir may already exist */ }
  if (paused) {
    if (!existsSync(p)) writeFileSync(p, new Date().toISOString() + '\n');
  } else {
    try { unlinkSync(p); } catch { /* not present, fine */ }
  }
  cache = null;
  return { paused: existsSync(p) };
}

/** Test helper: drops the cache so a follow-up call re-reads disk. */
export function _resetMaestroStateCacheForTests(): void {
  cache = null;
}
