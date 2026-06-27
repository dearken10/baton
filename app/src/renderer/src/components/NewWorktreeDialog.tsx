import { useEffect, useRef, useState } from 'react';

interface Props {
  /** Open when non-null; the project name shows in the header. */
  project: { id: string; name: string } | null;
  /** Suggested branch name; pre-fills the input. */
  defaultBranch: string;
  onCancel: () => void;
  onCreate: (branch: string) => void;
  busy: boolean;
  /** Optional copy overrides so the same dialog can front other
   *  worktree-creating flows (e.g. "Clone to worktree"). */
  title?: string;
  subtitle?: string;
  /** Action label; defaults to "Create worktree" / "Creating…". */
  submitLabel?: string;
  busyLabel?: string;
}

/**
 * Modal dialog for creating a new worktree. Replaces the rough
 * `window.prompt` so we can show a real branch input, a path preview,
 * and a primary action that's enabled only when the input is non-empty.
 */
export function NewWorktreeDialog({
  project,
  defaultBranch,
  onCancel,
  onCreate,
  busy,
  title,
  subtitle,
  submitLabel,
  busyLabel,
}: Props): JSX.Element | null {
  const [branch, setBranch] = useState(defaultBranch);
  const inputRef = useRef<HTMLInputElement | null>(null);

  // Reset the input whenever the dialog opens for a different
  // project (or with a different default).
  useEffect(() => {
    if (project) setBranch(defaultBranch);
  }, [project, defaultBranch]);

  // Focus the input when the dialog opens. Doing this in an effect
  // (rather than autoFocus) lets us also select the text so the user
  // can overwrite by typing.
  useEffect(() => {
    if (project && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [project]);

  // Close on Escape.
  useEffect(() => {
    if (!project) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onCancel();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [project, onCancel]);

  if (!project) return null;

  const trimmed = branch.trim();
  const canCreate = trimmed.length > 0 && !busy;

  // Same slug rule the main process uses for the worktree dir name.
  const slug = trimmed
    .toLowerCase()
    .replace(/[^a-z0-9-_]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);

  return (
    <div
      className="dialog-overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onCancel();
      }}
      role="presentation"
    >
      <form
        className="dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="nwd-title"
        onSubmit={(e) => {
          e.preventDefault();
          if (canCreate) onCreate(trimmed);
        }}
      >
        <div className="dialog-head">
          <h3 id="nwd-title">{title ?? `New worktree in ${project.name}`}</h3>
          <p className="dim">
            {subtitle ??
              'Creates an isolated git worktree on a new branch and spawns a Claude Code session inside it.'}
          </p>
        </div>

        <div className="dialog-body">
          <label className="dialog-field">
            <span>Branch name</span>
            <input
              ref={inputRef}
              type="text"
              value={branch}
              onChange={(e) => setBranch(e.target.value)}
              placeholder="tts/fix-retries"
              spellCheck={false}
              autoCapitalize="off"
              autoCorrect="off"
            />
            <span className="dialog-hint">
              The git branch name. Used in commits and PR titles.
            </span>
          </label>

          <div className="dialog-preview">
            <span className="dialog-preview-label">worktree at</span>
            <code className="mono">
              {`<project>/.baton/worktrees/`}{slug || '<branch-name>'}/
            </code>
          </div>
        </div>

        <div className="dialog-actions">
          <button type="button" className="btn ghost" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          <button type="submit" className="btn primary" disabled={!canCreate}>
            {busy
              ? (busyLabel ?? 'Creating…')
              : (submitLabel ?? 'Create worktree')}
          </button>
        </div>
      </form>
    </div>
  );
}
