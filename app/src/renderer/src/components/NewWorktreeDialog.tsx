import { useEffect, useMemo, useRef, useState } from 'react';
import type { WorktreeEntry } from '@shared/ipc.js';
import { extractJiraKey } from '@shared/jira.js';

interface Props {
  /** Open when non-null; the project name shows in the header. */
  project: { id: string; name: string } | null;
  /** Suggested branch name; pre-fills the input. */
  defaultBranch: string;
  /** Existing worktrees in this project (from `worktree.list`). Used to
   *  detect when the user is typing a branch that already has a
   *  worktree — in that case we offer to open it instead of failing the
   *  `git worktree add`. Pass `null` while still loading. Omit entirely
   *  (paired with omitting `onOpenExisting`) to skip the open-existing
   *  detection — used by the "Clone to worktree" flow, where the target
   *  is always a fresh branch. */
  worktrees?: WorktreeEntry[] | null;
  onCancel: () => void;
  onCreate: (branch: string, jiraTaskId: string) => void;
  /** Called when the user accepts "open existing" — receives the
   *  absolute path of the matched worktree. The parent spawns a session
   *  at that path via `session.spawn`'s `existingWorktreePath`. Omit
   *  to disable the affordance. */
  onOpenExisting?: (path: string) => void;
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
  worktrees,
  onCancel,
  onCreate,
  onOpenExisting,
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

  // Detect an existing worktree on the same branch. Match by branch
  // name (the canonical key from `git worktree list`) — folder/slug
  // collisions without a branch match are rare and the underlying
  // `git worktree add` would surface the path conflict on its own.
  const existing = useMemo<WorktreeEntry | null>(() => {
    if (!worktrees || !onOpenExisting) return null;
    const t = branch.trim();
    if (t.length === 0) return null;
    return worktrees.find((w) => w.branch === t) ?? null;
  }, [worktrees, onOpenExisting, branch]);

  if (!project) return null;

  const trimmed = branch.trim();
  const canSubmit = trimmed.length > 0 && !busy;

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
          if (!canSubmit) return;
          if (existing && onOpenExisting) onOpenExisting(existing.path);
          else onCreate(trimmed, jira.trim());
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

          {existing ? (
            <div className="dialog-banner dialog-banner-info" role="status">
              <strong>This branch already has a worktree.</strong>
              <code className="mono">{existing.path}</code>
              <span className="dim">
                Submitting will spawn a session in the existing worktree instead
                of creating a new one.
              </span>
            </div>
          ) : (
            <div className="dialog-preview">
              <span className="dialog-preview-label">worktree at</span>
              <code className="mono">
                {`<project>/.baton/worktrees/`}{slug || '<branch-name>'}/
              </code>
            </div>
          )}

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
          <button type="submit" className="btn primary" disabled={!canSubmit}>
            {existing
              ? (busy ? 'Opening…' : 'Open existing worktree')
              : (busy ? (busyLabel ?? 'Creating…') : (submitLabel ?? 'Create worktree'))}
          </button>
        </div>
      </form>
    </div>
  );
}
