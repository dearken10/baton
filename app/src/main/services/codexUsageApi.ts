/**
 * Codex plan-utilisation reader.
 *
 * Same indicator shape as `claudeUsageApi.ts` (fiveH / sevenD windows
 * with utilisation 0..100 + resetsAt), but the source is different:
 * Codex doesn't expose a separate usage endpoint. Instead, the CLI
 * emits a `token_count` event into its rollout JSONL on every turn,
 * with a `rate_limits` block when the model provider returns one.
 *
 * Approach (verified against Nimbalyst's bundled implementation):
 *   - Walk `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` newest-first.
 *   - Read each file bottom-up looking for an `event_msg` with
 *     `payload.type === 'token_count'` and a non-null `rate_limits.primary`.
 *   - First match wins. Convert primary → fiveH, secondary → sevenD.
 *
 * Caching: 60-second in-process cache. The data only changes when
 * Codex finishes a turn, so polling more often than that just hammers
 * the disk for no new value.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const CACHE_TTL_MS = 60 * 1000;
/** Walk back this many days before giving up. Two weeks covers
 *  "yesterday's session" without scanning the whole tree on cold
 *  starts. */
const MAX_DAYS_BACK = 14;
/** Max rollout files to read in one refresh. Each read is bounded by
 *  fs.readFileSync — cap to keep cold-start IO predictable on a busy
 *  user's machine. */
const MAX_FILES_PER_REFRESH = 8;

export interface UsageWindow {
  /** 0..100 = % of plan used. Codex reports as integer percent. */
  utilization: number;
  /** ISO-8601 string. Null when the rate_limits block omits a reset. */
  resetsAt: string | null;
}

export interface CodexUsageResponse {
  fiveH: UsageWindow;
  sevenD: UsageWindow;
  /** Codex has no Opus equivalent; field is here so the response shape
   *  matches `claudeUsageApi.UsageResponse` 1:1 (renderer reuses it). */
  sevenDOpus: UsageWindow | null;
  lastUpdated: number;
  /** Set when no rollout with usable rate_limits was found, or on IO
   *  errors. Renderer hides the chip when present and `fiveH` /
   *  `sevenD` are both zero. */
  error: string | null;
}

interface RateLimitWindow {
  used_percent?: number;
  resets_at?: number; // unix seconds
}
interface RateLimits {
  primary?: RateLimitWindow | null;
  secondary?: RateLimitWindow | null;
}
interface TokenCountPayload {
  type?: string;
  rate_limits?: RateLimits;
}
interface RolloutEvent {
  type?: string;
  payload?: TokenCountPayload;
}

const EMPTY_WINDOW: UsageWindow = { utilization: 0, resetsAt: null };

let cache: CodexUsageResponse | null = null;

function codexSessionsRoot(): string {
  return process.env['CODEX_HOME']
    ? path.join(process.env['CODEX_HOME'] as string, 'sessions')
    : path.join(os.homedir(), '.codex', 'sessions');
}

/** Iterate rollout file paths newest-first across the last
 *  MAX_DAYS_BACK days. Stops after MAX_FILES_PER_REFRESH yields. */
function* recentRolloutFiles(): Iterable<string> {
  const root = codexSessionsRoot();
  let yielded = 0;
  const today = new Date();
  for (let i = 0; i < MAX_DAYS_BACK; i++) {
    if (yielded >= MAX_FILES_PER_REFRESH) return;
    const d = new Date(today);
    d.setUTCDate(d.getUTCDate() - i);
    const yyyy = String(d.getUTCFullYear());
    const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(d.getUTCDate()).padStart(2, '0');
    const dir = path.join(root, yyyy, mm, dd);
    let entries: string[];
    try { entries = fs.readdirSync(dir); }
    catch { continue; }
    // Within one day, prefer newer files: filename has the ISO
    // timestamp so a lexical reverse sort gets us newest-first.
    const rollouts = entries
      .filter((n) => n.startsWith('rollout-') && n.endsWith('.jsonl'))
      .sort()
      .reverse();
    for (const name of rollouts) {
      yield path.join(dir, name);
      yielded++;
      if (yielded >= MAX_FILES_PER_REFRESH) return;
    }
  }
}

/** Read the file bottom-up. Return the rate_limits of the most
 *  recent `token_count` event whose `primary` is non-null, or null. */
function extractRateLimitsFromFile(filePath: string): RateLimits | null {
  let raw: string;
  try { raw = fs.readFileSync(filePath, 'utf-8'); }
  catch { return null; }
  const lines = raw.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line) continue;
    // Cheap pre-filter: skip lines that can't possibly be a
    // token_count event. Saves a JSON.parse per non-matching line.
    if (!line.includes('"token_count"')) continue;
    let obj: RolloutEvent;
    try { obj = JSON.parse(line) as RolloutEvent; } catch { continue; }
    if (obj.type !== 'event_msg') continue;
    if (obj.payload?.type !== 'token_count') continue;
    const rl = obj.payload.rate_limits;
    if (!rl?.primary) continue;
    return rl;
  }
  return null;
}

function toWindow(w: RateLimitWindow | null | undefined): UsageWindow {
  if (!w) return EMPTY_WINDOW;
  return {
    utilization: typeof w.used_percent === 'number' ? w.used_percent : 0,
    resetsAt: typeof w.resets_at === 'number'
      ? new Date(w.resets_at * 1000).toISOString()
      : null,
  };
}

function refresh(): CodexUsageResponse {
  let rateLimits: RateLimits | null = null;
  let filesScanned = 0;
  try {
    for (const filePath of recentRolloutFiles()) {
      filesScanned++;
      const found = extractRateLimitsFromFile(filePath);
      if (found) { rateLimits = found; break; }
    }
  } catch (err) {
    return {
      fiveH: EMPTY_WINDOW,
      sevenD: EMPTY_WINDOW,
      sevenDOpus: null,
      lastUpdated: Date.now(),
      error: err instanceof Error ? err.message : String(err),
    };
  }
  if (!rateLimits) {
    return {
      fiveH: EMPTY_WINDOW,
      sevenD: EMPTY_WINDOW,
      sevenDOpus: null,
      lastUpdated: Date.now(),
      error: filesScanned === 0
        ? 'No Codex sessions found.'
        : 'No rate_limits recorded yet — submit a Codex prompt to populate.',
    };
  }
  return {
    fiveH: toWindow(rateLimits.primary),
    sevenD: toWindow(rateLimits.secondary),
    sevenDOpus: null,
    lastUpdated: Date.now(),
    error: null,
  };
}

/** Fetch the user's current Codex plan utilisation. Cached for
 *  CACHE_TTL_MS unless `force: true`. */
export function getCodexUsage(opts: { force?: boolean } = {}): CodexUsageResponse {
  if (!opts.force && cache && Date.now() - cache.lastUpdated < CACHE_TTL_MS) {
    return cache;
  }
  cache = refresh();
  return cache;
}
