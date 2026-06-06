/**
 * Control-channel IPC bus.
 *
 * Single registration point for every control verb (PRD F10.1).
 * Each handler is wrapped with Zod parse-on-input + parse-on-output
 * so a renderer error or a main-side bug is surfaced as a typed
 * Error, never an unhandled crash (NF8: fail-closed for IPC schema
 * violations).
 *
 * High-rate `pty.data` does NOT come through this bus — it has its
 * own channel (PRD F10.2). See SessionManager.
 */

import { app, BrowserWindow, dialog, ipcMain } from 'electron';
import { z } from 'zod';

import {
  Channels,
  ControlVerbs,
  type ControlVerb,
  type RequestOf,
  type ResponseOf,
} from '../../shared/ipc.js';
import { addProject, listProjects, getProject } from '../services/projectStore.js';
import { getSessionManager } from '../services/sessionManager.js';

type Handler<V extends ControlVerb> = (
  req: RequestOf<V>
) => Promise<ResponseOf<V>> | ResponseOf<V>;

const handlers: { [V in ControlVerb]?: Handler<V> } = {
  'app.ping': () => ({ ok: true as const, ts: Date.now() }),
  'app.meta': () => ({
    version: app.getVersion(),
    electron: process.versions.electron ?? '',
    node: process.versions.node,
    platform: process.platform,
  }),

  'project.pickFolder': async () => {
    const focused = BrowserWindow.getFocusedWindow();
    const res = await dialog.showOpenDialog(focused ?? new BrowserWindow({ show: false }), {
      title: 'Add a project folder',
      properties: ['openDirectory', 'createDirectory'],
    });
    if (res.canceled || res.filePaths.length === 0) return { path: null };
    return { path: res.filePaths[0] ?? null };
  },
  'project.add': (req) => ({ project: addProject(req.path) }),
  'project.list': () => ({ projects: listProjects() }),

  'session.list': () => ({ sessions: getSessionManager().list() }),
  'session.spawn': async (req) => {
    const project = getProject(req.projectId);
    if (!project) throw new Error(`Unknown project: ${req.projectId}`);
    const session = await getSessionManager().spawn({
      projectId: project.id,
      backendId: req.backendId,
      cwd: project.path,
    });
    return { session };
  },
  'session.kill': async (req) => {
    await getSessionManager().kill(req.sessionId);
    return { ok: true as const };
  },

  'pty.write': (req) => {
    const bytes = Buffer.from(req.data, 'base64').toString('utf-8');
    getSessionManager().write(req.sessionId, bytes);
    return {};
  },
  'pty.resize': (req) => {
    getSessionManager().resize(req.sessionId, req.cols, req.rows);
    return {};
  },
};

export function registerControlBus(): void {
  ipcMain.handle(
    Channels.control,
    async (_event, verb: unknown, payload: unknown) => {
      const verbName = z
        .enum(Object.keys(ControlVerbs) as [ControlVerb, ...ControlVerb[]])
        .safeParse(verb);
      if (!verbName.success) {
        throw new Error(`IPC: unknown verb "${String(verb)}"`);
      }
      const v = verbName.data;

      const reqSchema = ControlVerbs[v].request;
      const reqParsed = reqSchema.safeParse(payload);
      if (!reqParsed.success) {
        throw new Error(`IPC: bad request for "${v}": ${reqParsed.error.message}`);
      }

      const handler = handlers[v];
      if (!handler) {
        throw new Error(`IPC: no handler registered for "${v}"`);
      }

      const raw = await handler(reqParsed.data as never);

      const respSchema = ControlVerbs[v].response;
      const respParsed = respSchema.safeParse(raw);
      if (!respParsed.success) {
        throw new Error(`IPC: bad response from "${v}": ${respParsed.error.message}`);
      }
      return respParsed.data;
    }
  );
}
