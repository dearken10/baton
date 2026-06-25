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

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync, unlinkSync, openSync, closeSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { app } from 'electron';

import type { ResponseOf } from '../../shared/ipc.js';
import { batonHome } from '../paths.js';

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
const DEFAULT_IDLE_MIN_MIN = 15;

/** Maestro's per-instance state lives in <batonHome()>/maestro/
 *  alongside daemon.pid and the bloat marker. The PAUSED flag is just
 *  file presence (no content); easy to inspect with `ls` and easy for
 *  the shell tick script to honor without parsing JSON.
 *
 *  Routed through batonHome() so BATON_HOME relocates Maestro too — a
 *  dev build and an installed build can each run their own daemon
 *  without colliding on these flags. */
function maestroDir(): string {
  return join(batonHome(), 'maestro');
}
function pausedFlagPath(): string {
  return join(maestroDir(), 'paused');
}

/** Mode file: contains the literal "propose-first" or "act-first".
 *  Missing or unreadable → DEFAULT_MODE. Same one-line format
 *  bootstrap-or-tick.sh's --mode flag writes. */
function modeFilePath(): string {
  return join(maestroDir(), 'mode');
}

/** Heartbeat path the daemon stats to compute idle time. mtime is the
 *  source of truth; the file body just carries the ISO timestamp for
 *  human inspection (`ls -l` + `cat`). */
function lastActivityPath(): string {
  return join(maestroDir(), 'last-activity');
}

function readMode(): Mode {
  const raw = readTextSafe(modeFilePath());
  if (raw === 'act-first' || raw === 'propose-first') return raw;
  return DEFAULT_MODE;
}

/** Per-instance Maestro tick state — session-id, tick-count,
 *  last-tick.log, last-tick-success, plans/, last-plan.json.
 *
 *  Lives under <batonHome()>/maestro/state so two baton instances on
 *  the same repo checkout (different BATON_HOMEs) don't share their
 *  tick count or session id. Mirrors what bootstrap-or-tick.sh sets
 *  STATE_DIR to. */
function maestroStateDir(): string {
  return join(maestroDir(), 'state');
}

/** Repo dir where the PoC scripts (maestrod.sh + bootstrap-or-tick.sh)
 *  live. Separate from maestroStateDir — scripts are code (per repo
 *  checkout), state is data (per BATON_HOME). Resolved via the
 *  Electron app path. */
