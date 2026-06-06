import { useMemo, useState } from 'react';
import { useAppStore } from '../store.js';
import type { Project, Session } from '@shared/ipc.js';

export function LeftColumn(): JSX.Element {
  const projectsRecord = useAppStore((s) => s.projects);
  const sessionsRecord = useAppStore((s) => s.sessions);
  const selectedId = useAppStore((s) => s.selectedSessionId);
  const selectSession = useAppStore((s) => s.selectSession);

  const projects = useMemo(() => Object.values(projectsRecord), [projectsRecord]);
  const sessions = useMemo(() => Object.values(sessionsRecord), [sessionsRecord]);
  const sessionsByProject = useMemo(() => {
    const map: Record<string, Session[]> = {};
    for (const s of sessions) {
      (map[s.projectId] ??= []).push(s);
    }
    return map;
  }, [sessions]);

  const [busy, setBusy] = useState(false);

  async function addProject(): Promise<void> {
    setBusy(true);
    try {
      const { path } = await window.code24.call('project.pickFolder', {});
      if (!path) return;
      await window.code24.call('project.add', { path });
    } catch (err) {
      alert(`Add project failed: ${String(err)}`);
    } finally {
      setBusy(false);
    }
  }

  async function spawnAgent(projectId: string): Promise<void> {
    setBusy(true);
    try {
      const { session } = await window.code24.call('session.spawn', {
        projectId,
        backendId: 'claude-code',
      });
      selectSession(session.id);
    } catch (err) {
      alert(`Spawn failed: ${String(err)}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <aside className="col col-left">
      <div className="col-head">
        <span>Projects · Sessions</span>
        <button
          className="add"
          onClick={addProject}
          disabled={busy}
          aria-label="Add project"
          title="Add project"
        >
          +
        </button>
      </div>
      <div className="col-body">
        {projects.length === 0 ? (
          <div className="empty">
            <p>No projects yet.</p>
            <p className="dim">
              Click <strong>+</strong> above to add your first project folder.
            </p>
          </div>
        ) : (
          projects.map((p) => (
            <ProjectBlock
              key={p.id}
              project={p}
              sessions={sessionsByProject[p.id] ?? []}
              selectedId={selectedId}
              onSelect={selectSession}
              onSpawn={() => spawnAgent(p.id)}
              busy={busy}
            />
          ))
        )}
      </div>
    </aside>
  );
}

function ProjectBlock(props: {
  project: Project;
  sessions: Session[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onSpawn: () => void;
  busy: boolean;
}): JSX.Element {
  const { project, sessions, selectedId, onSelect, onSpawn, busy } = props;
  return (
    <div className="project-block">
      <div className="project-head">
        <span className="project-name">{project.name}</span>
        <button
          className="spawn-btn"
          onClick={onSpawn}
          disabled={busy}
          title="Spawn a Claude Code agent in this project"
        >
          + Agent
        </button>
      </div>
      <div className="project-path mono" title={project.path}>
        {project.path}
      </div>
      {sessions.length === 0 ? null : (
        <div className="sessions-list">
          {sessions.map((s) => (
            <button
              key={s.id}
              className={`session-row ${selectedId === s.id ? 'selected' : ''}`}
              onClick={() => onSelect(s.id)}
            >
              <span className="branch">{s.branch}</span>
              <span className={`status status-${s.status}`}>{s.status}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
