import { useEffect, useMemo, useRef, useState } from 'react';
import { useAppStore } from '../store.js';
import type { Project, Session } from '@shared/ipc.js';
import { NewWorktreeDialog } from './NewWorktreeDialog.js';

function randomHex(n: number): string {
  const arr = new Uint8Array(Math.ceil(n / 2));
  crypto.getRandomValues(arr);
  return Array.from(arr, (b) => b.toString(16).padStart(2, '0'))
    .join('')
    .slice(0, n);
}

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
  const [worktreeDialogProject, setWorktreeDialogProject] =
    useState<{ id: string; name: string } | null>(null);
  const [worktreeDefault, setWorktreeDefault] = useState('');

  async function addProject(): Promise<void> {
    setBusy(true);
    try {
      const { path } = await window.code24.call('project.pickFolder', {});
      if (!path) return;
      const { project } = await window.code24.call('project.add', { path });
      // Default: spawn an agent in the new project and focus it in
      // the middle pane so the user can start working immediately.
      try {
        const { session } = await window.code24.call('session.spawn', {
          projectId: project.id,
          backendId: 'claude-code',
        });
        selectSession(session.id);
      } catch (spawnErr) {
        // Project add succeeded — spawn is a best-effort follow-up.
        console.warn('[code24] auto-spawn after project.add failed:', spawnErr);
      }
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

  /**
   * Opens the worktree dialog with a suggested branch name. The
   * actual spawn happens in createWorktreeFromDialog when the user
   * confirms. Splitting it this way means the dialog can stay
   * mounted and animate / take real input rather than being a blocking
   * window.prompt.
   */
  function openWorktreeDialog(project: Project): void {
    setWorktreeDefault(`wip-${randomHex(6)}`);
    setWorktreeDialogProject({ id: project.id, name: project.name });
  }

  async function createWorktreeFromDialog(branch: string): Promise<void> {
    const target = worktreeDialogProject;
    if (!target) return;
    setBusy(true);
    try {
      const { session } = await window.code24.call('session.spawn', {
        projectId: target.id,
        backendId: 'claude-code',
        newWorktreeBranch: branch,
      });
      selectSession(session.id);
      setWorktreeDialogProject(null);
    } catch (err) {
      alert(`Worktree spawn failed: ${String(err)}`);
    } finally {
      setBusy(false);
    }
  }

  async function resumeSession(sessionId: string): Promise<void> {
    setBusy(true);
    try {
      const { session } = await window.code24.call('session.resume', { sessionId });
      selectSession(session.id);
    } catch (err) {
      alert(`Resume failed: ${String(err)}`);
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
              onSpawnInWorktree={() => openWorktreeDialog(p)}
              onResume={resumeSession}
              busy={busy}
            />
          ))
        )}
      </div>
      <NewWorktreeDialog
        project={worktreeDialogProject}
        defaultBranch={worktreeDefault}
        onCancel={() => setWorktreeDialogProject(null)}
        onCreate={(branch) => void createWorktreeFromDialog(branch)}
        busy={busy}
      />
    </aside>
  );
}

function ProjectBlock(props: {
  project: Project;
  sessions: Session[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onSpawn: () => void;
  onSpawnInWorktree: () => void;
  onResume: (id: string) => void;
  busy: boolean;
}): JSX.Element {
  const { project, sessions, selectedId, onSelect, onSpawn, onSpawnInWorktree, onResume, busy } = props;
  return (
    <div className="project-block">
      <div className="project-head">
        <span className="project-name">{project.name}</span>
        <SpawnMenu
          onSpawn={onSpawn}
          onSpawnInWorktree={onSpawnInWorktree}
          busy={busy}
        />
      </div>
      <div className="project-path mono" title={project.path}>
        {project.path}
      </div>
      {sessions.length === 0 ? null : (
        <div className="sessions-list">
          {sessions.map((s) => {
            const isEnded = s.status === 'done' || s.status === 'errored';
            const canResume = isEnded && !!s.claudeSessionId;
            const onClick = canResume
              ? () => onResume(s.id)   // resume by default
              : () => onSelect(s.id);  // live OR ended-without-id → just select
            return (
              <button
                key={s.id}
                className={`session-row ${selectedId === s.id ? 'selected' : ''} ${isEnded ? 'ended' : ''}`}
                onClick={onClick}
                disabled={props.busy && canResume}
                title={canResume ? 'Click to resume this Claude session' : `session ${s.id}`}
              >
                <span className="branch">{s.branch}</span>
                <span className={`status status-${s.status}`}>{s.status}</span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

function SpawnMenu(props: {
  onSpawn: () => void;
  onSpawnInWorktree: () => void;
  busy: boolean;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);

  // Close on outside click / Escape.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div className="spawn-menu" ref={ref}>
      <button
        className="spawn-icon-btn"
        onClick={() => setOpen((v) => !v)}
        disabled={props.busy}
        aria-expanded={open}
        aria-haspopup="menu"
        aria-label="Spawn a new session"
        title="Spawn a new session"
      >
        +
      </button>
      {open && (
        <div className="spawn-menu-pop" role="menu">
          <button
            className="spawn-menu-item"
            role="menuitem"
            onClick={() => { setOpen(false); props.onSpawn(); }}
          >
            <span className="spawn-menu-title">New session</span>
            <span className="spawn-menu-sub">
              Run in the project root. Shares files with other sessions.
            </span>
          </button>
          <button
            className="spawn-menu-item"
            role="menuitem"
            onClick={() => { setOpen(false); props.onSpawnInWorktree(); }}
          >
            <span className="spawn-menu-title">New worktree</span>
            <span className="spawn-menu-sub">
              Fresh git worktree on a new branch. Isolated edits.
            </span>
          </button>
        </div>
      )}
    </div>
  );
}
