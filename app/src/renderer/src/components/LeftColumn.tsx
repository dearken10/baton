import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useAppStore } from '../store.js';
import type { ConnectionProfile, Project, Session } from '@shared/ipc.js';
import { NewWorktreeDialog } from './NewWorktreeDialog.js';
import { NewTerminalDialog, type NewTerminalChoice } from './NewTerminalDialog.js';
import { PromptDialog } from './PromptDialog.js';
import { AddProjectDialog } from './AddProjectDialog.js';
import { OrphansBadge } from './OrphansBadge.js';
import { formatTokens } from '../lib/format.js';

function randomHex(n: number): string {
  const arr = new Uint8Array(Math.ceil(n / 2));
  crypto.getRandomValues(arr);
  return Array.from(arr, (b) => b.toString(16).padStart(2, '0'))
    .join('')
    .slice(0, n);
}

/** Per-project collapse state. Persisted as a sparse map of
 *  `{ [projectId]: true }` — only collapsed projects are recorded, so
 *  newly-added projects default to expanded without needing to touch
 *  every existing entry. */
const PROJECT_COLLAPSED_LS_KEY = 'baton:project:collapsed';
function loadProjectCollapsed(id: string): boolean {
  try {
    const raw = localStorage.getItem(PROJECT_COLLAPSED_LS_KEY);
    if (!raw) return false;
    const parsed = JSON.parse(raw) as Record<string, boolean>;
    return parsed[id] === true;
  } catch { return false; }
}
function saveProjectCollapsed(id: string, collapsed: boolean): void {
  try {
    const raw = localStorage.getItem(PROJECT_COLLAPSED_LS_KEY);
    const parsed = raw ? (JSON.parse(raw) as Record<string, boolean>) : {};
    if (collapsed) parsed[id] = true;
    else delete parsed[id];
    localStorage.setItem(PROJECT_COLLAPSED_LS_KEY, JSON.stringify(parsed));
  } catch { /* localStorage quota / disabled — best-effort */ }
}

