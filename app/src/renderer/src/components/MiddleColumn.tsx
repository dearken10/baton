import { useMemo } from 'react';
import { useAppStore } from '../store.js';
import { TerminalPane } from './TerminalPane.js';
import type { Session } from '@shared/ipc.js';

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

  const sessions = useMemo(() => Object.values(sessionsRecord), [sessionsRecord]);
  const liveSessions = useMemo(
    () => sessions.filter(isLive),
    [sessions]
  );
  const selected = selectedId ? sessionsRecord[selectedId] ?? null : null;
  const selectedProject = selected ? projectsRecord[selected.projectId] ?? null : null;
  const selectedIsLive = !!selected && isLive(selected);

  return (
    <main className="col col-middle">
      <div className="conv-head">
        {selected ? (
          <>
            <span className="title">
              {selectedProject?.name ?? 'project'} · {sessionLabel(selected)}
            </span>
            <span className={`status status-${selected.status}`}>
              {selected.status}
            </span>
          </>
        ) : (
          <span className="title">No session selected</span>
        )}
      </div>
      <div className="conv-body">
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
            <h3>Session ended</h3>
            <p className="dim">
              This Claude Code session is no longer running. Click
              <strong> + Agent</strong> on the project to spawn a new one.
            </p>
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
    </main>
  );
}

function isLive(s: Session): boolean {
  return s.status !== 'done' && s.status !== 'errored';
}

function sessionLabel(s: Session): string {
  // Short, distinguishable label: `branch · <short id>`. Once we have
  // LLM-named worktrees (PRD F2.2) the worktree name replaces the
  // short id.
  return `${s.branch} · ${s.id.slice(0, 6)}`;
}
