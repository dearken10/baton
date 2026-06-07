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

  async function renameSession(s: Session): Promise<void> {
    const project = projectsRecord[s.projectId];
    const isWorktreeSession =
      !!project &&
      s.worktreePath !== project.path &&
      s.worktreePath.startsWith(project.path);
    if (!isWorktreeSession) {
      alert(
        'Rename only applies to worktree sessions. Renaming the project root branch would affect every session on this project.'
      );
      return;
    }
    if (s.status !== 'done' && s.status !== 'errored') {
      alert('Stop this session before renaming — files are in use.');
      return;
    }
    const raw = window.prompt(
      'New branch name for this worktree (e.g. tts/fix-retries):',
      s.branch
    );
    if (raw == null) return;
    const branch = raw.trim();
    if (!branch || branch === s.branch) return;
    setBusy(true);
    try {
      await window.code24.call('session.rename', {
        sessionId: s.id,
        newBranchName: branch,
      });
    } catch (err) {
      alert(`Rename failed: ${String(err)}`);
    } finally {
      setBusy(false);
    }
  }

  async function deleteSession(s: Session): Promise<void> {
    const project = projectsRecord[s.projectId];
    const isWorktreeSession =
      !!project &&
      s.worktreePath !== project.path &&
      s.worktreePath.startsWith(project.path);
    const lines = [
      'Delete this session permanently?',
      `branch: ${s.branch}`,
      s.status === 'running' || s.status === 'idle' || s.status === 'needs-input'
        ? '(Claude will be terminated.)'
        : '',
      isWorktreeSession
        ? `Also remove the worktree directory:\n${s.worktreePath}`
        : '',
    ].filter(Boolean).join('\n\n');
    if (!window.confirm(lines)) return;
    setBusy(true);
    try {
      await window.code24.call('session.delete', { sessionId: s.id });
    } catch (err) {
      alert(`Delete failed: ${String(err)}`);
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
              onRename={renameSession}
              onDelete={deleteSession}
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
  onRename: (s: Session) => void;
  onDelete: (s: Session) => void;
  busy: boolean;
}): JSX.Element {
  const { project, sessions, selectedId, onSelect, onSpawn, onSpawnInWorktree, onResume, onRename, onDelete, busy } = props;
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
            const isWorktreeSession =
              s.worktreePath !== project.path &&
              s.worktreePath.startsWith(project.path);
            const canRename = isEnded && isWorktreeSession;
            return (
              <div
                key={s.id}
                className={`session-row ${selectedId === s.id ? 'selected' : ''} ${isEnded ? 'ended' : ''}`}
                onClick={onClick}
                title={canResume ? 'Click to resume this Claude session' : `session ${s.id}`}
              >
                <span className="branch">{s.branch}</span>
                <span className={`status status-${s.status}`}>{s.status}</span>
                <SessionRowMenu
                  canRename={canRename}
                  onRename={() => onRename(s)}
                  onDelete={() => onDelete(s)}
                  busy={busy}
                />
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function SessionRowMenu(props: {
  canRename: boolean;
  onRename: () => void;
  onDelete: () => void;
  busy: boolean;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);

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
    <div
      className="row-menu"
      ref={ref}
      onClick={(e) => e.stopPropagation()}
    >
      <button
        className="row-menu-trigger"
        onClick={() => setOpen((v) => !v)}
        disabled={props.busy}
        aria-expanded={open}
        aria-haspopup="menu"
        aria-label="Session actions"
        title="More actions"
      >
        ⋮
      </button>
      {open && (
        <div className="row-menu-pop" role="menu">
          {props.canRename && (
            <button
              className="row-menu-item"
              role="menuitem"
              onClick={() => { setOpen(false); props.onRename(); }}
            >
              Rename
            </button>
          )}
          <button
            className="row-menu-item danger"
            role="menuitem"
            onClick={() => { setOpen(false); props.onDelete(); }}
          >
            Delete
          </button>
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
