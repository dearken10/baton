/**
 * Status-transition trace log.
 *
 * Writes one line per event to ~/.baton/logs/status-trace.log so we can
 * post-mortem "why did the chip stay running" bugs. Format is a single
 * grep-friendly line per event:
 *
 *   <ISO-ts> <CATEGORY> sid=<short> key=value key=value
 *
 * Categories (all uppercase, fixed width helps `cut`/`awk`):
 *   HOOK_RECV       Raw hook event arrived on the unix socket.
 *   HOOK_PARSE_ERR  Hook line couldn't be parsed.
 *   HOOK_DISPATCH   sessionManager.handleHookEvent received the event.
 *   HOOK_NO_LIVE    handleHookEvent dropped the event (no live session).
 *   SET_STATUS      sessionManager.setStatus was called (incl. no-ops).
 *   EMIT_STATUS     eventBus emitted session.status_changed.
 *   IDLE_SWEEP      Periodic sweeper tick fired.
 *   IDLE_PAUSED     A session was demoted idle → paused by the sweeper.
 *   SPAWN           A new session was spawned (status starts at running).
 *   EXIT            Pty exited; markExited was called.
 *
 * The log rolls when it grows past 5 MB: the existing file becomes
 * status-trace.log.1 (overwriting any prior .1), and a fresh file is
 * started. One generation is enough — long-running sessions don't keep
 * an unbounded history, and the user is usually debugging the *recent*
 * past anyway. Best-effort: any IO failure is swallowed so a broken
 * disk never blocks a status transition.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { batonHome } from '../paths.js';

const MAX_BYTES = 5 * 1024 * 1024;

let logPath: string | null = null;
let initialized = false;

function init(): void {
  if (initialized) return;
  initialized = true;
  try {
    const dir = path.join(batonHome(), 'logs');
    fs.mkdirSync(dir, { recursive: true });
    logPath = path.join(dir, 'status-trace.log');
  } catch {
    logPath = null;
  }
}

function rollIfNeeded(): void {
  if (!logPath) return;
  try {
    const st = fs.statSync(logPath);
    if (st.size < MAX_BYTES) return;
    const rolled = logPath + '.1';
    try { fs.unlinkSync(rolled); } catch { /* no prior generation */ }
    fs.renameSync(logPath, rolled);
  } catch {
    // file doesn't exist yet, or stat failed — nothing to roll.
  }
}

/** Truncate a session id to its first 8 chars for log readability. */
export function shortSid(sessionId: string | undefined | null): string {
  if (!sessionId) return '∅';
  return sessionId.slice(0, 8);
}

/** Lazily-initialised file path. Useful for telling the user where the
 *  log lives. */
export function statusTracePath(): string | null {
  init();
  return logPath;
}

/** Emit one line. `kv` becomes `k=v k=v ...` — values are stringified
 *  with no escaping (don't pass newlines or spaces). */
export function trace(
  category: string,
  kv: Record<string, string | number | boolean | null | undefined>,
): void {
  init();
  if (!logPath) return;
  try {
    const ts = new Date().toISOString();
    const parts: string[] = [];
    for (const [k, v] of Object.entries(kv)) {
      if (v === undefined) continue;
      parts.push(`${k}=${v === null ? '∅' : String(v)}`);
    }
    const line = `${ts} ${category} ${parts.join(' ')}\n`;
    rollIfNeeded();
    fs.appendFileSync(logPath, line);
  } catch {
    // best-effort
  }
}
