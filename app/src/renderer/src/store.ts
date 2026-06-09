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

const LS_KEY = 'baton:editor-by-session';

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
  /** Render order for project / session lists (drag-to-reorder).
   *  Keyed by id → integer position. Lower = earlier in the list. */
  projectOrder: Record<string, number>;
  sessionOrder: Record<string, number>;
  selectedSessionId: string | null;
  /** Per-session editor state. Keyed by session id. */
  editorBySession: Record<string, EditorState>;
  /** One-shot "after the next openFile finishes loading, reveal line N
   *  in the editor." Consumed (and cleared) by EditorPane once the
   *  matching tab's model is ready. Nonce ensures repeat clicks on the
   *  SAME (path,line) still trigger a reveal. */
  pendingGoto: { absPath: string; line: number; col: number; nonce: number } | null;

  loadProjects(projects: Project[]): void;
  loadSessions(sessions: Session[]): void;
  ingestEvent(event: AppEvent): void;
  selectSession(sessionId: string | null): void;
  /** Open a file in the active session's editor.
   *   - 'preview' (default): single-click — replaces any preview tab.
   *   - 'sticky': pinned — opens fresh OR promotes preview to sticky.
   *   - `goto`: also reveal that line in Monaco once the file's loaded. */
  openFile(absPath: string, kind?: 'preview' | 'sticky', goto?: { line: number; col: number }): void;
  /** EditorPane calls this once it has revealed `pendingGoto`. */
  consumePendingGoto(nonce: number): void;
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
    projectOrder: {},
    sessionOrder: {},
    selectedSessionId: null,
    editorBySession: loadPersisted(),
    pendingGoto: null,

    loadProjects: (projects) =>
      set((s) => {
        s.projects = {};
        s.projectOrder = {};
        projects.forEach((p, i) => {
          s.projects[p.id] = p;
          s.projectOrder[p.id] = i;
        });
      }),

    loadSessions: (sessions) =>
      set((s) => {
        s.sessions = {};
        s.sessionOrder = {};
        sessions.forEach((x, i) => {
          s.sessions[x.id] = x;
          s.sessionOrder[x.id] = i;
        });
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
            if (!(event.project.id in s.projectOrder)) {
              s.projectOrder[event.project.id] = Object.keys(s.projects).length;
            }
            break;
          case 'project.removed': {
            delete s.projects[event.projectId];
            delete s.projectOrder[event.projectId];
            for (const id of Object.keys(s.sessions)) {
              if (s.sessions[id]?.projectId === event.projectId) {
                delete s.sessions[id];
                if (s.selectedSessionId === id) s.selectedSessionId = null;
              }
            }
            break;
          }
          case 'project.reordered': {
            s.projectOrder = {};
            event.orderedIds.forEach((id, i) => { s.projectOrder[id] = i; });
            break;
          }
          case 'project.renamed': {
            s.projects[event.project.id] = event.project;
            break;
          }
          case 'project.snoozeChanged': {
            s.projects[event.project.id] = event.project;
            break;
          }
          case 'session.reordered': {
            s.sessionOrder = {};
            event.orderedIds.forEach((id, i) => { s.sessionOrder[id] = i; });
            break;
          }
          case 'session.spawned':
            s.sessions[event.session.id] = event.session;
            if (!s.selectedSessionId) s.selectedSessionId = event.session.id;
            break;
          case 'session.status_changed': {
            const sess = s.sessions[event.sessionId];
            // Mirror of the main-process status-trace log. Visible in
            // DevTools so you can correlate "what main sent" with
            // "what the renderer applied" when chasing stuck chips.
            // eslint-disable-next-line no-console
            console.debug(
              `[status-trace] RENDERER_STATUS sid=${event.sessionId.slice(0, 8)} ` +
              `from=${event.from} to=${event.to} seq=${event.seq} ` +
              `ageMs=${Date.now() - event.ts} applied=${sess ? 'yes' : 'no-such-session'}`
            );
            if (sess) sess.status = event.to as SessionStatus;
            break;
          }
          case 'session.summarized': {
            const sess = s.sessions[event.sessionId];
            // eslint-disable-next-line no-console
            console.debug(
              `[status-trace] RENDERER_SUMMARY sid=${event.sessionId.slice(0, 8)} ` +
              `summary="${event.summary.slice(0, 40)}" seq=${event.seq} ` +
              `ageMs=${Date.now() - event.ts} applied=${sess ? 'yes' : 'no-such-session'}`
            );
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
            const prev = s.sessions[event.session.id];
            // eslint-disable-next-line no-console
            console.debug(
              `[status-trace] RENDERER_REFRESH sid=${event.session.id.slice(0, 8)} ` +
              `prevSummary="${prev?.lastSummary ?? '∅'}" ` +
              `incomingSummary="${event.session.lastSummary ?? '∅'}" ` +
              `seq=${event.seq} ageMs=${Date.now() - event.ts}`
            );
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

    openFile: (absPath, kind = 'preview', goto) =>
      set((s) => {
        if (goto) {
          s.pendingGoto = {
            absPath,
            line: goto.line,
            col: goto.col,
            nonce: (s.pendingGoto?.nonce ?? 0) + 1,
          };
        }
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

    consumePendingGoto: (nonce) =>
      set((s) => {
        if (s.pendingGoto?.nonce === nonce) s.pendingGoto = null;
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
