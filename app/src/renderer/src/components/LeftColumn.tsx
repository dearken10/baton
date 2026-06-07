import { useEffect, useMemo, useRef, useState } from 'react';
import { useAppStore } from '../store.js';
import type { Project, Session } from '@shared/ipc.js';
import { NewWorktreeDialog } from './NewWorktreeDialog.js';
import { OrphansBadge } from './OrphansBadge.js';
import { formatTokens } from '../lib/format.js';

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
  const projectOrder = useAppStore((s) => s.projectOrder);
  const sessionOrder = useAppStore((s) => s.sessionOrder);
  const selectedId = useAppStore((s) => s.selectedSessionId);
  const selectSession = useAppStore((s) => s.selectSession);

  // Apply display_order to projects + sessions. Items missing from
  // the order map (e.g. just added) fall to the end, in insertion order.
  const projects = useMemo(() => {
    const all = Object.values(projectsRecord);
    return all.slice().sort((a, b) => {
      const oa = projectOrder[a.id] ?? Number.MAX_SAFE_INTEGER;
      const ob = projectOrder[b.id] ?? Number.MAX_SAFE_INTEGER;
      return oa - ob;
    });
  }, [projectsRecord, projectOrder]);
  const sessions = useMemo(() => {
    const all = Object.values(sessionsRecord);
    return all.slice().sort((a, b) => {
      const oa = sessionOrder[a.id] ?? Number.MAX_SAFE_INTEGER;
      const ob = sessionOrder[b.id] ?? Number.MAX_SAFE_INTEGER;
      return oa - ob;
    });
  }, [sessionsRecord, sessionOrder]);
  const sessionsByProject = useMemo(() => {
    const map: Record<string, Session[]> = {};
    for (const s of sessions) {
      (map[s.projectId] ??= []).push(s);
    }
    return map;
  }, [sessions]);

  /** Generic insert-before reorder. Computes the new full ordering
   *  from `items` (current display order) by moving `fromId` to sit
   *  in front of `beforeId`, then asks the backend to persist it. */
  function reorder<T extends { id: string }>(
    items: T[],
    fromId: string,
    beforeId: string,
    verb: 'project.reorder' | 'session.reorder',
  ): void {
    if (fromId === beforeId) return;
    const fromIdx = items.findIndex((x) => x.id === fromId);
    if (fromIdx < 0) return;
    const arr = items.slice();
    const [moved] = arr.splice(fromIdx, 1);
    if (!moved) return;
    const insertAt = arr.findIndex((x) => x.id === beforeId);
    if (insertAt < 0) arr.push(moved);
    else arr.splice(insertAt, 0, moved);
    const ids = arr.map((x) => x.id);
    void window.code24.call(verb, { orderedIds: ids }).catch(() => { /* best-effort */ });
  }
  const reorderProjects = (fromId: string, beforeId: string): void =>
    reorder(projects, fromId, beforeId, 'project.reorder');
  const reorderSessionsForProject = (projectId: string, fromId: string, beforeId: string): void => {
    const list = sessionsByProject[projectId] ?? [];
    reorder(list, fromId, beforeId, 'session.reorder');
  };

  async function removeProjectFromList(p: Project): Promise<void> {
    const sCount = (sessionsByProject[p.id] ?? []).length;
    const ok = window.confirm(
      `Remove project "${p.name}" from code24?\n\n`
      + `This deletes ${sCount} session row${sCount === 1 ? '' : 's'} from the app.\n`
      + 'The project directory + any worktree directories on disk are NOT touched.'
    );
    if (!ok) return;
    setBusy(true);
    try {
      await window.code24.call('project.remove', { projectId: p.id });
    } catch (err) {
      alert(`Remove failed: ${String(err)}`);
    } finally {
      setBusy(false);
    }
  }

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

  /** Spawn a plain shell session — same xterm + scrollback path as
   *  Claude sessions, just a login shell instead of `claude`. */
  async function spawnTerminal(projectId: string): Promise<void> {
    setBusy(true);
    try {
      const { session } = await window.code24.call('session.spawn', {
        projectId,
        backendId: 'shell',
      });
      selectSession(session.id);
    } catch (err) {
      alert(`Terminal spawn failed: ${String(err)}`);
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
      const msg = String(err);
      // Common race / data path: the session row no longer has a
      // claude_session_id (cleared during boot reconcile because the
      // transcript is missing). Resume can't restore the conversation,
      // but a fresh respawn in the same worktree is usually what the
      // user wanted — offer it instead of a dead-end alert.
      const noHistory =
        msg.includes('no Claude session id') ||
        msg.includes('no transcript');
      if (noHistory) {
        const ok = window.confirm(
          "This session's prior conversation can't be restored "
          + '(it likely ended before any user message was sent).\n\n'
          + 'Start a fresh Claude session in the same worktree instead?'
        );
        if (!ok) return;
        try {
          const { session } = await window.code24.call('session.respawn', { sessionId });
          selectSession(session.id);
        } catch (respErr) {
          alert(`Spawn failed: ${String(respErr)}`);
        }
        return;
      }
      alert(`Resume failed: ${msg}`);
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
    const isLive = s.status !== 'done' && s.status !== 'errored';
    if (isLive) {
      const ok = window.confirm(
        [
          'This session is still running and Claude has files open in the worktree.',
          'To rename, code24 will stop the session first (you can resume it after).',
          '',
          'Continue?',
        ].join('\n')
      );
      if (!ok) return;
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
      if (isLive) {
        await window.code24.call('session.kill', { sessionId: s.id });
        // Wait for the exit handler to flip the row to done/errored and
        // free file handles before we move the worktree dir.
        await new Promise((r) => setTimeout(r, 800));
      }
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
        <span>Projects</span>
        <div className="col-head-actions">
          <OrphansBadge />
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
              onGetInfo={() => window.alert(`${p.name}\n\n${p.path}`)}
              onNewTerminal={() => void spawnTerminal(p.id)}
              onRemoveProject={() => void removeProjectFromList(p)}
              onReorderProjects={reorderProjects}
              onReorderSessions={(fromId, beforeId) =>
                reorderSessionsForProject(p.id, fromId, beforeId)
              }
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

interface ProjectBlockProps {
  project: Project;
  sessions: Session[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onSpawn: () => void;
  onSpawnInWorktree: () => void;
  onResume: (id: string) => void;
  onRename: (s: Session) => void;
  onDelete: (s: Session) => void;
  onGetInfo: () => void;
  onNewTerminal: () => void;
  onRemoveProject: () => void;
  onReorderProjects: (fromId: string, beforeId: string) => void;
  onReorderSessions: (fromId: string, beforeId: string) => void;
  busy: boolean;
}

/** HTML5 drag id markers used so we can tell project drags from
 *  session drags on drop — text/plain alone wouldn't distinguish. */
const DRAG_PROJECT = 'application/x-code24-project';
const DRAG_SESSION = 'application/x-code24-session';

function ProjectBlock(props: ProjectBlockProps): JSX.Element {
  const {
    project, sessions, selectedId,
    onSelect, onSpawn, onSpawnInWorktree, onResume, onRename, onDelete,
    onGetInfo, onNewTerminal, onRemoveProject, onReorderProjects, onReorderSessions,
    busy,
  } = props;
  const [isDragOver, setDragOver] = useState(false);

  return (
    <div
      className={`project-block${isDragOver ? ' drag-over' : ''}`}
      draggable={true}
      onDragStart={(e) => {
        e.dataTransfer.setData(DRAG_PROJECT, project.id);
        // text/plain fallback for browsers that ignore the custom MIME.
        e.dataTransfer.setData('text/plain', project.id);
        e.dataTransfer.effectAllowed = 'move';
      }}
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes(DRAG_PROJECT)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        setDragOver(true);
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => {
        setDragOver(false);
        const fromId = e.dataTransfer.getData(DRAG_PROJECT);
        if (!fromId) return;
        e.preventDefault();
        onReorderProjects(fromId, project.id);
      }}
    >
      <div className="project-head">
        <span className="project-name" title={project.path}>{project.name}</span>
        <SpawnMenu
          onSpawn={onSpawn}
          onSpawnInWorktree={onSpawnInWorktree}
          onGetInfo={onGetInfo}
          onNewTerminal={onNewTerminal}
          onRemoveProject={onRemoveProject}
          busy={busy}
        />
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
            // Type-specific badge at the start of the row so the user
            // can scan the list at a glance:
            //   💬 = Claude session in the project root (shared FS)
            //   🌿 = Claude session in a worktree branch (isolated)
            //   ❯  = plain login shell (terminal)
            const badge =
              s.backendId === 'shell' ? { glyph: '❯',  cls: 'badge-shell' }
              : isWorktreeSession    ? { glyph: '🌿', cls: 'badge-worktree' }
              :                        { glyph: '💬', cls: 'badge-session' };
            // We only want the chip to draw attention when something
            // worth noting is happening:
            //   - shell sessions while live → no chip (they're just open)
            //   - Claude sessions at `idle` → no chip (boring default state)
            //   - everything else (running / needs-input / paused / done /
            //     errored / disconnected) → chip stays so the user sees it.
            const shellLive = s.backendId === 'shell' && !isEnded;
            const showStatusChip = !shellLive && s.status !== 'idle';
            // Rename is shown for ALL worktree sessions; for live ones
            // the handler will offer to stop the session first.
            const canRename = isWorktreeSession;
            return (
              <div
                key={s.id}
                className={`session-row ${selectedId === s.id ? 'selected' : ''} ${isEnded ? 'ended' : ''}`}
                onClick={onClick}
                title={canResume ? 'Click to resume this Claude session' : `session ${s.id}`}
                draggable={true}
                onDragStart={(e) => {
                  e.stopPropagation(); // don't trigger project drag
                  e.dataTransfer.setData(DRAG_SESSION, s.id);
                  e.dataTransfer.setData('text/plain', s.id);
                  e.dataTransfer.effectAllowed = 'move';
                }}
                onDragOver={(e) => {
                  if (!e.dataTransfer.types.includes(DRAG_SESSION)) return;
                  e.stopPropagation();
                  e.preventDefault();
                  e.dataTransfer.dropEffect = 'move';
                }}
                onDrop={(e) => {
                  const fromId = e.dataTransfer.getData(DRAG_SESSION);
                  if (!fromId) return;
                  e.stopPropagation();
                  e.preventDefault();
                  onReorderSessions(fromId, s.id);
                }}
              >
                <div className="session-row-main">
                  <span className="branch">
                    <span className={`session-badge ${badge.cls}`} aria-hidden>{badge.glyph}</span>
                    {s.branch}
                  </span>
                  {s.lastSummary ? (
                    <span className="session-intent" title={s.lastSummary}>
                      {s.lastSummary}
                    </span>
                  ) : null}
                </div>
                {s.tokensIn + s.tokensOut > 0 ? (
                  <span
                    className="tokens"
                    title={`${s.tokensIn.toLocaleString()} in · ${s.tokensOut.toLocaleString()} out`}
                  >
                    {formatTokens(s.tokensIn + s.tokensOut)}
                  </span>
                ) : null}
                {showStatusChip ? (
                  <span className={`status status-${s.status}`}>{s.status}</span>
                ) : null}
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
  onGetInfo: () => void;
  onNewTerminal: () => void;
  onRemoveProject: () => void;
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
        aria-label="Project actions"
        title="Project actions"
      >
        ⋮
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
          <button
            className="spawn-menu-item"
            role="menuitem"
            onClick={() => { setOpen(false); props.onNewTerminal(); }}
          >
            <span className="spawn-menu-title">New Terminal</span>
            <span className="spawn-menu-sub">
              Open the project folder in your system terminal app.
            </span>
          </button>
          <button
            className="spawn-menu-item"
            role="menuitem"
            onClick={() => { setOpen(false); props.onGetInfo(); }}
          >
            <span className="spawn-menu-title">Get Info</span>
            <span className="spawn-menu-sub">
              Show the project's folder path.
            </span>
          </button>
          <button
            className="spawn-menu-item danger"
            role="menuitem"
            onClick={() => { setOpen(false); props.onRemoveProject(); }}
          >
            <span className="spawn-menu-title">Remove project</span>
            <span className="spawn-menu-sub">
              Drops the project + its session rows from code24. Files
              on disk are untouched.
            </span>
          </button>
        </div>
      )}
    </div>
  );
}
