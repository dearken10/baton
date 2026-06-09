/**
 * Event bus — emits AppEvents to renderer and persists to SQLite.
 *
 * Per PRD F10.3/F10.4: events have `seq` + `bootId`; single bus, no
 * per-component listeners. Renderer subscribes via `window.baton.onEvent`.
 */

import { BrowserWindow } from 'electron';
import { randomUUID } from 'node:crypto';
import { Channels, type AppEvent } from '../../shared/ipc.js';
import { getDatabase } from '../database/index.js';
import { trace, shortSid } from './statusTrace.js';

let seq = 0;
const bootId = randomUUID();

/**
 * In-process subscribers (e.g. the notifier service) get a copy of
 * every event after it's been persisted and pushed to the renderer.
 * Listeners must not throw — emit() wraps each call in a try/catch.
 */
type Listener = (event: AppEvent) => void;
const listeners = new Set<Listener>();

export function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

// Distributive Omit so the discriminated union survives the strip.
type DistributedOmit<T, K extends PropertyKey> = T extends unknown
  ? Omit<T, K>
  : never;
type EventInit = DistributedOmit<AppEvent, 'seq' | 'bootId' | 'ts'>;

export function emit(initial: EventInit): void {
  const event = {
    ...(initial as object),
    seq: ++seq,
    bootId,
    ts: Date.now(),
  } as AppEvent;

  // Persist (best-effort).
  try {
    const db = getDatabase();
    db.prepare(
      'INSERT INTO events (boot_id, ts, type, session_id, payload) VALUES (?, ?, ?, ?, ?)'
    ).run(
      event.bootId,
      event.ts,
      event.type,
      'sessionId' in event ? event.sessionId : null,
      JSON.stringify(event)
    );
  } catch {
    // never let logging fail the user-facing op
  }

  // Trace status-relevant emits so we can correlate main → renderer.
  // We only log the ones that move the chip; spammy event types (token
  // updates, summarised) would drown the trace.
  if (event.type === 'session.status_changed') {
    const winCount = BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed()).length;
    trace('EMIT_STATUS', {
      sid: shortSid(event.sessionId),
      from: event.from,
      to: event.to,
      seq: event.seq,
      winCount,
    });
  } else if (event.type === 'session.summarized') {
    const winCount = BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed()).length;
    trace('EMIT_SUMMARY', {
      sid: shortSid(event.sessionId),
      summary: event.summary.slice(0, 40).replace(/\s+/g, '_'),
      seq: event.seq,
      winCount,
    });
  } else if (event.type === 'session.refreshed') {
    const winCount = BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed()).length;
    trace('EMIT_REFRESHED', {
      sid: shortSid(event.session.id),
      summary: (event.session.lastSummary ?? '∅').slice(0, 40).replace(/\s+/g, '_'),
      seq: event.seq,
      winCount,
    });
  }

  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(Channels.events, event);
  }

  // Fan out to in-process subscribers last. Wrap each so a buggy
  // listener can never break event delivery for the others.
  for (const listener of listeners) {
    try { listener(event); } catch { /* ignore */ }
  }
}

export function getBootId(): string {
  return bootId;
}
