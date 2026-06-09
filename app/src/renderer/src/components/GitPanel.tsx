import { useCallback, useEffect, useState } from 'react';
import { useAppStore } from '../store.js';
import { diffTabId } from './EditorPane.js';
import { DRAG_FILE_PATH } from './FilesPanel.js';
import { FileContextMenu } from './FileContextMenu.js';
import { PromptDialog } from './PromptDialog.js';
import { buildFileMenuItems } from './fileOps.js';
import type { ResponseOf } from '@shared/ipc.js';

interface Props {
  sessionId: string;
  worktreePath: string;
  refreshKey: number;
}

type GitStatus = ResponseOf<'worktree.gitStatus'>;
type FileState = GitStatus['files'][number]['state'];

const STATE_LABELS: Record<FileState, string> = {
  modified: 'Modified',
  staged: 'Staged',
  untracked: 'Untracked',
  deleted: 'Deleted',
  conflicted: 'Conflicted',
};

const STATE_ORDER: FileState[] = [
  'conflicted', 'staged', 'modified', 'deleted', 'untracked',
];

export function GitPanel({ sessionId, worktreePath, refreshKey }: Props): JSX.Element {
  const session = useAppStore((s) => s.sessions[sessionId]);
  const project = useAppStore((s) => session ? s.projects[session.projectId] : undefined);
  const connection = useAppStore((s) => project ? s.connections[project.connectionId] : undefined);
  const isRemote = !!connection && connection.kind !== 'local';
  const [report, setReport] = useState<GitStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  const [commitMsg, setCommitMsg] = useState('');
  const [busy, setBusy] = useState(false);
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; absPath: string } | null>(null);
  // Rename dialog target — same pattern as FilesPanel (window.prompt
  // doesn't exist in Electron renderers).
  const [renameTarget, setRenameTarget] = useState<{ absPath: string; currentName: string } | null>(null);
  const openInEditor = useAppStore((s) => s.openFile);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    window.baton
      .call('worktree.gitStatus', { sessionId })
      .then((r) => { if (!cancelled) setReport(r); })
      .catch((err) => { if (!cancelled) setError(String(err)); });
    return () => { cancelled = true; };
  }, [sessionId, refreshKey, nonce]);

  const refresh = useCallback(() => setNonce((n) => n + 1), []);

  function preview(relPath: string): void {
    openInEditor(diffTabId(`${worktreePath}/${relPath}`), 'preview');
  }
  function pin(relPath: string): void {
    openInEditor(diffTabId(`${worktreePath}/${relPath}`), 'sticky');
  }

  async function toggleStage(file: GitStatus['files'][number]): Promise<void> {
    if (busy) return;
    setBusy(true);
    try {
      if (file.state === 'staged') {
        await window.baton.call('git.unstage', { sessionId, paths: [file.path] });
      } else {
        await window.baton.call('git.stage',   { sessionId, paths: [file.path] });
      }
      refresh();
    } catch (err) {
      alert(`Git error: ${String(err)}`);
    } finally {
      setBusy(false);
    }
  }

  async function stageAll(): Promise<void> {
    if (!report || busy) return;
    const paths = report.files
      .filter((f) => f.state !== 'staged')
      .map((f) => f.path);
    if (paths.length === 0) return;
    setBusy(true);
    try {
      await window.baton.call('git.stage', { sessionId, paths });
      refresh();
    } catch (err) {
      alert(`Stage failed: ${String(err)}`);
    } finally {
      setBusy(false);
    }
  }

  async function push(): Promise<void> {
    if (busy) return;
    setBusy(true);
    try {
      const res = await window.baton.call('git.push', { sessionId });
      if (!res.ok) {
        alert(`git push failed:\n\n${res.output}`);
      }
      refresh();
    } catch (err) {
      alert(`Push failed: ${String(err)}`);
    } finally {
      setBusy(false);
    }
  }

  async function pull(): Promise<void> {
    if (busy) return;
    setBusy(true);
    try {
      const res = await window.baton.call('git.pull', { sessionId });
      if (!res.ok) {
        alert(`git pull failed:\n\n${res.output}`);
      }
      refresh();
    } catch (err) {
      alert(`Pull failed: ${String(err)}`);
    } finally {
      setBusy(false);
    }
  }

  async function commit(): Promise<void> {
    if (busy || !commitMsg.trim()) return;
    setBusy(true);
    try {
      const res = await window.baton.call('git.commit', {
        sessionId, message: commitMsg.trim(),
      });
      setCommitMsg('');
      refresh();
      // Tiny in-place confirmation. Could swap for a toast later.
      console.info(`[git] committed as ${res.oid}`);
    } catch (err) {
      alert(`Commit failed: ${String(err)}`);
    } finally {
      setBusy(false);
    }
  }

  if (error) {
    return <div className="empty"><p className="dim">{error}</p></div>;
  }
  if (!report) {
    return <div className="empty"><p className="dim">Reading git status…</p></div>;
  }

  const buckets = new Map<FileState, GitStatus['files']>();
  for (const f of report.files) {
    const arr = buckets.get(f.state) ?? [];
    arr.push(f);
    buckets.set(f.state, arr);
  }
  const stagedCount = (buckets.get('staged') ?? []).length;
  const unstagedCount = report.files.length - stagedCount;

  return (
    <div className="git-panel">
      <div className="git-head">
        <div className="git-branch">
          <span className="git-branch-icon">⎇</span>
          <span className="git-branch-name">{report.branch ?? 'no branch'}</span>
        </div>
        <div className="git-counts">
          {report.ahead > 0 ? <span className="git-pill ahead">↑ {report.ahead}</span> : null}
          {report.behind > 0 ? <span className="git-pill behind">↓ {report.behind}</span> : null}
          {!report.dirty && report.ahead === 0 && report.behind === 0
            ? <span className="git-pill clean">clean</span>
            : null}
        </div>
      </div>
      <div className="git-actions">
        <button
          type="button"
          className="btn"
          onClick={() => void pull()}
          disabled={busy}
          title="git pull --ff-only"
        >
          ↓ Pull
        </button>
        <button
          type="button"
          className="btn"
          onClick={() => void push()}
          disabled={busy || report.ahead === 0}
          title={report.ahead === 0
            ? 'Nothing to push'
            : `git push (${report.ahead} commit${report.ahead === 1 ? '' : 's'})`}
        >
          ↑ Push{report.ahead > 0 ? ` ${report.ahead}` : ''}
        </button>
        <button
          type="button"
          className="btn ghost git-refresh"
          onClick={() => refresh()}
          disabled={busy}
          title="Refresh git status"
          aria-label="Refresh"
        >
          ↻
        </button>
      </div>

      {report.files.length === 0 ? (
        <div className="empty"><p className="dim">No uncommitted changes.</p></div>
      ) : (
        <>
          {unstagedCount > 0 ? (
            <div className="git-toolbar">
              <button
                type="button"
                className="btn"
                onClick={() => void stageAll()}
                disabled={busy}
                title="Stage all changed files"
              >
                Stage all ({unstagedCount})
              </button>
            </div>
          ) : null}
          {STATE_ORDER.map((state) => {
            const files = buckets.get(state) ?? [];
            if (files.length === 0) return null;
            return (
              <div key={state} className="git-group">
                <div className={`git-group-head git-state-${state}`}>
                  {STATE_LABELS[state]} <span className="dim">({files.length})</span>
                </div>
                {files.map((f) => (
                  <div
                    key={f.path}
                    className={`git-row git-state-${state}`}
                    title={`${state === 'staged' ? 'Click ✕ to unstage' : 'Click + to stage'} · double-click filename to pin diff`}
                  >
                    <button
                      type="button"
                      className="git-row-stage"
                      onClick={() => void toggleStage(f)}
                      disabled={busy}
                      title={state === 'staged' ? 'Unstage' : 'Stage'}
                    >
                      {state === 'staged' ? '✕' : '+'}
                    </button>
                    <span className="git-row-mark" aria-hidden>
                      {state === 'modified' ? 'M'
                        : state === 'staged' ? 'A'
                        : state === 'deleted' ? 'D'
                        : state === 'conflicted' ? '!'
                        : '?'}
                    </span>
                    <button
                      type="button"
                      className="git-row-path-btn"
                      onClick={() => preview(f.path)}
                      onDoubleClick={() => pin(f.path)}
                      onContextMenu={(e) => {
                        e.preventDefault();
                        setCtxMenu({
                          x: e.clientX,
                          y: e.clientY,
                          absPath: `${worktreePath}/${f.path}`,
                        });
                      }}
                      draggable
                      onDragStart={(e) => {
                        const abs = `${worktreePath}/${f.path}`;
                        e.dataTransfer.setData(DRAG_FILE_PATH, abs);
                        e.dataTransfer.setData('text/plain', abs);
                        e.dataTransfer.effectAllowed = 'copy';
                      }}
                      title={`${f.path}  ·  drag into terminal to paste path`}
                    >
                      {f.path}
                    </button>
                  </div>
                ))}
              </div>
            );
          })}
        </>
      )}

      {stagedCount > 0 ? (
        <div className="git-commit-box">
          <textarea
            className="git-commit-msg"
            placeholder="Commit message…"
            value={commitMsg}
            onChange={(e) => setCommitMsg(e.target.value)}
            rows={3}
            disabled={busy}
          />
          <div className="git-commit-actions">
            <span className="dim">{stagedCount} file{stagedCount === 1 ? '' : 's'} staged</span>
            <button
              type="button"
              className="btn primary"
              onClick={() => void commit()}
              disabled={busy || !commitMsg.trim()}
            >
              {busy ? 'Committing…' : 'Commit'}
            </button>
          </div>
        </div>
      ) : null}
      {ctxMenu ? (
        <FileContextMenu
          x={ctxMenu.x}
          y={ctxMenu.y}
          items={buildFileMenuItems({
            absPath: ctxMenu.absPath,
            isDir: false,
            openFile: openInEditor,
            onChanged: refresh,
            onRequestRename: (absPath, currentName) =>
              setRenameTarget({ absPath, currentName }),
            sessionId,
            isRemote,
          })}
          onClose={() => setCtxMenu(null)}
        />
      ) : null}
      {renameTarget ? (
        <PromptDialog
          title="Rename"
          label="New name"
          initialValue={renameTarget.currentName}
          confirmLabel="Rename"
          onCancel={() => setRenameTarget(null)}
          onConfirm={(v) => {
            const t = renameTarget;
            setRenameTarget(null);
            void window.baton
              .call('file.rename', { absPath: t.absPath, newName: v, sessionId })
              .then(() => refresh())
              .catch((err) => alert(`Rename failed: ${String(err)}`));
          }}
        />
      ) : null}
    </div>
  );
}
