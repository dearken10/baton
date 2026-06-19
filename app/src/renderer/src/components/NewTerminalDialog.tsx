import { useEffect, useRef, useState } from 'react';
import type { WorktreeEntry } from '@shared/ipc.js';

export type NewTerminalChoice =
  | { mode: 'root' }
  | { mode: 'existing'; worktreePath: string };

interface Props {
  /** Open when non-null. Carries the project so we can list its
   *  worktrees scoped without the dialog touching the store. */
  project: { id: string; name: string; path: string } | null;
  onCancel: () => void;
  onConfirm: (choice: NewTerminalChoice) => void;
  busy: boolean;
}

const ROOT_VALUE = '__root__';

/**
 * "New terminal" picker. One dropdown:
 *   - Project root (default)
 *   - Each existing worktree of the project
 *
 * Creating a worktree on the fly stays in the dedicated worktree
 * dialog — this one only routes to places that already exist.
 */
export function NewTerminalDialog({
  project,
  onCancel,
  onConfirm,
  busy,
}: Props): JSX.Element | null {
  const [worktrees, setWorktrees] = useState<WorktreeEntry[]>([]);
  const [selected, setSelected] = useState<string>(ROOT_VALUE);
  const [loadError, setLoadError] = useState<string | null>(null);
  const selectRef = useRef<HTMLSelectElement | null>(null);

  // Reset on each open.
  useEffect(() => {
    if (!project) return;
    setWorktrees([]);
    setSelected(ROOT_VALUE);
    setLoadError(null);
  }, [project]);

  // Load worktrees in the background. Confirming "Project root" doesn't
  // need to wait for this; the user can submit immediately.
  useEffect(() => {
    if (!project) return;
    let cancelled = false;
    window.baton.call('worktree.list', { projectId: project.id })
      .then((r) => { if (!cancelled) setWorktrees(r.worktrees); })
      .catch((err) => { if (!cancelled) setLoadError(String(err)); });
    return () => { cancelled = true; };
  }, [project]);

  // Focus the dropdown when the dialog opens so Enter immediately
  // submits the default (Project root) without an extra Tab.
  useEffect(() => {
    if (project) selectRef.current?.focus();
  }, [project]);

  // Esc to close.
  useEffect(() => {
    if (!project) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onCancel();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [project, onCancel]);

  if (!project) return null;

  const canConfirm = !busy;

  function submit(e: React.FormEvent): void {
    e.preventDefault();
    if (!canConfirm) return;
    if (selected === ROOT_VALUE) onConfirm({ mode: 'root' });
    else onConfirm({ mode: 'existing', worktreePath: selected });
  }

  return (
    <div
      className="dialog-overlay"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onCancel(); }}
      role="presentation"
    >
      <form
        className="dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="ntd-title"
        onSubmit={submit}
      >
        <div className="dialog-head">
          <h3 id="ntd-title">New terminal in {project.name}</h3>
          <p className="dim">Pick where the shell should land.</p>
        </div>

        <div className="dialog-body">
          <label className="dialog-field">
            <span>Working directory</span>
            <select
              ref={selectRef}
              className="ntd-select"
              value={selected}
              onChange={(e) => setSelected(e.target.value)}
            >
              <option value={ROOT_VALUE}>
                Project root — {project.path}
              </option>
              {worktrees.map((w) => (
                <option key={w.path} value={w.path}>
                  {(w.branch ?? '(detached)')} — {w.path}
                </option>
              ))}
            </select>
            {loadError ? (
              <span className="dialog-hint" style={{ color: 'var(--errored)' }}>
                Could not list worktrees: {loadError}
              </span>
            ) : (
              <span className="dialog-hint">
                Existing worktrees of this project, plus the root itself.
              </span>
            )}
          </label>
        </div>

        <div className="dialog-actions">
          <button type="button" className="btn ghost" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          <button type="submit" className="btn primary" disabled={!canConfirm}>
            {busy ? 'Opening…' : 'Open terminal'}
          </button>
        </div>
      </form>
    </div>
  );
}
