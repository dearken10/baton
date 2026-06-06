/**
 * Event bus — emits AppEvents to renderer and persists to SQLite.
 *
 * Per PRD F10.3/F10.4: events have `seq` + `bootId`; single bus, no
 * per-component listeners. Renderer subscribes via `window.code24.onEvent`.
 */

import { BrowserWindow } from 'electron';
import { randomUUID } from 'node:crypto';
import { Channels, type AppEvent } from '../../shared/ipc.js';
import { getDatabase } from '../database/index.js';

let seq = 0;
const bootId = randomUUID();

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

  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(Channels.events, event);
  }
}

export function getBootId(): string {
  return bootId;
}
