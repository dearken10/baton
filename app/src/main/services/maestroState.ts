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

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync, unlinkSync, openSync, closeSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { app } from 'electron';

import type { ResponseOf } from '../../shared/ipc.js';

type State = ResponseOf<'maestro.getState'>;
type Mode = State['mode'];
const DEFAULT_MODE: Mode = 'propose-first';

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

/** Mode file: contains the literal "propose-first" or "act-first".
 *  Missing or unreadable → DEFAULT_MODE. Same one-line format
 *  bootstrap-or-tick.sh's --mode flag writes. */
function modeFilePath(): string {
  return join(homedir(), '.baton', 'maestro', 'mode');
}

function readMode(): Mode {
  const raw = readTextSafe(modeFilePath());
  if (raw === 'act-first' || raw === 'propose-first') return raw;
  return DEFAULT_MODE;
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

function daemonPidPath(): string {
  return join(homedir(), '.baton', 'maestro', 'daemon.pid');
}
function daemonLogPath(): string {
  return join(homedir(), '.baton', 'maestro', 'daemon.log');
}
function maestrodScriptPath(): string {
  return join(maestroStateDir(), '..', 'maestrod.sh');
}
function repoRootForMaestrod(): string {
  // bootstrap-or-tick.sh expects to be invoked from the repo root, so
  // the daemon (which calls into it) needs that cwd too.
  return join(maestroStateDir(), '..', '..', '..', '..');
}

function readDaemonPid(): number | null {
  const pidStr = readTextSafe(daemonPidPath());
  if (!pidStr) return null;
  const pid = Number.parseInt(pidStr, 10);
  return Number.isFinite(pid) && pid > 0 ? pid : null;
}

function isDaemonRunning(): boolean {
  const pid = readDaemonPid();
  if (pid == null) return false;
  try {
    // Signal 0 → liveness probe. ESRCH means the process is gone.
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Spawn maestrod.sh as a fully detached background process so it
 *  survives Electron quit. The daemon writes its own pid file via
 *  the lifecycle trap in maestrod.sh; we just kick it off. Returns
 *  the spawned pid or null if the script is missing / spawn failed. */
function spawnDaemon(): { pid: number | null; reason?: string } {
  const script = maestrodScriptPath();
  if (!existsSync(script)) {
    return { pid: null, reason: `maestrod.sh not found at ${script}` };
  }
  if (isDaemonRunning()) {
    return { pid: readDaemonPid(), reason: 'already running' };
  }
  try {
    mkdirSync(join(daemonPidPath(), '..'), { recursive: true });
  } catch { /* ok */ }
  // Open a log file fd so the daemon's stdout/stderr keep flowing to
  // disk after Electron detaches.
  const logFd = openSync(daemonLogPath(), 'a');
  try {
    const proc = spawn(script, [], {
      detached: true,
      cwd: repoRootForMaestrod(),
      stdio: ['ignore', logFd, logFd],
      env: {
        ...process.env,
        // Inherit usage hints from the renderer's settings later;
        // PoC pulls from main process env or the documented defaults.
        USAGE_5H: process.env.USAGE_5H ?? '0.06',
        USAGE_7D: process.env.USAGE_7D ?? '0.06',
      },
    });
    proc.unref();
    // The daemon writes its OWN pid file; we don't need to. But if
    // the daemon hasn't written it yet by the time the chip polls,
    // the chip would briefly show "off." Write it now so the next
    // getState() sees the correct state immediately.
    if (proc.pid) writeFileSync(daemonPidPath(), String(proc.pid));
    return { pid: proc.pid ?? null };
  } catch (e) {
    return { pid: null, reason: (e as Error).message };
  } finally {
    closeSync(logFd);
  }
}

/** SIGTERM the daemon. The daemon's cleanup trap removes the pid
 *  file. We give up after one signal — the daemon will finish its
 *  current tick, then exit; we don't need to block here. */
function stopDaemon(): { stoppedPid: number | null } {
  const pid = readDaemonPid();
  if (pid == null) return { stoppedPid: null };
  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    // Process already dead; drop the stale pid file.
    try { unlinkSync(daemonPidPath()); } catch { /* fine */ }
    return { stoppedPid: null };
  }
  return { stoppedPid: pid };
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
    mode: readMode(),
    bloatWarning,
    plan: normalizePlan(planDisk),
  };
  cache = { at: now, value };
  return value;
}

/** Active ↔ paused toggle. "Active" means the daemon is running and
 *  ticks are happening on schedule. "Paused" means the daemon is
 *  stopped AND any opportunistic tick (cron, manual call) bails fast.
 *
 *  Going active   → remove paused flag; spawn maestrod.sh if not
 *                    already running.
 *  Going paused   → SIGTERM the daemon and touch the paused flag
 *                    so any external tick caller also short-circuits.
 *
 *  Side effects are best-effort; the function still returns the
 *  resulting paused state so the chip can reconcile. */
export function setMaestroPaused(paused: boolean): { paused: boolean } {
  const p = pausedFlagPath();
  try {
    mkdirSync(join(p, '..'), { recursive: true });
  } catch { /* dir may already exist */ }
  if (paused) {
    stopDaemon();
    if (!existsSync(p)) writeFileSync(p, new Date().toISOString() + '\n');
  } else {
    try { unlinkSync(p); } catch { /* not present, fine */ }
    spawnDaemon();
  }
  cache = null;
  return { paused: existsSync(p) };
}

/** Set Maestro's operating mode (PRD F15.2). Writes the literal mode
 *  string to ~/.baton/maestro/mode. The shell script reads the same
 *  file for `--status` and (eventually) gating execution. */
export function setMaestroMode(mode: Mode): { mode: Mode } {
  const p = modeFilePath();
  try {
    mkdirSync(join(p, '..'), { recursive: true });
  } catch { /* dir may already exist */ }
  writeFileSync(p, mode + '\n');
  cache = null;
  return { mode: readMode() };
}

/** Reconcile what's on disk against what's running. Called once at
 *  app startup so the chip's "active" state matches reality: if the
 *  user's last session ended without explicit pause but the daemon
 *  isn't running (machine reboot, daemon crashed, our test killed it,
 *  whatever), spawn it now.
 *
 *  Conversely, a stale "paused" + a running daemon shouldn't happen —
 *  but if it ever did, we'd kill the daemon to honor the flag.
 *
 *  Best-effort: failures log but don't throw. The PoC is opt-in;
 *  startup should never block on it. */
export function reconcileMaestroOnStartup(): {
  acted: 'spawned' | 'killed' | 'noop';
  reason?: string;
} {
  const stateDir = maestroStateDir();
  // If the PoC isn't checked out (no state dir, no script), do nothing.
  if (!existsSync(stateDir) && !existsSync(maestrodScriptPath())) {
    return { acted: 'noop', reason: 'PoC not installed' };
  }
  const paused = existsSync(pausedFlagPath());
  const running = isDaemonRunning();
  if (!paused && !running) {
    const r = spawnDaemon();
    return r.pid
      ? { acted: 'spawned', reason: `pid=${r.pid}` }
      : { acted: 'noop', reason: r.reason ?? 'spawn failed' };
  }
  if (paused && running) {
    stopDaemon();
    return { acted: 'killed', reason: 'paused flag set' };
  }
  return { acted: 'noop' };
}

/** Test helper: drops the cache so a follow-up call re-reads disk. */
export function _resetMaestroStateCacheForTests(): void {
  cache = null;
}
