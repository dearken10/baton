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

/** Editor state for one session — what's open, what's active, what's
 *  the single preview tab (if any). Persisted per-session so tabs
 *  survive both session-switching and app restart. */
export interface EditorState {
  openFiles: string[];
  activeFilePath: string | null;
  previewFilePath: string | null;
}

/** Stable empty array reference for the no-session / no-editor case
 *  so selectors don't return a fresh `[]` per call. */
const EMPTY_OPEN_FILES: readonly string[] = Object.freeze([]);

const LS_KEY = 'code24:editor-by-session';

function loadPersisted(): Record<string, EditorState> {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object') return {};
    // Best-effort shape check — discard entries that don't look right.
    const out: Record<string, EditorState> = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (!v || typeof v !== 'object') continue;
      const e = v as Partial<EditorState>;
      if (!Array.isArray(e.openFiles)) continue;
      out[k] = {
        openFiles: e.openFiles.filter((x) => typeof x === 'string'),
        activeFilePath: typeof e.activeFilePath === 'string' ? e.activeFilePath : null,
        previewFilePath: typeof e.previewFilePath === 'string' ? e.previewFilePath : null,
      };
    }
    return out;
  } catch {
    return {};
  }
}

function persist(map: Record<string, EditorState>): void {
  try { localStorage.setItem(LS_KEY, JSON.stringify(map)); }
  catch { /* localStorage quota / disabled — best-effort */ }
}

export interface AppState {
  bootStartedAt: number;
  projects: Record<string, Project>;
  sessions: Record<string, Session>;
  selectedSessionId: string | null;
  /** Per-session editor state. Keyed by session id. */
  editorBySession: Record<string, EditorState>;

  loadProjects(projects: Project[]): void;
  loadSessions(sessions: Session[]): void;
  ingestEvent(event: AppEvent): void;
  selectSession(sessionId: string | null): void;
  /** Open a file in the active session's editor.
   *   - 'preview' (default): single-click — replaces any preview tab.
   *   - 'sticky': pinned — opens fresh OR promotes preview to sticky. */
  openFile(absPath: string, kind?: 'preview' | 'sticky'): void;
  /** Promote a preview tab to sticky (called on first edit, F6.5). */
  promoteToSticky(absPath: string): void;
  /** Close one tab in the active session (defaults to its active tab). */
  closeFile(absPath?: string): void;
  /** Make a tab active in the current session. */
  selectTab(absPath: string): void;
}

