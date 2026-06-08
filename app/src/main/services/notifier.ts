/**
 * Notifier — turns session.status_changed events into native macOS
 * notifications and a dock-badge unread count. Implements the v1
 * slice of PRD F9 (F9.1 + F9.2). F9.3 (in-app history), F9.4 (sound
 * config), F9.5 (composable Effects struct) are deferred.
 *
 * Rules:
 *   - Notify on transition INTO `needs-input` or `errored` only.
 *   - Don't notify if the window is focused AND that session is the
 *     selected one — the user can see the chip flip already.
 *   - Maintain `unread`: the set of sessionIds currently in
 *     needs-input/errored. Badge = unread.size. Auto-clears when the
 *     agent transitions out (e.g., user replied, status → running).
 *   - Notification click → focus window + tell renderer to select.
 */

import { app, BrowserWindow, Notification } from 'electron';
import { Channels, type AppEvent } from '../../shared/ipc.js';
import { subscribe } from './eventBus.js';
import { getDatabase } from '../database/index.js';

interface SessionContext {
  branch: string;
  projectName: string;
}

const unread = new Set<string>();
let selectedSessionId: string | null = null;

/** Renderer tells us which session is in focus so we can suppress
 *  redundant pop-ups. Called from the IPC bus. */
export function setSelectedSession(sessionId: string | null): void {
  selectedSessionId = sessionId;
  // If the user is now looking at this session, clear its unread flag.
  if (sessionId && unread.delete(sessionId)) refreshBadge();
}

/** Start listening. Returns the unsubscribe fn (used in tests). */
export function startNotifier(): () => void {
  const off = subscribe(onEvent);
  return () => {
    off();
    unread.clear();
    refreshBadge();
  };
}

function onEvent(event: AppEvent): void {
  if (event.type !== 'session.status_changed') return;
  const sessionId = event.sessionId;
  const isAttention = event.to === 'needs-input' || event.to === 'errored';
  const wasAttention = event.from === 'needs-input' || event.from === 'errored';

  if (isAttention) {
    // Transitioned INTO an attention state. Add to unread + maybe ping.
    if (!unread.has(sessionId)) {
      unread.add(sessionId);
      refreshBadge();
    }
    maybeNotify(event, sessionId);
  } else if (wasAttention) {
    // Transitioned OUT of attention. Clear unread + badge.
    if (unread.delete(sessionId)) refreshBadge();
  }
}

function maybeNotify(event: AppEvent, sessionId: string): void {
  // Suppress if the window is focused AND the user is already looking
  // at this session — no point pinging when the chip is visible.
  const win = BrowserWindow.getAllWindows()[0];
  const isVisible =
    !!win && !win.isDestroyed() && win.isFocused() && selectedSessionId === sessionId;
  if (isVisible) return;

  if (!Notification.isSupported()) return;

  const ctx = readContext(sessionId);
  if (!ctx) return;

  const reason =
    event.type === 'session.status_changed' && event.to === 'errored'
      ? 'session errored'
      : 'needs your input';
  const title = `baton · ${ctx.projectName}`;
  const body = `${ctx.branch} — ${reason}`;

  const n = new Notification({ title, body, silent: false });
  n.on('click', () => focusSession(sessionId));
  n.show();
}

function refreshBadge(): void {
  // app.dock is mac-only; on other platforms this is a no-op.
  if (app.dock && typeof app.dock.setBadge === 'function') {
    app.dock.setBadge(unread.size > 0 ? String(unread.size) : '');
  }
}

function focusSession(sessionId: string): void {
  const win = BrowserWindow.getAllWindows()[0];
  if (!win || win.isDestroyed()) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
  win.webContents.send(Channels.selectSession, { sessionId });
}

/** Look up the session's branch + project name for the notification body.
 *  Read straight from SQLite — we don't want to depend on the live
 *  SessionManager state, which might not have the row in memory. */
function readContext(sessionId: string): SessionContext | null {
  try {
    const row = getDatabase()
      .prepare(
        `SELECT s.branch AS branch, p.name AS project_name
           FROM sessions s
           JOIN projects p ON p.id = s.project_id
          WHERE s.id = ?`
      )
      .get(sessionId) as { branch: string; project_name: string } | undefined;
    if (!row) return null;
    return { branch: row.branch, projectName: row.project_name };
  } catch {
    return null;
  }
}
