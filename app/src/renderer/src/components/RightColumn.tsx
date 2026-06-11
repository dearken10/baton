import { useEffect, useRef, useState } from 'react';
import { useAppStore } from '../store.js';
import { FilesPanel } from './FilesPanel.js';
import { GitPanel } from './GitPanel.js';
import { SearchPanel } from './SearchPanel.js';

type Tab = 'files' | 'search' | 'git';

/** Debounce window for coalescing a burst of worktree.changed events
 *  (the main-process watcher already debounces, this is belt-and-braces
 *  against rapid distinct events). */
const CHANGE_DEBOUNCE_MS = 150;

/** Remote (SSH) sessions have no local FS watcher, so they fall back to
 *  a slow poll. Far slower than the old 3s because git status over SSH
 *  is comparatively expensive and remote edits are less frequent. */
const REMOTE_FALLBACK_MS = 8000;

export function RightColumn(): JSX.Element {
  const [tab, setTab] = useState<Tab>('files');
  const selectedId = useAppStore((s) => s.selectedSessionId);
  const sessionsRecord = useAppStore((s) => s.sessions);
  const projectsRecord = useAppStore((s) => s.projects);
  const connectionsRecord = useAppStore((s) => s.connections);
  const selected = selectedId ? sessionsRecord[selectedId] ?? null : null;
  const selectedProject = selected ? projectsRecord[selected.projectId] : null;
  const selectedConnection = selectedProject ? connectionsRecord[selectedProject.connectionId] : null;
  const isRemote = !!selectedConnection && selectedConnection.kind !== 'local';
  // Remote sessions track an extra `disconnected` state surfaced by
  // the SSH master's health check. We treat anything other than
  // `success` as "show the disconnect banner".
  const remoteHealthy = !isRemote || selectedConnection?.lastStatus === 'success';

  // Refresh the Files/Git panels when the worktree actually changes,
  // instead of polling on a clock. The main process watches the
  // worktree (local sessions) and pushes `worktree.changed`; we debounce
  // and bump `tick`, which the panels consume as `refreshKey`.
  const [tick, setTick] = useState(0);
  const debounceRef = useRef<number | null>(null);
  const selectedSessionId = selected?.id ?? null;

  useEffect(() => {
    if (!selectedSessionId) return;

    const bump = (): void => {
      if (debounceRef.current != null) window.clearTimeout(debounceRef.current);
      debounceRef.current = window.setTimeout(() => {
        debounceRef.current = null;
        setTick((t) => t + 1);
      }, CHANGE_DEBOUNCE_MS);
    };

    // Local sessions: event-driven via the main-process watcher.
    const unsub = window.baton.onEvent((event) => {
      if (event.type === 'worktree.changed' && event.sessionId === selectedSessionId) {
        bump();
      }
    });

    // Remote sessions: no local watcher exists, so fall back to a slow
    // poll. (Local sessions don't need this — the watcher covers them.)
    const fallbackId = isRemote
      ? window.setInterval(() => setTick((t) => t + 1), REMOTE_FALLBACK_MS)
      : null;

    return () => {
      unsub();
      if (fallbackId != null) window.clearInterval(fallbackId);
      if (debounceRef.current != null) {
        window.clearTimeout(debounceRef.current);
        debounceRef.current = null;
      }
    };
  }, [selectedSessionId, isRemote]);

  async function reconnect(): Promise<void> {
    if (!selectedConnection) return;
    try {
      await window.baton.call('connection.reconnect', { id: selectedConnection.id });
    } catch (err) {
      alert(`Reconnect failed: ${String(err)}`);
    }
  }

  return (
    <aside className="col col-right">
      <div className="right-tabs">
        <button
          className={`right-tab ${tab === 'files' ? 'active' : ''}`}
          onClick={() => setTab('files')}
        >
          📁 Files
        </button>
        <button
          className={`right-tab ${tab === 'search' ? 'active' : ''}`}
          onClick={() => setTab('search')}
        >
          🔍 Search
        </button>
        <button
          className={`right-tab ${tab === 'git' ? 'active' : ''}`}
          onClick={() => setTab('git')}
        >
          ⎇ Git
        </button>
        {isRemote && selectedConnection ? (
          <span
            className={`conn-chip ${remoteHealthy ? 'ok' : 'warn'}`}
            title={remoteHealthy
              ? `Connected to ${selectedConnection.user}@${selectedConnection.host}`
              : `Status: ${selectedConnection.lastStatus ?? 'unknown'}`}
          >
            <span className="conn-chip-dot" />
            🛰 {selectedConnection.name}
          </span>
        ) : null}
      </div>
      {isRemote && !remoteHealthy && selectedConnection ? (
        <div className="right-banner">
          <div className="right-banner-head">
            <span className="right-banner-dot" />
            <span>Connection lost · {selectedConnection.name}</span>
          </div>
          <div className="right-banner-sub">
            Showing the last known state of files / git / search.
            Edits made on the remote since the drop will appear once we reconnect.
          </div>
          <div className="right-banner-actions">
            <button className="btn btn-small primary" onClick={() => void reconnect()}>
              Reconnect now
            </button>
          </div>
        </div>
      ) : null}
      <div className="panel">
        {!selected ? (
          <div className="empty">
            <p className="dim">Select a session to inspect its worktree.</p>
          </div>
        ) : tab === 'files' ? (
          <FilesPanel
            sessionId={selected.id}
            worktreePath={selected.worktreePath}
            refreshKey={tick}
          />
        ) : tab === 'search' ? (
          <SearchPanel
            sessionId={selected.id}
            worktreePath={selected.worktreePath}
          />
        ) : (
          <GitPanel
            sessionId={selected.id}
            worktreePath={selected.worktreePath}
            refreshKey={tick}
          />
        )}
      </div>
    </aside>
  );
}