export function LeftColumn(): JSX.Element {
  const projectsRecord = useAppStore((s) => s.projects);
  const sessionsRecord = useAppStore((s) => s.sessions);
  const projectOrder = useAppStore((s) => s.projectOrder);
  const sessionOrder = useAppStore((s) => s.sessionOrder);
  const connections = useAppStore((s) => s.connections);
  const selectedId = useAppStore((s) => s.selectedSessionId);
  const selectSession = useAppStore((s) => s.selectSession);

  // Active vs. snoozed view. Snoozed projects are kept out of the
  // main list so the user can focus; counts on the toggle make sure
  // they aren't forgotten.
  const [view, setView] = useState<'active' | 'snoozed'>('active');

  // Apply display_order to projects + sessions. Items missing from
  // the order map (e.g. just added) fall to the end, in insertion order.
  const allProjects = useMemo(() => {
    const all = Object.values(projectsRecord);
    return all.slice().sort((a, b) => {
      const oa = projectOrder[a.id] ?? Number.MAX_SAFE_INTEGER;
      const ob = projectOrder[b.id] ?? Number.MAX_SAFE_INTEGER;
      return oa - ob;
    });
  }, [projectsRecord, projectOrder]);
  const activeProjects = useMemo(
    () => allProjects.filter((p) => p.snoozedAt == null),
    [allProjects],
  );
  const snoozedProjects = useMemo(
    () => allProjects.filter((p) => p.snoozedAt != null),
    [allProjects],
  );
  const projects = view === 'active' ? activeProjects : snoozedProjects;
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
    void window.baton.call(verb, { orderedIds: ids }).catch(() => { /* best-effort */ });
  }
  // Reorder always operates on the full project list — display_order
  // is a single global ordering, even though the UI only shows a
  // filtered subset (active OR snoozed). This keeps snoozed-vs-active
  // positions from colliding when items move within one bucket.
  const reorderProjects = (fromId: string, beforeId: string): void =>
    reorder(allProjects, fromId, beforeId, 'project.reorder');
  const reorderSessionsForProject = (projectId: string, fromId: string, beforeId: string): void => {
    const list = sessionsByProject[projectId] ?? [];
    reorder(list, fromId, beforeId, 'session.reorder');
  };

  async function toggleSnoozeProject(p: Project): Promise<void> {
    const snoozed = p.snoozedAt == null; // flipping
    setBusy(true);
    try {
      await window.baton.call('project.setSnoozed', {
        projectId: p.id,
        snoozed,
      });
    } catch (err) {
      alert(`${snoozed ? 'Snooze' : 'Unsnooze'} failed: ${String(err)}`);
    } finally {
      setBusy(false);
    }
  }

  async function removeProjectFromList(p: Project): Promise<void> {
    const sCount = (sessionsByProject[p.id] ?? []).length;
    const ok = window.confirm(
      `Remove project "${p.name}" from baton?\n\n`
      + `This deletes ${sCount} session row${sCount === 1 ? '' : 's'} from the app.\n`
      + 'The project directory + any worktree directories on disk are NOT touched.'
    );
    if (!ok) return;
    setBusy(true);
    try {
      await window.baton.call('project.remove', { projectId: p.id });
    } catch (err) {
      alert(`Remove failed: ${String(err)}`);
    } finally {
      setBusy(false);
    }
  }

  // window.prompt() isn't supported in Electron renderers; we open a
  // small inline PromptDialog instead. State holds the current project
  // being renamed (null when the dialog is closed).
  const [renamingProject, setRenamingProject] = useState<Project | null>(null);
  function renameProjectInList(p: Project): void {
    setRenamingProject(p);
  }
  async function submitProjectRename(newName: string): Promise<void> {
    const p = renamingProject;
    setRenamingProject(null);
    if (!p) return;
    setBusy(true);
    try {
      await window.baton.call('project.rename', { projectId: p.id, newName });
    } catch (err) {
      alert(`Rename failed: ${String(err)}`);
    } finally {
      setBusy(false);
    }
  }

  const [busy, setBusy] = useState(false);
  const [worktreeDialogProject, setWorktreeDialogProject] =
    useState<{ id: string; name: string; backendId: 'claude-code' | 'codex' } | null>(null);
  const [worktreeDefault, setWorktreeDefault] = useState('');
  const [showAddProjectDialog, setShowAddProjectDialog] = useState(false);

  // Spawn-in-flight markers live in the store (see store.ts) so the
  // sidebar row and the MiddleColumn "Start fresh…" button reflect
  // the same pending state. Read here, write via `setSessionPending`.
  const pendingSessionIds = useAppStore((s) => s.pendingSessionIds);
  const setSessionPending = useAppStore((s) => s.setSessionPending);
  const markPending = useCallback((sid: string, on: boolean): void => {
    setSessionPending(sid, on);
  }, [setSessionPending]);

  async function onProjectAdded(project: Project): Promise<void> {
    setShowAddProjectDialog(false);
    setBusy(true);
    try {
      const { session } = await window.baton.call('session.spawn', {
        projectId: project.id,
        backendId: 'claude-code',
      });
      selectSession(session.id);
    } catch (spawnErr) {
      // Remote spawns can fail when the master can't reach the host or
      // claude isn't installed there. Surface so the user knows their
      // project was added but no session came up.
      const conn = connections[project.connectionId];
      const isRem = !!conn && conn.kind !== 'local';
      if (isRem) {
        alert(
          `Project added, but auto-spawn failed:\n\n${String(spawnErr)}\n\n` +
          `Use the project menu's "New session" once you've fixed it.`
        );
      } else {
        console.warn('[baton] auto-spawn after project add failed:', spawnErr);
      }
    } finally {
      setBusy(false);
    }
  }

  function addProject(): void {
    setShowAddProjectDialog(true);
  }

  async function spawnAgent(projectId: string): Promise<void> {
    setBusy(true);
    try {
      const { session } = await window.baton.call('session.spawn', {
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

  /** Spawn a Codex session in the project root. Same xterm + hook
   *  plumbing path Claude uses; backend writes a per-session profile
   *  TOML and spawns `codex -p baton-<sid>`. */
  async function spawnCodexAgent(projectId: string): Promise<void> {
    setBusy(true);
    try {
      const { session } = await window.baton.call('session.spawn', {
        projectId,
        backendId: 'codex',
      });
      selectSession(session.id);
    } catch (err) {
      alert(`Codex spawn failed: ${String(err)}`);
    } finally {
      setBusy(false);
    }
  }

  // "New terminal" opens a picker so the user can choose project root /
  // existing worktree / new worktree from base. The actual spawn fires
  // in submitNewTerminal() once they confirm. A direct one-click spawn
  // in the project root would skip the choice; the dialog adds one
  // click but unlocks the worktree cases without growing the menu.
  const [terminalDialogProject, setTerminalDialogProject] =
    useState<{ id: string; name: string; path: string } | null>(null);
  function openTerminalDialog(p: Project): void {
    setTerminalDialogProject({ id: p.id, name: p.name, path: p.path });
  }
  async function submitNewTerminal(choice: NewTerminalChoice): Promise<void> {
    const target = terminalDialogProject;
    if (!target) return;
    setBusy(true);
    try {
      const params: Parameters<typeof window.baton.call<'session.spawn'>>[1] = {
        projectId: target.id,
        backendId: 'shell',
      };
      if (choice.mode === 'existing') {
        params.existingWorktreePath = choice.worktreePath;
      }
      const { session } = await window.baton.call('session.spawn', params);
      selectSession(session.id);
      setTerminalDialogProject(null);
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
  function openWorktreeDialog(
    project: Project,
    backendId: 'claude-code' | 'codex' = 'claude-code',
  ): void {
    setWorktreeDefault(`wip-${randomHex(6)}`);
    setWorktreeDialogProject({ id: project.id, name: project.name, backendId });
  }

  async function createWorktreeFromDialog(branch: string): Promise<void> {
    const target = worktreeDialogProject;
    if (!target) return;
    setBusy(true);
    try {
      const { session } = await window.baton.call('session.spawn', {
        projectId: target.id,
        backendId: target.backendId,
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

  /** Auto-start the session: prefer resume (preserves conversation
   *  history), fall back silently to respawn if there's nothing to
   *  resume from. Replaces the old "show Session-ended panel → user
   *  clicks button" two-step. Bound to row clicks for any ended
   *  session — local or remote — so the user just clicks once.
   *
   *  The previous "do you want to start fresh?" confirm dialog is
   *  intentionally gone. For remote sessions where the transcript was
   *  never written, the dialog was just an extra click for an answer
   *  ("yes, start fresh") that's always what the user wanted. */
  async function resumeSession(sessionId: string): Promise<void> {
    if (pendingSessionIds.has(sessionId)) return;
    markPending(sessionId, true);
    try {
      const sess = sessionsRecord[sessionId];
      const hasHistory = !!sess?.claudeSessionId;
      let res: { session: Session };
      if (hasHistory) {
        try {
          res = await window.baton.call('session.resume', { sessionId });
        } catch (err) {
          const msg = String(err);
          const noHistory =
            msg.includes('no Claude session id') ||
            msg.includes('no transcript');
          if (!noHistory) throw err;
          // Fall through to a fresh spawn in the same cwd.
          res = await window.baton.call('session.respawn', { sessionId });
        }
      } else {
        // No captured claude_session_id (cleared, shell session, etc.)
        // — go straight to a fresh spawn.
        res = await window.baton.call('session.respawn', { sessionId });
      }
      selectSession(res.session.id);
    } catch (err) {
      alert(`Start failed: ${String(err)}`);
    } finally {
      markPending(sessionId, false);
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
          'To rename, baton will stop the session first (you can resume it after).',
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
        await window.baton.call('session.kill', { sessionId: s.id });
        // Wait for the exit handler to flip the row to done/errored and
        // free file handles before we move the worktree dir.
        await new Promise((r) => setTimeout(r, 800));
      }
      await window.baton.call('session.rename', {
        sessionId: s.id,
        newBranchName: branch,
      });
    } catch (err) {
      alert(`Rename failed: ${String(err)}`);
    } finally {
      setBusy(false);
    }
  }

  async function toggleSnoozeSession(s: Session): Promise<void> {
    const snoozed = s.snoozedAt == null; // flipping
    setBusy(true);
    try {
      await window.baton.call('session.setSnoozed', {
        sessionId: s.id,
        snoozed,
      });
    } catch (err) {
      alert(`${snoozed ? 'Snooze' : 'Unsnooze'} failed: ${String(err)}`);
    } finally {
      setBusy(false);
    }
  }

  async function cloneSession(s: Session): Promise<void> {
    if (s.backendId !== 'claude-code' && s.backendId !== 'codex') return;
    if (!s.claudeSessionId) {
      alert(
        'Cannot clone — the agent session id has not been captured yet. ' +
        'Send the agent a first prompt and try again.'
      );
      return;
    }
    setBusy(true);
    try {
      const { session } = await window.baton.call('session.clone', {
        sessionId: s.id,
      });
      selectSession(session.id);
    } catch (err) {
      alert(`Clone failed: ${String(err)}`);
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
      await window.baton.call('session.delete', { sessionId: s.id });
    } catch (err) {
      alert(`Delete failed: ${String(err)}`);
    } finally {
      setBusy(false);
    }
  }

  const activeCount = activeProjects.length;
  const snoozedCount = snoozedProjects.length;
  // Auto-flip back to active when the user unsnoozes the last item in
  // the snoozed view — otherwise the snoozed tab disappears and they
  // end up looking at an empty pane.
  useEffect(() => {
    if (view === 'snoozed' && snoozedCount === 0) setView('active');
  }, [view, snoozedCount]);

  return (
    <aside className="col col-left">
      <div className="col-head">
        <span className="col-head-title">
          <span>Projects</span>
          {snoozedCount > 0 || view === 'snoozed' ? (
            <span className="view-toggle" role="tablist" aria-label="Project view">
              <button
                role="tab"
                aria-selected={view === 'active'}
                onClick={() => setView('active')}
              >
                Active <span className="count">{activeCount}</span>
              </button>
              <button
                role="tab"
                aria-selected={view === 'snoozed'}
                onClick={() => setView('snoozed')}
              >
                Snoozed <span className="count">{snoozedCount}</span>
              </button>
            </span>
          ) : null}
        </span>
        <div className="col-head-actions">
          {view === 'active' ? (
            <>
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
            </>
          ) : null}
        </div>
      </div>
      <div className="col-body">
        {projects.length === 0 ? (
          view === 'active' ? (
            <div className="empty">
              <p>No projects yet.</p>
              <p className="dim">
                Click <strong>+</strong> above to add your first project folder.
              </p>
            </div>
          ) : (
            <div className="empty">
              <p>No snoozed projects.</p>
              <p className="dim">
                Snooze a project from its <strong>⋮</strong> menu to move it here.
              </p>
            </div>
          )
        ) : (
          projects.map((p) => (
            <ProjectBlock
              key={p.id}
              project={p}
              connection={connections[p.connectionId]}
              sessions={sessionsByProject[p.id] ?? []}
              selectedId={selectedId}
              onSelect={selectSession}
              onSpawnSession={(backend) =>
                backend === 'codex'
                  ? void spawnCodexAgent(p.id)
                  : void spawnAgent(p.id)
              }
              onSpawnNewWorktree={(backend) => openWorktreeDialog(p, backend)}
              onResume={resumeSession}
              onRename={renameSession}
              onDelete={deleteSession}
              onClone={cloneSession}
              onToggleSessionSnooze={toggleSnoozeSession}
              onGetInfo={() => {
                const conn = connections[p.connectionId];
                const isRem = !!conn && conn.kind !== 'local';
                const lines = [
                  p.name,
                  '',
                  isRem && conn
                    ? `Remote: ${conn.name} (${conn.user}@${conn.host}${conn.port && conn.port !== 22 ? `:${conn.port}` : ''})`
                    : 'Local Mac',
                  p.path,
                ];
                window.alert(lines.join('\n'));
              }}
              onNewTerminal={() => openTerminalDialog(p)}
              onRenameProject={() => renameProjectInList(p)}
              onRemoveProject={() => void removeProjectFromList(p)}
              onToggleSnooze={() => void toggleSnoozeProject(p)}
              onReorderProjects={reorderProjects}
              onReorderSessions={(fromId, beforeId) =>
                reorderSessionsForProject(p.id, fromId, beforeId)
              }
              busy={busy}
              pendingSessionIds={pendingSessionIds}
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
      <NewTerminalDialog
        project={terminalDialogProject}
        onCancel={() => setTerminalDialogProject(null)}
        onConfirm={(choice) => void submitNewTerminal(choice)}
        busy={busy}
      />
      {renamingProject ? (
        <PromptDialog
          title={`Rename project`}
          label="New name"
          initialValue={renamingProject.name}
          confirmLabel="Rename"
          onCancel={() => setRenamingProject(null)}
          onConfirm={(v) => void submitProjectRename(v)}
        />
      ) : null}
      {showAddProjectDialog ? (
        <AddProjectDialog
          busy={busy}
          onCancel={() => setShowAddProjectDialog(false)}
          onAdded={(p) => void onProjectAdded(p)}
        />
      ) : null}
    </aside>
  );
}

interface ProjectBlockProps {
  project: Project;
  connection: ConnectionProfile | undefined;
  sessions: Session[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onSpawnSession: (backend: 'claude-code' | 'codex') => void;
  onSpawnNewWorktree: (backend: 'claude-code' | 'codex') => void;
  onResume: (id: string) => void;
  onRename: (s: Session) => void;
  onDelete: (s: Session) => void;
  onClone: (s: Session) => void;
  onToggleSessionSnooze: (s: Session) => void;
  onGetInfo: () => void;
  onNewTerminal: () => void;
  onRenameProject: () => void;
  onRemoveProject: () => void;
  onToggleSnooze: () => void;
  onReorderProjects: (fromId: string, beforeId: string) => void;
  onReorderSessions: (fromId: string, beforeId: string) => void;
  busy: boolean;
  /** Session ids whose resume/respawn is in flight. Rows in this set
   *  render a "Starting…" indicator and swallow clicks. */
  pendingSessionIds: Set<string>;
}

/** HTML5 drag id markers used so we can tell project drags from
 *  session drags on drop — text/plain alone wouldn't distinguish. */
const DRAG_PROJECT = 'application/x-baton-project';
const DRAG_SESSION = 'application/x-baton-session';

function ProjectBlock(props: ProjectBlockProps): JSX.Element {
  const {
    project, connection, sessions, selectedId,
    onSelect, onSpawnSession, onSpawnNewWorktree, onResume, onRename, onDelete, onClone, onToggleSessionSnooze,
    onGetInfo, onNewTerminal, onRenameProject, onRemoveProject, onToggleSnooze, onReorderProjects, onReorderSessions,
    busy, pendingSessionIds,
  } = props;
  const [isDragOver, setDragOver] = useState(false);
  const [collapsed, setCollapsed] = useState(() => loadProjectCollapsed(project.id));
  function toggleCollapsed(): void {
    setCollapsed((prev) => {
      const next = !prev;
      saveProjectCollapsed(project.id, next);
      return next;
    });
  }
  // While collapsed, surface the project's most-attention-worthy child
  // state so the user doesn't have to expand to know something is up.
  // Priority: running > needs-input > nothing. The filter has to mirror
  // the per-row chip's `showStatusChip` — otherwise the aggregate would
  // light up for child rows that themselves show no chip, which reads
  // as a bug:
  //   - Snoozed sessions are explicitly muted; they shouldn't pull focus.
  //   - Shell sessions are always `running` for their lifetime (a login
  //     shell, a dev server, …) — counting them would pin the project
  //     to RUNNING even after every agent child has gone idle.
  const aggregateStatus = useMemo<'running' | 'needs-input' | null>(() => {
    if (!collapsed) return null;
    let needs = false;
    for (const s of sessions) {
      if (s.snoozedAt != null) continue;
      if (s.backendId === 'shell') continue;
      if (s.status === 'running') return 'running';
      if (s.status === 'needs-input') needs = true;
    }
    return needs ? 'needs-input' : null;
  }, [collapsed, sessions]);
  const isSnoozed = project.snoozedAt != null;
  const isRemote = !!connection && connection.kind !== 'local';
  const remoteSublabel = isRemote && connection
    ? `${connection.user ?? ''}@${connection.host ?? ''}${connection.port && connection.port !== 22 ? `:${connection.port}` : ''}:${project.path}`
    : project.path;

  return (
    <div
      className={`project-block${isDragOver ? ' drag-over' : ''}${isSnoozed ? ' snoozed' : ''}`}
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
        <button
          type="button"
          className="project-collapse-btn"
          onClick={toggleCollapsed}
          aria-expanded={!collapsed}
          aria-label={collapsed ? 'Expand project' : 'Collapse project'}
          title={collapsed ? 'Expand' : 'Collapse'}
        >
          <span className="project-collapse-caret">{collapsed ? '▶' : '▼'}</span>
        </button>
        <span className="project-name" title={remoteSublabel}>
          {isRemote ? (
            <span
              className="project-conn-chip"
              title={connection ? `Remote: ${connection.name}` : 'Remote'}
              aria-label="Remote project"
            >
              🛰
            </span>
          ) : null}
          {project.name}
          {isSnoozed ? <span className="snooze-meta">snoozed</span> : null}
          {collapsed && sessions.length > 0 ? (
            <span className="project-collapsed-count dim" aria-label={`${sessions.length} hidden sessions`}>
              · {sessions.length}
            </span>
          ) : null}
        </span>
        {aggregateStatus ? (
          <span
            className={`status status-${aggregateStatus} project-agg-status`}
            title={aggregateStatus === 'running'
              ? 'At least one session in this project is running'
              : 'At least one session in this project needs input'}
          >
            {aggregateStatus}
          </span>
        ) : null}
        <SpawnMenu
          isSnoozed={isSnoozed}
          onSpawnSession={onSpawnSession}
          onSpawnNewWorktree={onSpawnNewWorktree}
          onGetInfo={onGetInfo}
          onNewTerminal={onNewTerminal}
          onRename={onRenameProject}
          onRemoveProject={onRemoveProject}
          onToggleSnooze={onToggleSnooze}
          busy={busy}
        />
      </div>
      {collapsed || sessions.length === 0 ? null : (
        <div className="sessions-list">
          {sessions.map((s) => {
            const isEnded = s.status === 'done' || s.status === 'errored';
            const isPending = pendingSessionIds.has(s.id);
            // Click on an ended row auto-starts the session (resume if
            // claude_session_id is around, respawn otherwise). The user
            // doesn't have to chase a "Start fresh session here" button
            // in the middle column anymore — one click brings the
            // session back up. Pending rows absorb clicks so rapid
            // double-clicks don't queue duplicate spawns. Live rows
            // just select (the click selects the row for the
            // right-column inspector to follow).
            const onClick = isPending
              ? () => onSelect(s.id)
              : isEnded
                ? () => onResume(s.id)
                : () => onSelect(s.id);
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
            // Only three chips render in the sidebar:
            //   1. running       — agent is actively working
            //   2. needs-input   — agent is blocked on a tool prompt
            //   3. starting      — spawn/resume IPC is in flight
            //                      (driven by `isPending`, not s.status)
            // Everything else (idle, done, errored, paused, disconnected)
            // stays unchipped — the row's other affordances (ended-row
            // styling, the middle column's "Session ended" view) carry
            // that information without piling it onto every list row.
            const isShell = s.backendId === 'shell';
            const isSnoozed = s.snoozedAt != null;
            const showStatusChip =
              !isShell && !isSnoozed &&
              (s.status === 'running' || s.status === 'needs-input');
            // Rename is shown for ALL worktree sessions; for live ones
            // the handler will offer to stop the session first.
            const canRename = isWorktreeSession;
            // Clone is only meaningful for the two agent backends and
            // only once the agent's own session id has been captured
            // (without it we have nothing to --resume). Hidden entirely
            // for shell / pending / not-yet-captured rows so the menu
            // doesn't gain a permanently-disabled item.
            const canClone =
              (s.backendId === 'claude-code' || s.backendId === 'codex') &&
              !!s.claudeSessionId;
            return (
              <div
                key={s.id}
                className={`session-row ${selectedId === s.id ? 'selected' : ''} ${isEnded ? 'ended' : ''}${isPending ? ' pending' : ''}`}
                onClick={onClick}
                title={
                  isPending
                    ? 'Starting…'
                    : isEnded
                      ? 'Click to start this session'
                      : `session ${s.id}`
                }
                aria-busy={isPending || undefined}
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
                {isPending ? (
                  <span className="status status-starting" aria-live="polite">
                    <span className="status-spinner" aria-hidden />
                    starting
                  </span>
                ) : showStatusChip ? (
                  <span className={`status status-${s.status}`}>{s.status}</span>
                ) : null}
                <SessionRowMenu
                  canRename={canRename}
                  canClone={canClone}
                  isSnoozed={isSnoozed}
                  onRename={() => onRename(s)}
                  onDelete={() => onDelete(s)}
                  onClone={() => onClone(s)}
                  onToggleSnooze={() => onToggleSessionSnooze(s)}
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
  canClone: boolean;
  isSnoozed: boolean;
  onRename: () => void;
  onDelete: () => void;
  onClone: () => void;
  onToggleSnooze: () => void;
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
          {props.canClone && (
            <button
              className="row-menu-item"
              role="menuitem"
              onClick={() => { setOpen(false); props.onClone(); }}
              title="Copy this session's transcript under a new id and resume it as a new session"
            >
              Clone
            </button>
          )}
          <button
            className="row-menu-item"
            role="menuitem"
            onClick={() => { setOpen(false); props.onToggleSnooze(); }}
          >
            {props.isSnoozed ? 'Unsnooze' : 'Snooze'}
          </button>
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

type SpawnMenuView = 'main' | 'new' | 'session' | 'worktree';

function SpawnMenu(props: {
  isSnoozed: boolean;
  onSpawnSession: (backend: 'claude-code' | 'codex') => void;
  onSpawnNewWorktree: (backend: 'claude-code' | 'codex') => void;
  onGetInfo: () => void;
  onNewTerminal: () => void;
  onRename: () => void;
  onRemoveProject: () => void;
  onToggleSnooze: () => void;
  busy: boolean;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  // Nested view stack: main → new → session/worktree. Reset to 'main'
  // whenever the menu closes so the next open starts at the top.
  const [view, setView] = useState<SpawnMenuView>('main');
  const ref = useRef<HTMLDivElement | null>(null);

  // Close on outside click / Escape. Escape from a sub-view first
  // pops back; from main it closes the whole menu.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
        setView('main');
      }
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return;
      if (view === 'main') { setOpen(false); return; }
      if (view === 'session' || view === 'worktree') { setView('new'); return; }
      setView('main');
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, view]);

  const close = (): void => { setOpen(false); setView('main'); };

  return (
    <div className="spawn-menu" ref={ref}>
      <button
        className="spawn-icon-btn"
        onClick={() => { setOpen((v) => !v); setView('main'); }}
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
          {view === 'main' && (
            <>
              <button
                className="spawn-menu-item"
                role="menuitem"
                onClick={() => setView('new')}
              >
                <span className="spawn-menu-title">New Session ▸</span>
                <span className="spawn-menu-sub">
                  Spawn a Session, Worktree, or Terminal here.
                </span>
              </button>
              <button
                className="spawn-menu-item"
                role="menuitem"
                onClick={() => { close(); props.onGetInfo(); }}
              >
                <span className="spawn-menu-title">Get Info</span>
                <span className="spawn-menu-sub">
                  Show the project's folder path.
                </span>
              </button>
              <button
                className="spawn-menu-item"
                role="menuitem"
                onClick={() => { close(); props.onRename(); }}
              >
                <span className="spawn-menu-title">Rename…</span>
                <span className="spawn-menu-sub">
                  Change the display name. Folder on disk isn't renamed.
                </span>
              </button>
              <button
                className="spawn-menu-item"
                role="menuitem"
                onClick={() => { close(); props.onToggleSnooze(); }}
              >
                <span className="spawn-menu-title">
                  {props.isSnoozed ? 'Unsnooze' : 'Snooze'}
                </span>
                <span className="spawn-menu-sub">
                  {props.isSnoozed
                    ? 'Move back to the Active list.'
                    : 'Hide from the Active list. Sessions are kept.'}
                </span>
              </button>
              <button
                className="spawn-menu-item danger"
                role="menuitem"
                onClick={() => { close(); props.onRemoveProject(); }}
              >
                <span className="spawn-menu-title">Remove project</span>
                <span className="spawn-menu-sub">
                  Drops the project + its session rows from baton. Files
                  on disk are untouched.
                </span>
              </button>
            </>
          )}
          {view === 'new' && (
            <>
              <BackRow onClick={() => setView('main')} />
              <button
                className="spawn-menu-item"
                role="menuitem"
                onClick={() => setView('session')}
              >
                <span className="spawn-menu-title">Session ▸</span>
                <span className="spawn-menu-sub">
                  Run an agent in the project root. Shared workspace.
                </span>
              </button>
              <button
                className="spawn-menu-item"
                role="menuitem"
                onClick={() => setView('worktree')}
              >
                <span className="spawn-menu-title">Worktree ▸</span>
                <span className="spawn-menu-sub">
                  Fresh git worktree on a new branch. Isolated edits.
                </span>
              </button>
              <button
                className="spawn-menu-item"
                role="menuitem"
                onClick={() => { close(); props.onNewTerminal(); }}
              >
                <span className="spawn-menu-title">Terminal</span>
                <span className="spawn-menu-sub">
                  A plain login shell in the project root.
                </span>
              </button>
            </>
          )}
          {view === 'session' && (
            <>
              <BackRow onClick={() => setView('new')} />
              <button
                className="spawn-menu-item"
                role="menuitem"
                onClick={() => { close(); props.onSpawnSession('claude-code'); }}
              >
                <span className="spawn-menu-title">Claude Code</span>
                <span className="spawn-menu-sub">
                  Spawn the `claude` CLI in the project root.
                </span>
              </button>
              <button
                className="spawn-menu-item"
                role="menuitem"
                onClick={() => { close(); props.onSpawnSession('codex'); }}
              >
                <span className="spawn-menu-title">Codex</span>
                <span className="spawn-menu-sub">
                  Spawn the OpenAI `codex` CLI in the project root.
                </span>
              </button>
            </>
          )}
          {view === 'worktree' && (
            <>
              <BackRow onClick={() => setView('new')} />
              <button
                className="spawn-menu-item"
                role="menuitem"
                onClick={() => { close(); props.onSpawnNewWorktree('claude-code'); }}
              >
                <span className="spawn-menu-title">Claude Code</span>
                <span className="spawn-menu-sub">
                  New worktree + Claude session.
                </span>
              </button>
              <button
                className="spawn-menu-item"
                role="menuitem"
                onClick={() => { close(); props.onSpawnNewWorktree('codex'); }}
              >
                <span className="spawn-menu-title">Codex</span>
                <span className="spawn-menu-sub">
                  New worktree + Codex session.
                </span>
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}

function BackRow(props: { onClick: () => void }): JSX.Element {
  return (
    <button
      className="spawn-menu-item back"
      role="menuitem"
      onClick={props.onClick}
    >
      <span className="spawn-menu-title">← Back</span>
    </button>
  );
}
