import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useAppStore, selectOpenFiles } from '../store.js';
import { TerminalPane } from './TerminalPane.js';
import { HSplitHandle } from './HSplitHandle.js';
import { EditorPane } from './EditorPane.js';
import { EditorErrorBoundary } from './EditorErrorBoundary.js';
import type { Session } from '@shared/ipc.js';

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

  const [respawnBusy, setRespawnBusy] = useState(false);
  async function respawnHere(sessionId: string): Promise<void> {
    setRespawnBusy(true);
    try {
      const { session } = await window.baton.call('session.respawn', { sessionId });
      selectSession(session.id);
    } catch (err) {
      alert(`Start session failed: ${String(err)}`);
    } finally {
      setRespawnBusy(false);
    }
  }
  async function resumeHere(sessionId: string): Promise<void> {
    setRespawnBusy(true);
    try {
      const { session } = await window.baton.call('session.resume', { sessionId });
      selectSession(session.id);
    } catch (err) {
      alert(`Resume failed: ${String(err)}`);
    } finally {
      setRespawnBusy(false);
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

  const [skipPermBusy, setSkipPermBusy] = useState(false);
  async function toggleSkipPermissions(s: Session): Promise<void> {
    if (skipPermBusy) return;
    const turningOn = !s.skipPermissions;
    const isLive = s.status !== 'done' && s.status !== 'errored';
    const agentName = s.backendId === 'codex' ? 'Codex' : 'Claude';
    const flagName = s.backendId === 'codex'
      ? '--dangerously-bypass-approvals-and-sandbox'
      : '--dangerously-skip-permissions';
    const lines = turningOn
      ? [
          'Turn ON "Skip Permission" for this session?',
          '',
          `${agentName} will be relaunched with ${flagName},`,
          'which auto-approves every tool call (file edits, shell commands,',
          'package installs, …) with no prompt.',
        ]
      : [
          'Turn OFF "Skip Permission" for this session?',
          '',
          `${agentName} will be relaunched without ${flagName}`,
          'and will ask before each tool call again.',
        ];
    if (isLive) lines.push('', 'The session will restart briefly to apply the change.');
    if (!window.confirm(lines.join('\n'))) return;
    setSkipPermBusy(true);
    try {
      const { session } = await window.baton.call('session.toggleYolo', {
        sessionId: s.id,
      });
      selectSession(session.id);
    } catch (err) {
      alert(`Toggle failed: ${String(err)}`);
    } finally {
      setSkipPermBusy(false);
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
            {(selected.backendId === 'claude-code' || selected.backendId === 'codex') ? (
              <button
                type="button"
                className={`skip-perm-chip ${selected.skipPermissions ? 'on' : 'off'}`}
                onClick={() => void toggleSkipPermissions(selected)}
                disabled={skipPermBusy}
                title={
                  selected.skipPermissions
                    ? '"Skip Permission" ON — the agent auto-approves every tool. Click to turn off (restarts session).'
                    : '"Skip Permission" OFF — the agent asks before each tool. Click to turn on (restarts session).'
                }
              >
                {selected.skipPermissions ? '⚠️ Skip Permission ON' : '🛡️ Skip Permission OFF'}
              </button>
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
              <EditorPane />
            </EditorErrorBoundary>
          </div>
        ) : null}
        {hasOpenFile ? <HSplitHandle key="handle" onResize={onSplitResize} /> : null}
        <div className="middle-bottom" key="bottom">
          {/* All live terminals stay mounted — we just hide the
              ones that aren't selected. Each keeps its own scrollback. */}
          {liveSessions.map((s) => (
            <div
              key={s.id}
              className="terminal-slot"
              style={{ display: s.id === selectedId ? 'flex' : 'none' }}
            >
              <TerminalPane sessionId={s.id} />
            </div>
          ))}

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
                    disabled={respawnBusy}
                  >
                    Resume conversation
                  </button>
                ) : null}
                <button
                  type="button"
                  className={`btn${selected.backendId === 'shell' ? ' primary' : ''}`}
                  onClick={() => respawnHere(selected.id)}
                  disabled={respawnBusy}
                >
                  {selected.backendId === 'shell' ? 'Open fresh terminal' : 'Start fresh session here'}
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
    </main>
  );
}

function isLive(s: Session): boolean {
  return s.status !== 'done' && s.status !== 'errored';
}

function sessionLabel(s: Session): string {
  return s.branch;
}
