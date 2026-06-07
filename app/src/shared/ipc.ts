/**
 * IPC contract between main and renderer.
 *
 * Per PRD F10.1: single internal IPC channel; every verb has a Zod
 * schema; CI compares snapshots, fails on drift. This file is the
 * source of truth — both main handlers and renderer callers import
 * from here.
 *
 * Per PRD F10.2: `pty.data` lives on its own channel (`Channels.ptyData`)
 * so high-rate terminal data cannot starve control verbs. Control
 * verbs run on `Channels.control`.
 */

import { z } from 'zod';

/* ────────────────────────────────────────────────────────────────
 * Common primitives
 * ──────────────────────────────────────────────────────────────── */

export const SessionId = z.string().uuid();
export type SessionId = z.infer<typeof SessionId>;

export const ProjectId = z.string().min(1);
export type ProjectId = z.infer<typeof ProjectId>;

export const SessionStatus = z.enum([
  'running',
  'needs-input',
  'idle',
  'done',
  'errored',
  'paused',
  'disconnected', // Remote SSH only — F14.8
]);
export type SessionStatus = z.infer<typeof SessionStatus>;

export const AgentBackendId = z.enum(['claude-code', 'codex', 'mock']);
export type AgentBackendId = z.infer<typeof AgentBackendId>;

export const Project = z.object({
  id: ProjectId,
  path: z.string(),
  name: z.string(),
  addedAt: z.number(),
});
export type Project = z.infer<typeof Project>;

export const Session = z.object({
  id: SessionId,
  projectId: ProjectId,
  backendId: AgentBackendId,
  branch: z.string(),
  worktreePath: z.string(),
  status: SessionStatus,
  startedAt: z.number(),
  endedAt: z.number().nullable(),
  tokensIn: z.number(),
  tokensOut: z.number(),
  lastSummary: z.string().nullable(),
  /** Claude's internal session id (captured from SessionStart hook). */
  claudeSessionId: z.string().nullable(),
});
export type Session = z.infer<typeof Session>;

/* ────────────────────────────────────────────────────────────────
 * Control-channel verbs (request/response)
 * ──────────────────────────────────────────────────────────────── */

const Empty = z.object({});

const PingResponse = z.object({ ok: z.literal(true), ts: z.number() });
const AppMetaResponse = z.object({
  version: z.string(),
  electron: z.string(),
  node: z.string(),
  platform: z.string(),
});

const ProjectAddRequest = z.object({ path: z.string().min(1) });
const ProjectAddResponse = z.object({ project: Project });
const ProjectListResponse = z.object({ projects: z.array(Project) });
const ProjectPickResponse = z.object({ path: z.string().nullable() });

const SessionListResponse = z.object({ sessions: z.array(Session) });
const SessionSpawnRequest = z.object({
  projectId: ProjectId,
  backendId: AgentBackendId.default('claude-code'),
  /** When set, create a fresh git worktree at this branch first and
   *  spawn the agent inside it. When omitted, spawn in the project
   *  root (sessions share a working tree, F2.2 default off). */
  newWorktreeBranch: z.string().optional(),
});
const SessionSpawnResponse = z.object({ session: Session });
const SessionKillRequest = z.object({ sessionId: SessionId });
const SessionKillResponse = z.object({ ok: z.literal(true) });

const SessionResumeRequest = z.object({ sessionId: SessionId });
const SessionResumeResponse = z.object({ session: Session });

const PtyWriteRequest = z.object({
  sessionId: SessionId,
  // base64-encoded bytes — see PtyDataFrame for the symmetric inbound type.
  data: z.string(),
});
const PtyResizeRequest = z.object({
  sessionId: SessionId,
  cols: z.number().int().positive(),
  rows: z.number().int().positive(),
});

export const ControlVerbs = {
  'app.ping': { request: Empty, response: PingResponse },
  'app.meta': { request: Empty, response: AppMetaResponse },

  'project.pickFolder': { request: Empty, response: ProjectPickResponse },
  'project.add':        { request: ProjectAddRequest, response: ProjectAddResponse },
  'project.list':       { request: Empty, response: ProjectListResponse },

  'session.list':   { request: Empty, response: SessionListResponse },
  'session.spawn':  { request: SessionSpawnRequest, response: SessionSpawnResponse },
  'session.kill':   { request: SessionKillRequest, response: SessionKillResponse },
  'session.resume': { request: SessionResumeRequest, response: SessionResumeResponse },

  'pty.write':  { request: PtyWriteRequest, response: Empty },
  'pty.resize': { request: PtyResizeRequest, response: Empty },
} as const;

export type ControlVerb = keyof typeof ControlVerbs;
export type RequestOf<V extends ControlVerb> = z.infer<(typeof ControlVerbs)[V]['request']>;
export type ResponseOf<V extends ControlVerb> = z.infer<(typeof ControlVerbs)[V]['response']>;

// Backwards-compat exports used by the smoke test
export const PingRequest = Empty;
export { PingResponse, AppMetaResponse, SessionListResponse };
export const SessionListRequest = Empty;

/* ────────────────────────────────────────────────────────────────
 * Event-stream events (push from main → renderer)
 * ──────────────────────────────────────────────────────────────── */

const EventEnvelope = z.object({
  seq: z.number().int().nonnegative(),
  bootId: z.string().uuid(),
  ts: z.number(),
});

const ProjectAddedEvent = EventEnvelope.extend({
  type: z.literal('project.added'),
  project: Project,
});

const SessionSpawnedEvent = EventEnvelope.extend({
  type: z.literal('session.spawned'),
  session: Session,
});

const SessionStatusChangedEvent = EventEnvelope.extend({
  type: z.literal('session.status_changed'),
  sessionId: SessionId,
  from: SessionStatus,
  to: SessionStatus,
});

const SessionSummarizedEvent = EventEnvelope.extend({
  type: z.literal('session.summarized'),
  sessionId: SessionId,
  summary: z.string(),
});

const SessionExitedEvent = EventEnvelope.extend({
  type: z.literal('session.exited'),
  sessionId: SessionId,
  exitCode: z.number().nullable(),
});

export const AppEvent = z.discriminatedUnion('type', [
  ProjectAddedEvent,
  SessionSpawnedEvent,
  SessionStatusChangedEvent,
  SessionSummarizedEvent,
  SessionExitedEvent,
]);
export type AppEvent = z.infer<typeof AppEvent>;

/* ────────────────────────────────────────────────────────────────
 * PTY channel — separate from control. Plain bytes; no Zod parse
 * on the hot path (perf budget, F10.2).
 * ──────────────────────────────────────────────────────────────── */

export const PtyDataFrame = z.object({
  sessionId: SessionId,
  data: z.string(), // base64
});
export type PtyDataFrame = z.infer<typeof PtyDataFrame>;

/* ────────────────────────────────────────────────────────────────
 * Channel names — string constants used by ipcMain/ipcRenderer.
 * ──────────────────────────────────────────────────────────────── */

export const Channels = {
  control: 'code24:control',
  ptyData: 'code24:pty.data',
  events:  'code24:events',
} as const;
