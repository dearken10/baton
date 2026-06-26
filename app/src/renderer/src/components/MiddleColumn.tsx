import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useAppStore, selectOpenFiles } from '../store.js';
import { lazyWithRetry } from '../lib/lazyWithRetry.js';
import { TerminalPane } from './TerminalPane.js';
import { TurnsPane } from './TurnsPane.js';
import { HSplitHandle } from './HSplitHandle.js';
import { EditorErrorBoundary } from './EditorErrorBoundary.js';
import { SessionInfoDialog } from './SessionInfoDialog.js';
import type { PermissionMode, Session } from '@shared/ipc.js';

/** Newest Opus. Used as the implicit choice for any claude-code
 *  session whose persisted `model` is null (legacy rows, freshly
 *  spawned sessions before the user has clicked the chip). The "no
 *  --model passed" passthrough option has been removed from the
 *  dropdown, so the chip always reflects a concrete model id. */
const DEFAULT_CLAUDE_MODEL = 'claude-opus-4-8';

/** Short labels for the permission-mode chip. Keys are the canonical
 *  Claude CLI values (see PermissionMode in shared/ipc.ts). */
const PERMISSION_LABELS: Record<PermissionMode, string> = {
  default: 'Ask',
  plan: 'Plan',
  acceptEdits: 'Accept edits',
  auto: 'Auto',
  bypassPermissions: 'Skip all permission',
};
/** Claude exposes the full spectrum. Order = least → most permissive. */
const CLAUDE_PERMISSION_MODES: PermissionMode[] = [
  'default', 'plan', 'acceptEdits', 'auto', 'bypassPermissions',
];
/** Codex has no intermediate — only ask-each-tool vs full bypass. */
const CODEX_PERMISSION_MODES: PermissionMode[] = ['default', 'bypassPermissions'];

const VIEW_LS_KEY = 'baton:middle:view';
type MiddleView = 'live' | 'turns';
function loadView(): MiddleView {
  try {
    const raw = localStorage.getItem(VIEW_LS_KEY);
    return raw === 'turns' ? 'turns' : 'live';
  } catch { return 'live'; }
}

// Monaco is ~8MB. Lazy-load the editor so it (and Monaco) are only
// fetched + parsed when the user first opens a file, not at app startup.
// The render site below already gates on `hasOpenFile`, so the chunk is
// requested exactly once, on first open. Helper tab-id functions live in
// ./tabIds so other components can import them without pulling Monaco.
// lazyWithRetry (not bare lazy): a rebuild/in-place update can delete the
// hashed chunk this running renderer points at, making the first import()
// 404. The wrapper reloads the window once to pick up the fresh index.html
// instead of leaving the editor permanently broken. See lazyWithRetry.ts.
const EditorPane = lazyWithRetry(() =>
  import('./EditorPane.js').then((m) => ({ default: m.EditorPane })),
);

const TOP_PCT_MIN = 18;
const TOP_PCT_MAX = 82;
const TOP_PCT_DEFAULT = 50;
const TOP_PCT_LS_KEY = 'baton:middle:topPct';

function loadTopPct(): number {
  try {
    const raw = localStorage.getItem(TOP_PCT_LS_KEY);
    if (!raw) return TOP_PCT_DEFAULT;
    const n = Number(raw);
    if (!Number.isFinite(n)) return TOP_PCT_DEFAULT;
    return Math.max(TOP_PCT_MIN, Math.min(TOP_PCT_MAX, n));
  } catch {
    return TOP_PCT_DEFAULT;
  }
}

/**
 * Switching between sessions used to lose history because the
 * <TerminalPane> was re-mounted with `key={sessionId}`. Now every
 * live session gets its own pane, mounted once and kept alive — the
 * non-selected ones are hidden with `display:none`. Each xterm
 * preserves its scrollback as long as the app is running.
 *
 * Ended sessions render a placeholder with a "Spawn new" hint.
 */
