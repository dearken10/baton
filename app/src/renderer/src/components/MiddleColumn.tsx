import { useAppStore } from '../store.js';
import { TerminalPane } from './TerminalPane.js';

export function MiddleColumn(): JSX.Element {
  const selectedId = useAppStore((s) => s.selectedSessionId);
  const session = useAppStore((s) =>
    selectedId ? s.sessions[selectedId] : null
  );
  const project = useAppStore((s) =>
    session ? s.projects[session.projectId] : null
  );

  return (
    <main className="col col-middle">
      <div className="conv-head">
        {session ? (
          <>
            <span className="title">
              {project?.name ?? 'project'} · {session.branch}
            </span>
            <span className={`status status-${session.status}`}>{session.status}</span>
          </>
        ) : (
          <span className="title">No session selected</span>
        )}
      </div>
      <div className="conv-body">
        {session ? (
          // Re-mount the terminal pane whenever the session changes
          // so xterm + its subscriptions are tied to one sessionId.
          <TerminalPane key={session.id} sessionId={session.id} />
        ) : (
          <div className="empty">
            <p>Add a project, then spawn an agent in it from the left column.</p>
          </div>
        )}
      </div>
    </main>
  );
}
