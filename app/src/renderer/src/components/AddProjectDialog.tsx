import { useEffect, useRef, useState } from 'react';
import type { Project } from '@shared/ipc.js';

const DEFAULT_PARENT = '~/baton';

function basename(p: string): string {
  const trimmed = p.replace(/\/+$/, '');
  const i = trimmed.lastIndexOf('/');
  return i < 0 ? trimmed : trimmed.slice(i + 1);
}

type Mode = 'existing' | 'create';

interface Props {
  /** Closes the dialog. */
  onCancel: () => void;
  /** Called after a project was registered. Caller decides whether to
   *  auto-spawn a session, focus it, etc. */
  onAdded: (project: Project) => void;
  busy: boolean;
}

/** Add-project dialog with two modes: "Add existing" (pick a folder
 *  that's already on disk) and "Create new" (mkdir + git init + add).
 *  Display name in both modes defaults to the folder basename — users
 *  can change it later via the project's Rename… menu. */
export function AddProjectDialog({ onCancel, onAdded, busy }: Props): JSX.Element {
  const [mode, setMode] = useState<Mode>('existing');

  // Existing-mode state. Display name auto-fills from the folder
  // basename until the user edits it directly.
  const [existingPath, setExistingPath] = useState('');
  const [existingName, setExistingName] = useState('');
  const nameEditedRef = useRef(false);

  // Create-mode state. The path auto-fills as `~/baton/<folderName>` while
  // the user types the name; once they edit the path field directly,
  // the auto-fill stops (so further name edits don't clobber their
  // chosen location).
  const [folderName, setFolderName] = useState('');
  const [createPath, setCreatePath] = useState('');
  const pathEditedRef = useRef(false);
  const [initGit, setInitGit] = useState(true);
  const effectivePath = pathEditedRef.current
    ? createPath
    : `${DEFAULT_PARENT}/${folderName.trim() || ''}`;

  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // Esc to cancel.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') onCancel(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onCancel]);

  async function chooseExistingPath(): Promise<void> {
    try {
      const { path } = await window.baton.call('project.pickFolder', {});
      if (!path) return;
      setExistingPath(path);
      if (!nameEditedRef.current) setExistingName(basename(path));
    } catch (err) {
      setError(String(err));
    }
  }

  async function submit(): Promise<void> {
    setError(null);
    setSubmitting(true);
    try {
      let project: Project;
      if (mode === 'existing') {
        if (!existingPath.trim()) throw new Error('Pick a folder.');
        const req: { path: string; name?: string } = { path: existingPath.trim() };
        const name = existingName.trim();
        if (name) req.name = name;
        const res = await window.baton.call('project.add', req);
        project = res.project;
      } else {
        const targetPath = effectivePath.trim();
        if (!targetPath || targetPath === DEFAULT_PARENT + '/') {
          throw new Error('Project name is required.');
        }
        // Main expands `~` and mkdirs the parent on demand.
        const res = await window.baton.call('project.create', {
          path: targetPath,
          initGit,
        });
        project = res.project;
      }
      onAdded(project);
    } catch (err) {
      setError(String(err));
    } finally {
      setSubmitting(false);
    }
  }

  const disabled = busy || submitting;
  const canSubmitExisting = !!existingPath.trim();
  const canSubmitCreate = effectivePath.trim() !== '' && effectivePath.trim() !== `${DEFAULT_PARENT}/`;
  const canSubmit = mode === 'existing' ? canSubmitExisting : canSubmitCreate;

  return (
    <div className="dialog-overlay" onMouseDown={onCancel}>
      <div
        className="dialog"
        role="dialog"
        aria-modal="true"
        aria-label="Add project"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="dialog-head">
          <h3>Add project</h3>
          <p className="dim">Point baton at an existing folder, or create a fresh one.</p>
        </div>

        <div className="add-project-tabs">
          <button
            type="button"
            className={`add-project-tab ${mode === 'existing' ? 'active' : ''}`}
            onClick={() => { setMode('existing'); setError(null); }}
            disabled={disabled}
          >
            Add existing
          </button>
          <button
            type="button"
            className={`add-project-tab ${mode === 'create' ? 'active' : ''}`}
            onClick={() => { setMode('create'); setError(null); }}
            disabled={disabled}
          >
            Create new
          </button>
        </div>

        <div className="dialog-body">
          {mode === 'existing' ? (
            <>
              <label className="dialog-field">
                <span>Folder</span>
                <div className="row-with-button">
                  <input
                    type="text"
                    value={existingPath}
                    onChange={(e) => {
                      setExistingPath(e.target.value);
                      if (!nameEditedRef.current) setExistingName(basename(e.target.value));
                    }}
                    placeholder="/Users/you/code/my-project"
                    spellCheck={false}
                    autoComplete="off"
                  />
                  <button
                    type="button"
                    className="btn"
                    onClick={() => void chooseExistingPath()}
                    disabled={disabled}
                  >
                    Choose…
                  </button>
                </div>
              </label>
              <label className="dialog-field">
                <span>Project name</span>
                <input
                  type="text"
                  value={existingName}
                  onChange={(e) => {
                    nameEditedRef.current = true;
                    setExistingName(e.target.value);
                  }}
                  placeholder="Defaults to folder name"
                  spellCheck={false}
                  autoComplete="off"
                />
              </label>
            </>
          ) : (
            <>
              <label className="dialog-field">
                <span>Project name</span>
                <input
                  type="text"
                  value={folderName}
                  onChange={(e) => setFolderName(e.target.value)}
                  placeholder="my-project"
                  spellCheck={false}
                  autoComplete="off"
                  autoFocus
                />
              </label>
              <label className="dialog-field">
                <span>Folder path</span>
                <input
                  type="text"
                  value={effectivePath}
                  onChange={(e) => {
                    pathEditedRef.current = true;
                    setCreatePath(e.target.value);
                  }}
                  placeholder={`${DEFAULT_PARENT}/my-project`}
                  spellCheck={false}
                  autoComplete="off"
                />
              </label>
              <p className="dialog-hint">
                Defaults to {DEFAULT_PARENT}/&lt;name&gt;. Edit to put the
                project somewhere else — <code>~</code> expands to your
                home folder.
              </p>
              <label className="dialog-checkbox">
                <input
                  type="checkbox"
                  checked={initGit}
                  onChange={(e) => setInitGit(e.target.checked)}
                />
                <span>Initialize as git repo (recommended)</span>
              </label>
            </>
          )}
          {error ? <div className="dialog-error">{error}</div> : null}
        </div>

        <div className="dialog-actions">
          <button type="button" className="btn" onClick={onCancel} disabled={disabled}>
            Cancel
          </button>
          <button
            type="button"
            className="btn primary"
            onClick={() => void submit()}
            disabled={disabled || !canSubmit}
          >
            {mode === 'existing' ? 'Add project' : 'Create project'}
          </button>
        </div>
      </div>
    </div>
  );
}