export function MiddleColumn(): JSX.Element {
  const selectedId = useAppStore((s) => s.selectedSessionId);
  const sessionsRecord = useAppStore((s) => s.sessions);
  const projectsRecord = useAppStore((s) => s.projects);
  const selectSession = useAppStore((s) => s.selectSession);
  const openFiles = useAppStore(selectOpenFiles);
  const hasOpenFile = openFiles.length > 0;

  // Per-session split percentage between the top (editor) and bottom
  // (terminal) zones. Declared up here so the resize effect below can
  // depend on it.
  const splitRef = useRef<HTMLDivElement>(null);
  const [topPct, setTopPct] = useState<number>(() => loadTopPct());

  // Live xterm vs structured Turns view. Both stay mounted so toggling
  // doesn't reset xterm scrollback or refetch turns; we just flip
  // display:none. Backends without a transcript (shell, mock) fall back
  // to the live view — TurnsPane would only show an empty state.
  const [view, setView] = useState<MiddleView>(() => loadView());
  function switchView(next: MiddleView): void {
    setView(next);
    try { localStorage.setItem(VIEW_LS_KEY, next); } catch { /* ignore */ }
  }

  // When the active session, editor-zone visibility, OR the inner
  // split ratio changes, dispatch a window 'resize'. Every TerminalPane
  // listens for that and runs fit() — without this, switching to a
  // session whose slot was mounted under display:none can render a
  // blank terminal, and dragging the inner horizontal split can leave
  // the latest rows clipped below the visible area because xterm's
  // row count is computed from a pre-resize container height.
  useEffect(() => {
    const id = window.requestAnimationFrame(() => {
      window.dispatchEvent(new Event('resize'));
    });
    return () => window.cancelAnimationFrame(id);
  }, [selectedId, hasOpenFile, topPct]);

  const sessions = useMemo(() => Object.values(sessionsRecord), [sessionsRecord]);
  const liveSessions = useMemo(
    () => sessions.filter(isLive),
    [sessions]
  );
  const selected = selectedId ? sessionsRecord[selectedId] ?? null : null;
  const selectedProject = selected ? projectsRecord[selected.projectId] ?? null : null;
  const selectedIsLive = !!selected && isLive(selected);

  // Per-session pending lock shared with the LeftColumn via the store
  // — the sidebar row needs to flip to "Starting…" the same instant
  // this button is clicked, otherwise the user sees a stale `done`
  // chip until session.spawned fires.
  const pendingSet = useAppStore((s) => s.pendingSessionIds);
  const setSessionPending = useAppStore((s) => s.setSessionPending);
  const isRespawnPending = (sid: string): boolean => pendingSet.has(sid);
  const markRespawnPending = (sid: string, on: boolean): void => {
    setSessionPending(sid, on);
  };
  async function respawnHere(sessionId: string): Promise<void> {
    if (isRespawnPending(sessionId)) return;
    markRespawnPending(sessionId, true);
    try {
      const { session } = await window.baton.call('session.respawn', { sessionId });
      selectSession(session.id);
    } catch (err) {
      alert(`Start session failed: ${String(err)}`);
    } finally {
      markRespawnPending(sessionId, false);
    }
  }
  async function resumeHere(sessionId: string): Promise<void> {
    if (isRespawnPending(sessionId)) return;
    markRespawnPending(sessionId, true);
    try {
      const { session } = await window.baton.call('session.resume', { sessionId });
      selectSession(session.id);
    } catch (err) {
      alert(`Resume failed: ${String(err)}`);
    } finally {
      markRespawnPending(sessionId, false);
    }
  }

  // Per F6.3: middle pane is a vertical split — file editor on top
  // (the Monaco surface lands in the next iteration; placeholder for
  // now), live terminal on the bottom. The handle between them is
  // draggable and the resulting percentage is persisted.
  // (splitRef / topPct hoisted above so the resize-dispatch effect
  // can react to drag changes.)
  const onSplitResize = useCallback((deltaY: number) => {
    const el = splitRef.current;
    if (!el) return;
    const h = el.getBoundingClientRect().height;
    if (h <= 0) return;
    setTopPct((prev) => {
      const next = Math.max(
        TOP_PCT_MIN,
        Math.min(TOP_PCT_MAX, prev + (deltaY / h) * 100)
      );
      try { localStorage.setItem(TOP_PCT_LS_KEY, String(next)); } catch { /* ignore */ }
      return next;
    });
  }, []);

  const [modelBusy, setModelBusy] = useState(false);
  async function changeModel(s: Session, next: string): Promise<void> {
    if (modelBusy) return;
    const current = s.model ?? DEFAULT_CLAUDE_MODEL;
    if (current === next) return;
    const isLive = s.status !== 'done' && s.status !== 'errored';
    const lines = [`Switch this session's model to "${next}"?`];
    if (isLive) lines.push('', 'The session will restart briefly to apply the change.');
    if (!window.confirm(lines.join('\n'))) return;
    setModelBusy(true);
    try {
      const { session } = await window.baton.call('session.setModel', {
        sessionId: s.id,
        model: next,
      });
      selectSession(session.id);
    } catch (err) {
      alert(`Model change failed: ${String(err)}`);
    } finally {
      setModelBusy(false);
    }
  }

  const [permModeBusy, setPermModeBusy] = useState(false);
  // Session-info dialog is keyed on the actual session rather than a
  // boolean so the dialog disappears cleanly if the user switches to
  // another session while it's open.
  const [infoFor, setInfoFor] = useState<Session | null>(null);
  async function changePermissionMode(s: Session, next: PermissionMode): Promise<void> {
    if (permModeBusy) return;
    if (next === s.permissionMode) return;
    const isLive = s.status !== 'done' && s.status !== 'errored';
    // Only the full-bypass mode is dangerous enough to warrant a
    // confirm — the other modes still gate (or vet) tool calls.
    if (next === 'bypassPermissions') {
      const agentName = s.backendId === 'codex' ? 'Codex' : 'Claude';
      const flagName = s.backendId === 'codex'
        ? '--dangerously-bypass-approvals-and-sandbox'
        : '--permission-mode bypassPermissions';
      const lines = [
        'Switch this session to "Skip all" permissions?',
        '',
        `${agentName} will be relaunched with ${flagName},`,
        'which auto-approves every tool call (file edits, shell commands,',
        'package installs, …) with no prompt.',
      ];
      if (isLive) lines.push('', 'The session will restart briefly to apply the change.');
      if (!window.confirm(lines.join('\n'))) return;
    }
    setPermModeBusy(true);
    try {
      const { session } = await window.baton.call('session.setPermissionMode', {
        sessionId: s.id,
        mode: next,
      });
      selectSession(session.id);
    } catch (err) {
      alert(`Permission mode change failed: ${String(err)}`);
    } finally {
      setPermModeBusy(false);
    }
  }

  return (
    <main className="col col-middle">
      <div className="conv-head">
        {selected ? (
          <>
            <span className="title">
              {selectedProject?.name ?? 'project'} · {sessionLabel(selected)}
            </span>
            <button
              type="button"
              className="conv-info-btn"
              onClick={() => setInfoFor(selected)}
              title="Session info — agent session id, worktree, baton id"
              aria-label="Show session info"
            >
              ⓘ
            </button>
            {(selected.backendId === 'claude-code' || selected.backendId === 'codex') ? (
              <div className="middle-view-toggle" role="tablist" aria-label="Terminal view">
                <button
                  type="button"
                  role="tab"
                  aria-selected={view === 'live'}
                  className={view === 'live' ? 'on' : ''}
                  onClick={() => switchView('live')}
                  title="Live xterm — interactive view of the agent's TUI"
                >
                  Live
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={view === 'turns'}
                  className={view === 'turns' ? 'on' : ''}
                  onClick={() => switchView('turns')}
                  title="Turns — every prompt broken into user input, progress, recap"
                >
                  Turns
                </button>
              </div>
            ) : null}
            {selected.backendId === 'claude-code' ? (
              <select
                className="model-chip active"
                value={selected.model ?? DEFAULT_CLAUDE_MODEL}
                disabled={modelBusy}
                onChange={(e) => {
                  void changeModel(selected, e.currentTarget.value);
                }}
                title={`Model: ${selected.model ?? DEFAULT_CLAUDE_MODEL} — passed to claude as --model. Change restarts session.`}
              >
                <optgroup label="Latest in tier">
                  <option value="sonnet">Sonnet (latest)</option>
                  <option value="opus">Opus (latest)</option>
                  <option value="haiku">Haiku (latest)</option>
                </optgroup>
                <optgroup label="Pinned version">
                  <option value="claude-opus-4-8">Opus 4.8</option>
                  <option value="claude-opus-4-7">Opus 4.7</option>
                  <option value="claude-opus-4-6">Opus 4.6</option>
                  <option value="claude-opus-4-5">Opus 4.5</option>
                  <option value="claude-sonnet-4-6">Sonnet 4.6</option>
                  <option value="claude-sonnet-4-5">Sonnet 4.5</option>
                  <option value="claude-haiku-4-5">Haiku 4.5</option>
                </optgroup>
              </select>
            ) : null}
            {(selected.backendId === 'claude-code' || selected.backendId === 'codex') ? (
              <select
                className={`perm-chip ${selected.permissionMode === 'bypassPermissions' ? 'danger' : ''}`}
                value={selected.permissionMode}
                disabled={permModeBusy}
                onChange={(e) => {
                  void changePermissionMode(selected, e.currentTarget.value as PermissionMode);
                }}
                title={`Permission: ${PERMISSION_LABELS[selected.permissionMode]} — passed to the agent as --permission-mode. Change restarts session.`}
              >
                {(selected.backendId === 'codex' ? CODEX_PERMISSION_MODES : CLAUDE_PERMISSION_MODES)
                  .map((m) => (
                    <option key={m} value={m}>
                      {PERMISSION_LABELS[m]}
                    </option>
                  ))}
              </select>
            ) : null}
          </>
        ) : (
          <span className="title">No session selected</span>
        )}
      </div>
      <div
        className="middle-split"
        ref={splitRef}
        style={{ ['--top-h' as never]: `${topPct}%` }}
      >
        {hasOpenFile ? (
          <div className="middle-top" key="top">
            <EditorErrorBoundary>
              <Suspense fallback={<div className="editor-loading dim">Loading editor…</div>}>
                <EditorPane />
              </Suspense>
            </EditorErrorBoundary>
          </div>
        ) : null}
        {hasOpenFile ? <HSplitHandle key="handle" onResize={onSplitResize} /> : null}
        <div className="middle-bottom" key="bottom">
          {/* All live terminals stay mounted — we just hide the
              ones that aren't selected. Each keeps its own scrollback.
              The Turns pane overlays the active terminal-slot via
              position:absolute rather than toggling display on it,
              so the xterm host below keeps its size and identity. */}
          {liveSessions.map((s) => (
            <div
              key={s.id}
              className="terminal-slot"
              style={{ display: s.id === selectedId ? 'flex' : 'none' }}
            >
              <TerminalPane sessionId={s.id} />
            </div>
          ))}
          {selected && view === 'turns'
            && (selected.backendId === 'claude-code' || selected.backendId === 'codex') ? (
            <div className="turns-slot turns-slot-overlay">
              <TurnsPane sessionId={selected.id} />
            </div>
          ) : null}

          {/* Selected an ended session OR nothing? show a placeholder
              (one of these, mutually exclusive with the live slots). */}
          {selected && !selectedIsLive ? (
            <div className="empty session-ended">
              <h3>{selected.backendId === 'shell' ? 'Terminal ended' : 'Session ended'}</h3>
              {selected.backendId === 'shell' ? (
                <p className="dim">
                  The shell exited. Open a fresh terminal in the same
                  folder — your scrollback is gone but the working
                  directory is unchanged.
                </p>
              ) : selected.claudeSessionId ? (
                <p className="dim">
                  The prior conversation is still on disk. Resume picks
                  it up where it left off; Start fresh keeps the worktree
                  and branch but begins a new chat.
                </p>
              ) : (
                <p className="dim">
                  No conversation history was saved for this session.
                  You can still start a new agent here — the worktree
                  and branch are untouched.
                </p>
              )}
              <div className="session-ended-actions">
                {selected.backendId !== 'shell' && selected.claudeSessionId ? (
                  <button
                    type="button"
                    className="btn primary"
                    onClick={() => resumeHere(selected.id)}
                    disabled={isRespawnPending(selected.id)}
                    aria-busy={isRespawnPending(selected.id) || undefined}
                  >
                    {isRespawnPending(selected.id) ? 'Starting…' : 'Resume conversation'}
                  </button>
                ) : null}
                <button
                  type="button"
                  className={`btn${selected.backendId === 'shell' ? ' primary' : ''}`}
                  onClick={() => respawnHere(selected.id)}
                  disabled={isRespawnPending(selected.id)}
                  aria-busy={isRespawnPending(selected.id) || undefined}
                >
                  {isRespawnPending(selected.id)
                    ? 'Starting…'
                    : selected.backendId === 'shell'
                      ? 'Open fresh terminal'
                      : 'Start fresh session here'}
                </button>
              </div>
              <p className="dim mono">
                status: {selected.status} · ended{' '}
                {selected.endedAt
                  ? new Date(selected.endedAt).toLocaleString()
                  : 'unknown'}
              </p>
            </div>
          ) : null}

          {!selected ? (
            <div className="empty">
              <p>Add a project, then spawn an agent in it from the left column.</p>
            </div>
          ) : null}
        </div>
      </div>
      <SessionInfoDialog
        session={infoFor}
        onClose={() => setInfoFor(null)}
        onCloned={(s) => selectSession(s.id)}
      />
    </main>
  );
}

function isLive(s: Session): boolean {
  return s.status !== 'done' && s.status !== 'errored';
}

function sessionLabel(s: Session): string {
  return s.branch;
}
