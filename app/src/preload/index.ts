/**
 * Preload — the only surface the renderer can touch in main.
 *
 * Per PRD NF6: `contextIsolation: true` means anything we want the
 * renderer to call goes through `contextBridge.exposeInMainWorld`.
 * No raw `ipcRenderer` in the renderer code.
 */

import { contextBridge, ipcRenderer } from 'electron';
import {
  Channels,
  type ControlVerb,
  type RequestOf,
  type ResponseOf,
  type PtyDataFrame,
  type AppEvent,
} from '../shared/ipc.js';

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
};

contextBridge.exposeInMainWorld('code24', api);

export type Code24Api = typeof api;
