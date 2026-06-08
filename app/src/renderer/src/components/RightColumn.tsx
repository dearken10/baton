import { useEffect, useState } from 'react';
import { useAppStore } from '../store.js';
import { FilesPanel } from './FilesPanel.js';
import { GitPanel } from './GitPanel.js';
import { SearchPanel } from './SearchPanel.js';

type Tab = 'files' | 'search' | 'git';

const REFRESH_MS = 3000;

export function RightColumn(): JSX.Element {
  const [tab, setTab] = useState<Tab>('files');
  const selectedId = useAppStore((s) => s.selectedSessionId);
  const sessionsRecord = useAppStore((s) => s.sessions);
  const selected = selectedId ? sessionsRecord[selectedId] ?? null : null;

  // Tick on a timer so the panel reflects whatever the agent (or the
  // user) has been doing in the worktree. Cheap: each tick is one
  // readdir or one statusMatrix scan.
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!selected) return;
    const id = window.setInterval(() => setTick((t) => t + 1), REFRESH_MS);
    return () => window.clearInterval(id);
  }, [selected?.id]);

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
      </div>
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