export const useAppStore = create<AppState>()(
  immer((set) => ({
    bootStartedAt: Date.now(),
    projects: {},
    sessions: {},
    selectedSessionId: null,
    editorBySession: loadPersisted(),

    loadProjects: (projects) =>
      set((s) => {
        s.projects = {};
        for (const p of projects) s.projects[p.id] = p;
      }),

    loadSessions: (sessions) =>
      set((s) => {
        s.sessions = {};
        for (const x of sessions) s.sessions[x.id] = x;
        // Garbage-collect editor state for sessions that no longer
        // exist (deleted while the app was closed).
        const live = new Set(sessions.map((x) => x.id));
        for (const sid of Object.keys(s.editorBySession)) {
          if (!live.has(sid)) delete s.editorBySession[sid];
        }
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
            delete s.editorBySession[event.sessionId];
            if (s.selectedSessionId === event.sessionId) {
              s.selectedSessionId = null;
            }
            break;
          }
          case 'session.tokens_updated': {
            const sess = s.sessions[event.sessionId];
            if (sess) {
              sess.tokensIn = event.tokensIn;
              sess.tokensOut = event.tokensOut;
            }
            break;
          }
          case 'session.refreshed': {
            s.sessions[event.session.id] = event.session;
            break;
          }
          case 'session.renamed': {
            const sess = s.sessions[event.sessionId];
            if (sess) {
              sess.branch = event.newBranch;
              sess.worktreePath = event.newWorktreePath;
            }
            break;
          }
        }
      }),

    selectSession: (sessionId) =>
      set((s) => {
        s.selectedSessionId = sessionId;
      }),

    openFile: (absPath, kind = 'preview') =>
      set((s) => {
        const sid = s.selectedSessionId;
        if (!sid) return;
        if (!s.editorBySession[sid]) {
          // Fresh slot. Inline literal so openFiles is a new array,
          // not a reference shared with a module-level constant.
          s.editorBySession[sid] = {
            openFiles: [],
            activeFilePath: null,
            previewFilePath: null,
          };
        }
        const slot = s.editorBySession[sid]!;
        const alreadyOpen = slot.openFiles.includes(absPath);

        if (kind === 'sticky') {
          if (!alreadyOpen) slot.openFiles = [...slot.openFiles, absPath];
          if (slot.previewFilePath === absPath) slot.previewFilePath = null;
          slot.activeFilePath = absPath;
          return;
        }

        if (alreadyOpen) {
          // Already open — just focus. Don't demote a sticky tab.
          slot.activeFilePath = absPath;
          return;
        }

        // Preview: replace an existing preview in place; otherwise
        // append (so tab order is stable while browsing). We use
        // WHOLE-array assignments (not push / index-set) because the
        // previous snapshot's openFiles was auto-frozen by immer —
        // in-place mutations would throw "object is not extensible".
        const existingPreviewIdx = slot.previewFilePath
          ? slot.openFiles.indexOf(slot.previewFilePath)
          : -1;
        if (existingPreviewIdx >= 0) {
          slot.openFiles = slot.openFiles.map((p, i) =>
            i === existingPreviewIdx ? absPath : p
          );
        } else {
          slot.openFiles = [...slot.openFiles, absPath];
        }
        slot.previewFilePath = absPath;
        slot.activeFilePath = absPath;
      }),

    promoteToSticky: (absPath) =>
      set((s) => {
        const sid = s.selectedSessionId;
        if (!sid) return;
        const slot = s.editorBySession[sid];
        if (!slot) return;
        if (slot.previewFilePath === absPath) slot.previewFilePath = null;
      }),

    closeFile: (absPath) =>
      set((s) => {
        const sid = s.selectedSessionId;
        if (!sid) return;
        const slot = s.editorBySession[sid];
        if (!slot) return;
        const target = absPath ?? slot.activeFilePath;
        if (!target) return;
        const idx = slot.openFiles.indexOf(target);
        if (idx < 0) return;
        slot.openFiles = slot.openFiles.filter((_, i) => i !== idx);
        if (slot.previewFilePath === target) slot.previewFilePath = null;
        if (slot.activeFilePath === target) {
          // After filter, the right-neighbour now sits at the closing
          // index. Fall back to the left-neighbour, then null.
          slot.activeFilePath =
            slot.openFiles[idx] ?? slot.openFiles[idx - 1] ?? null;
        }
      }),

    selectTab: (absPath) =>
      set((s) => {
        const sid = s.selectedSessionId;
        if (!sid) return;
        const slot = s.editorBySession[sid];
        if (!slot) return;
        if (slot.openFiles.includes(absPath)) slot.activeFilePath = absPath;
      }),
  }))
);

// Side-effect: persist editorBySession whenever it changes. Equality
// check uses Zustand's structural identity (immer returns a fresh
// object on any change), so we only write when something actually
// moved. Cheap JSON.stringify — open-files arrays are tiny.
let lastPersisted: Record<string, EditorState> | null = null;
useAppStore.subscribe((s) => {
  if (s.editorBySession !== lastPersisted) {
    lastPersisted = s.editorBySession;
    persist(s.editorBySession);
  }
});

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

/** Files open in the active session's editor. Stable empty array
 *  when no session is selected, so consumers can read this with a
 *  plain selector and not trip Zustand's snapshot caching. */
export const selectOpenFiles = (s: AppState): readonly string[] => {
  if (!s.selectedSessionId) return EMPTY_OPEN_FILES;
  return s.editorBySession[s.selectedSessionId]?.openFiles ?? EMPTY_OPEN_FILES;
};

export const selectActiveFilePath = (s: AppState): string | null => {
  if (!s.selectedSessionId) return null;
  return s.editorBySession[s.selectedSessionId]?.activeFilePath ?? null;
};

export const selectPreviewFilePath = (s: AppState): string | null => {
  if (!s.selectedSessionId) return null;
  return s.editorBySession[s.selectedSessionId]?.previewFilePath ?? null;
};
