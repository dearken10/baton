/**
 * Preload — the only surface the renderer can touch in main.
 *
 * Per PRD NF6: `contextIsolation: true` means anything we want the
 * renderer to call goes through `contextBridge.exposeInMainWorld`.
 * No raw `ipcRenderer` in the renderer code.
 */

import { contextBridge, ipcRenderer, webUtils } from 'electron';
import {
  Channels,
  type ControlVerb,
  type RequestOf,
  type ResponseOf,
  type PtyDataFrame,
  type AppEvent,
} from '../shared/ipc.js';

// Every live TerminalPane adds a `baton:pty.data` listener and every
// mounted screen adds a `baton:events` listener. Node's default cap of
// 10 trips a MaxListenersExceededWarning once the user has ~8+ sessions
// open — which is well within normal use. Raise the limit so legitimate
// fan-out doesn't look like a leak. If we ever DO leak, the symptom
// will be OOM, not this warning.
ipcRenderer.setMaxListeners(64);

const api = {
  /** Typed call to a control verb. Renderer code never touches a raw channel name. */
  call<V extends ControlVerb>(verb: V, payload: RequestOf<V>): Promise<ResponseOf<V>> {
    return ipcRenderer.invoke(Channels.control, verb, payload);
  },

  /** Subscribe to the high-rate pty stream. */
  onPtyData(handler: (frame: PtyDataFrame) => void): () => void {
    const listener = (_event: unknown, frame: PtyDataFrame): void => handler(frame);
    ipcRenderer.on(Channels.ptyData, listener);
    return (): void => {
      ipcRenderer.removeListener(Channels.ptyData, listener);
    };
  },

  /** Subscribe to the typed event stream. */
  onEvent(handler: (event: AppEvent) => void): () => void {
    const listener = (_event: unknown, e: AppEvent): void => handler(e);
    ipcRenderer.on(Channels.events, listener);
    return (): void => {
      ipcRenderer.removeListener(Channels.events, listener);
    };
  },

  /** Resolve a drag-and-dropped `File` to its absolute filesystem
   *  path. Electron 32 removed renderer-side `File.path`; the only
   *  supported way to get the path is `webUtils.getPathForFile`
   *  from the preload. Returns '' if the file has no on-disk path
   *  (e.g. a drag of an in-memory blob). */
  getPathForFile(file: File): string {
    try { return webUtils.getPathForFile(file); }
    catch { return ''; }
  },

  /** Main asks the renderer to select a session (e.g. user clicked a
   *  desktop notification). Carries `{ sessionId }`. */
  onSelectSession(handler: (payload: { sessionId: string }) => void): () => void {
    const listener = (_event: unknown, p: { sessionId: string }): void => handler(p);
    ipcRenderer.on(Channels.selectSession, listener);
    return (): void => {
      ipcRenderer.removeListener(Channels.selectSession, listener);
    };
  },
};

contextBridge.exposeInMainWorld('baton', api);

export type BatonApi = typeof api;
