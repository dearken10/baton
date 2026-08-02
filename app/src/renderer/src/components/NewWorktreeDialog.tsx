import { useEffect, useRef, useState } from 'react';
import { extractJiraKey } from '@shared/jira.js';

interface Props {
  /** Open when non-null; the project name shows in the header. */
  project: { id: string; name: string } | null;
  /** Suggested branch name; pre-fills the input. */
  defaultBranch: string;
  onCancel: () => void;
  onCreate: (branch: string, jiraTaskId: string) => void;
  busy: boolean;
  /** Show the optional "Jira ticket" field. Enabled by the caller when
   *  OTEL telemetry is on, so the session's effort is attributed to a
   *  ticket. The field auto-fills from the branch name (our convention
   *  encodes the key, e.g. `IMBEE-8704-…`). */
  showJira?: boolean;
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
  showJira,
}: Props): JSX.Element | null {
  const [branch, setBranch] = useState(defaultBranch);
  // The Jira key. Auto-mirrors whatever the branch encodes until the
  // user edits it by hand (tracked by jiraTouched), after which we stop
  // clobbering their choice.
  const [jira, setJira] = useState('');
  const [jiraTouched, setJiraTouched] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);

  // Reset the inputs whenever the dialog opens for a different
  // project (or with a different default).
  useEffect(() => {
    if (project) {
      setBranch(defaultBranch);
      setJira(extractJiraKey(defaultBranch) ?? '');
      setJiraTouched(false);
    }
  }, [project, defaultBranch]);

  // Keep the Jira field mirrored to the branch until the user overrides.
  useEffect(() => {
    if (!jiraTouched) setJira(extractJiraKey(branch) ?? '');
  }, [branch, jiraTouched]);

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
          if (canCreate) onCreate(trimmed, jira.trim());
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

          {showJira && (
            <label className="dialog-field">
              <span>Jira ticket (optional)</span>
              <input
                type="text"
                value={jira}
                onChange={(e) => {
                  setJiraTouched(true);
                  setJira(e.target.value);
                }}
                placeholder="IMBEE-8704"
                spellCheck={false}
                autoCapitalize="off"
                autoCorrect="off"
              />
              <span className="dialog-hint">
                Attributes this session's tokens, cost &amp; engaged time to a
                ticket. Auto-filled from the branch; blank = untagged.
              </span>
            </label>
          )}
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
