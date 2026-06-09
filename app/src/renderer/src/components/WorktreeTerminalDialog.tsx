import { useEffect, useState } from 'react';
import type { WorktreeEntry } from '../../../shared/ipc.js';

interface Props {
  /** Open when non-null; project name shows in the header. */
  project: { id: string; name: string } | null;
  onCancel: () => void;
  onChoose: (worktreePath: string) => void;
  busy: boolean;
}

type LoadState =
  | { kind: 'loading' }
  | { kind: 'loaded'; worktrees: WorktreeEntry[] }
  | { kind: 'error'; message: string };

/**
 * Dialog for picking an existing worktree to drop a terminal into.
 * Lists worktrees from `git worktree list` (minus the main one), and
 * spawns a shell session at the selected path on click.
 */
export function WorktreeTerminalDialog({
  project,
  onCancel,
  onChoose,
  busy,
}: Props): JSX.Element | null {
  const [state, setState] = useState<LoadState>({ kind: 'loading' });

  useEffect(() => {
    if (!project) return;
    setState({ kind: 'loading' });
    let cancelled = false;
    void window.baton
      .call('worktree.list', { projectId: project.id })
      .then((res) => {
        if (cancelled) return;
        setState({ kind: 'loaded', worktrees: res.worktrees });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setState({ kind: 'error', message: String(err) });
      });
    return () => { cancelled = true; };
  }, [project]);

  useEffect(() => {
    if (!project) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onCancel();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [project, onCancel]);

  if (!project) return null;

  return (
    <div
      className="dialog-overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onCancel();
      }}
      role="presentation"
    >
      <div
        className="dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="wtd-title"
      >
        <div className="dialog-head">
          <h3 id="wtd-title">New worktree terminal in {project.name}</h3>
          <p className="dim">
            Opens a shell session in an existing worktree.
          </p>
        </div>

        <div className="dialog-body">
          {state.kind === 'loading' ? (
            <div className="dim">Loading worktrees…</div>
          ) : state.kind === 'error' ? (
            <div className="dialog-error">{state.message}</div>
          ) : state.worktrees.length === 0 ? (
            <div className="dim">
              No worktrees for this project. Create one from “New worktree”.
            </div>
          ) : (
            <ul className="worktree-list">
              {state.worktrees.map((w) => (
                <li key={w.path}>
                  <button
                    type="button"
                    className="worktree-list-item"
                    onClick={() => onChoose(w.path)}
                    disabled={busy}
                  >
                    <span className="worktree-branch">
                      {w.branch ?? '(detached)'}
                    </span>
                    <span className="worktree-path mono dim">{w.path}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="dialog-actions">
          <button type="button" className="btn ghost" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