function maestrodScriptDir(): string {
  const appPath = app.getAppPath();
  const repoRoot = join(appPath, '..');
  return join(repoRoot, 'poc', 'maestro', 'option3-master-session');
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

function readIdleThresholdMin(): number {
  const env = process.env.MAESTRO_IDLE_MIN_MIN;
  const n = env ? Number.parseInt(env, 10) : NaN;
  if (Number.isFinite(n) && n > 0) return n;
  return DEFAULT_IDLE_MIN_MIN;
}

function daemonPidPath(): string {
  return join(maestroDir(), 'daemon.pid');
}
function daemonLogPath(): string {
  return join(maestroDir(), 'daemon.log');
}
function maestrodScriptPath(): string {
  return join(maestrodScriptDir(), 'maestrod.sh');
}
function repoRootForMaestrod(): string {
  // bootstrap-or-tick.sh expects to be invoked from the repo root, so
  // the daemon (which calls into it) needs that cwd too.
  return join(maestrodScriptDir(), '..', '..', '..');
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
    // IMPORTANT: do NOT pre-write proc.pid to the daemon pid file.
    // The daemon's own duplicate-instance guard reads that file,
    // checks `kill -0 <pid>`, and if it succeeds bails with
    // "refusing to start: daemon already running." Pre-writing
    // means the daemon mistakes its OWN pid for a rival's and
    // suicides on startup. Let the daemon's lifecycle trap write
    // the pid itself (which it does as its first action). The
    // chip's 5 s poll will pick it up within a tick or two.
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

  const sessionId = readTextSafe(join(stateDir, 'session-id'));
  const tickCountStr = readTextSafe(join(stateDir, 'tick-count'));
  const tickCount = tickCountStr ? Number.parseInt(tickCountStr, 10) : 0;
  // "Installed" = the PoC scripts are present in the repo. State dir
  // may be empty on first launch under a fresh BATON_HOME.
  const installed = existsSync(maestrodScriptPath());
  const bloatWarning = existsSync(join(stateDir, 'bloat-warning'));

  const lastTickAt = fileMtimeIso(join(stateDir, 'last-tick.log'));
  const tickIntervalMin = readIntervalMin();
  const idleThresholdMin = readIdleThresholdMin();
  const nextTickEtaAt = lastTickAt
    ? new Date(Date.parse(lastTickAt) + tickIntervalMin * 60_000).toISOString()
    : null;

  // Read the heartbeat file's mtime (the daemon's idle gate uses the
  // same value). When absent return null; the renderer falls back to
  // its own local activity tracker.
  let lastActivityAt: number | null = null;
  try {
    if (existsSync(lastActivityPath())) {
      lastActivityAt = Math.floor(statSync(lastActivityPath()).mtimeMs);
    }
  } catch { /* ignore */ }

  const planDisk = readJsonSafe<PlanFromDisk>(
    join(stateDir, 'last-plan.json')
  );

  const value: State = {
    installed,
    sessionId,
    tickCount: Number.isFinite(tickCount) ? tickCount : 0,
    lastTickAt,
    nextTickEtaAt,
    tickIntervalMin,
    idleThresholdMin,
    lastActivityAt,
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
  // If the PoC scripts aren't checked out, do nothing — the state
  // dir under BATON_HOME is created lazily by the scripts themselves.
  if (!existsSync(maestrodScriptPath())) {
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

/** Renderer heartbeat. Stamps ~/.baton/maestro/last-activity with the
 *  current time so the daemon's idle gate (mtime-based) sees a recent
 *  value. Throttled in the renderer to ~5 s; we still write on every
 *  call here because the cost is just a touch + brief file write.
 *
 *  We don't invalidate the state cache — the chip's lastActivityAt is
 *  read from disk on the next 5-s poll, which is plenty fresh given
 *  the 15-min idle threshold. */
export function reportMaestroActivity(atMs: number): { ok: true } {
  const p = lastActivityPath();
  try {
    mkdirSync(join(p, '..'), { recursive: true });
  } catch { /* ok */ }
  try {
    // Write the ISO string so a sysadmin can `cat` the file and see
    // when the UI last reported activity. The daemon only stats it.
    writeFileSync(p, new Date(atMs).toISOString() + '\n');
    // Force mtime to the renderer-supplied value so a slow disk +
    // chip-supplied client clock stay aligned. The daemon's idle
    // calc subtracts mtime from `date +%s`.
    const secs = atMs / 1000;
    utimesSync(p, secs, secs);
  } catch { /* best-effort */ }
  return { ok: true as const };
}

/** Hard cap on how long we'll wait for the tick to complete before
 *  resolving the IPC anyway. The tick is still detached so it keeps
 *  running past this — we just stop blocking the renderer. A real
 *  Maestro tick is 30 s–2 min; 10 min is a generous "definitely
 *  something went wrong" threshold. */
const RUN_NOW_MAX_WAIT_MS = 10 * 60_000;

/** "Run now" — fire a one-shot tick that bypasses the idle gate.
 *
 *  Spawns bootstrap-or-tick.sh --force as a detached child (survives
 *  Electron quit) but the main process keeps a handle on it and
 *  awaits exit, so the renderer's "Running…" spinner can run until
 *  the tick actually finishes. `detached: true` makes the child a
 *  process-group leader; we deliberately do NOT `unref()` so the
 *  parent's event loop holds the wait until exit. */
export function runMaestroNow(): Promise<{ ok: boolean; reason: string | null }> {
  const script = join(maestrodScriptDir(), 'bootstrap-or-tick.sh');
  if (!existsSync(script)) {
    return Promise.resolve({ ok: false, reason: `bootstrap-or-tick.sh not found at ${script}` });
  }
  if (existsSync(pausedFlagPath())) {
    return Promise.resolve({ ok: false, reason: 'Maestro is paused — resume before running' });
  }

  return new Promise((resolve) => {
    const logFd = openSync(daemonLogPath(), 'a');
    let proc;
    try {
      proc = spawn(script, ['--force'], {
        detached: true,
        cwd: repoRootForMaestrod(),
        stdio: ['ignore', logFd, logFd],
        env: {
          ...process.env,
          MAESTRO_IDLE_MIN_MIN: String(readIdleThresholdMin()),
          USAGE_5H: process.env.USAGE_5H ?? '0.06',
          USAGE_7D: process.env.USAGE_7D ?? '0.06',
        },
      });
    } catch (e) {
      closeSync(logFd);
      resolve({ ok: false, reason: (e as Error).message });
      return;
    }

    let settled = false;
    const finish = (result: { ok: boolean; reason: string | null }): void => {
      if (settled) return;
      settled = true;
      try { closeSync(logFd); } catch { /* already closed */ }
      resolve(result);
    };

    // Safety net so the renderer's spinner never hangs forever on a
    // wedged tick. The detached child keeps running past this; the
    // user can refresh the view manually to pick up the eventual plan.
    const timer = setTimeout(() => {
      finish({ ok: true, reason: 'still running after 10m — refresh manually for the result' });
    }, RUN_NOW_MAX_WAIT_MS);
    timer.unref();

    proc.once('error', (err) => {
      clearTimeout(timer);
      finish({ ok: false, reason: err.message });
    });
    proc.once('exit', (code, signal) => {
      clearTimeout(timer);
      if (code === 0) {
        finish({ ok: true, reason: null });
      } else if (signal) {
        finish({ ok: false, reason: `killed by ${signal}` });
      } else {
        finish({ ok: false, reason: `tick exited ${code}` });
      }
    });
  });
}

/** Test helper: drops the cache so a follow-up call re-reads disk. */
export function _resetMaestroStateCacheForTests(): void {
  cache = null;
}
