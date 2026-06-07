/**
 * Zustand session/project store.
 *
 * Per PRD F10.4 + Reviewer P0: subscribe via selectors only.
 * Selectors returning fresh Array/Object refs MUST be derived via
 * useMemo at the consumer (see selectAllSessions comment).
 */

import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';
import type {
  AppEvent,
  Project,
  Session,
  SessionStatus,
} from '@shared/ipc.js';

export interface AppState {
  bootStartedAt: number;
  projects: Record<string, Project>;
  sessions: Record<string, Session>;
  selectedSessionId: string | null;

  loadProjects(projects: Project[]): void;
  loadSessions(sessions: Session[]): void;
  ingestEvent(event: AppEvent): void;
  selectSession(sessionId: string | null): void;
}

export const useAppStore = create<AppState>()(
  immer((set) => ({
    bootStartedAt: Date.now(),
    projects: {},
    sessions: {},
    selectedSessionId: null,

    loadProjects: (projects) =>
      set((s) => {
        s.projects = {};
        for (const p of projects) s.projects[p.id] = p;
      }),

    loadSessions: (sessions) =>
      set((s) => {
        s.sessions = {};
        for (const x of sessions) s.sessions[x.id] = x;
      }),

    ingestEvent: (event) =>
      set((s) => {
        switch (event.type) {
          case 'project.added':
            s.projects[event.project.id] = event.project;
            break;
          case 'session.spawned':
            s.sessions[event.session.id] = event.session;
            if (!s.selectedSessionId) s.selectedSessionId = event.session.id;
            break;
          case 'session.status_changed': {
            const sess = s.sessions[event.sessionId];
            if (sess) sess.status = event.to as SessionStatus;
            break;
          }
          case 'session.summarized': {
            const sess = s.sessions[event.sessionId];
            if (sess) sess.lastSummary = event.summary;
            break;
          }
          case 'session.exited': {
            const sess = s.sessions[event.sessionId];
            if (sess) {
              sess.endedAt = Date.now();
              sess.status = event.exitCode === 0 ? 'done' : 'errored';
            }
            break;
          }
          case 'session.deleted': {
            delete s.sessions[event.sessionId];
            if (s.selectedSessionId === event.sessionId) {
              s.selectedSessionId = null;
            }
            break;
          }
        }
      }),

    selectSession: (sessionId) =>
      set((s) => {
        s.selectedSessionId = sessionId;
      }),
  }))
);

/* ────────────────────────────────────────────────────────────────
 * Selectors. Array/Object-returning selectors MUST be wrapped at
 * the consumer with useMemo (see LeftColumn.tsx). Primitive
 * selectors are safe directly.
 * ──────────────────────────────────────────────────────────────── */

export const selectSessionCount = (s: AppState): number =>
  Object.keys(s.sessions).length;

export const selectProjectCount = (s: AppState): number =>
  Object.keys(s.projects).length;

export const selectSelectedSessionId = (s: AppState): string | null =>
  s.selectedSessionId;
