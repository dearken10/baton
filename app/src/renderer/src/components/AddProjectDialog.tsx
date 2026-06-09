import { useEffect, useMemo, useRef, useState } from 'react';
import type { ConnectionProfile, Project } from '@shared/ipc.js';
import { useAppStore } from '../store.js';
import { NewConnectionDialog } from './NewConnectionDialog.js';
import { RemoteFolderPicker } from './RemoteFolderPicker.js';

const DEFAULT_PARENT = '~/baton';

function basename(p: string): string {
  const trimmed = p.replace(/\/+$/, '');
  const i = trimmed.lastIndexOf('/');
  return i < 0 ? trimmed : trimmed.slice(i + 1);
}

/** POSIX-style parent: drops the trailing path segment. Returns '' for
 *  inputs that don't contain a separator, so the caller can fall back
 *  to a default starting path. */
function parentOf(p: string): string {
  const trimmed = p.replace(/\/+$/, '');
  const i = trimmed.lastIndexOf('/');
  if (i < 0) return '';
  return trimmed.slice(0, i) || '/';
}

type Mode = 'existing' | 'create';
type ConnKind = 'local' | 'ssh';

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
 *  can change it later via the project's Rename… menu.
 *
 *  Stage 1 — adds a "Run on" connection picker at the top. If the user
 *  picks Remote SSH, the local OS picker isn't shown. Picker right-side
 *  is hidden when Local is selected (per the design pass: the toggle is
 *  enough). Stage 2 — Remote/Add-existing uses the RemoteFolderPicker
 *  modal instead of an inline Validate button. */
export function AddProjectDialog({ onCancel, onAdded, busy }: Props): JSX.Element {
  const connectionsRecord = useAppStore((s) => s.connections);
  const sshProfiles = useMemo(
    () => Object.values(connectionsRecord)
      .filter((c) => c.kind !== 'local')
      .sort((a, b) => a.createdAt - b.createdAt),
    [connectionsRecord]
  );

  // Connection picker state. The dropdown only renders when kind="ssh".
  const [kind, setKind] = useState<ConnKind>('local');
  const [profileId, setProfileId] = useState<string>('');
  const [showProfilePop, setShowProfilePop] = useState(false);
  const [showNewConn, setShowNewConn] = useState(false);
  const profilePopRef = useRef<HTMLDivElement | null>(null);

  // When the SSH profile list changes (e.g. a new one was just
  // created), default-select the most-recent profile.
  useEffect(() => {
    if (kind === 'ssh' && !profileId && sshProfiles.length > 0) {
      setProfileId(sshProfiles[sshProfiles.length - 1]!.id);
    }
  }, [sshProfiles, kind, profileId]);
  // Close the profile dropdown on outside click / Escape.
  useEffect(() => {
    if (!showProfilePop) return;
    const onDown = (e: MouseEvent): void => {
      if (profilePopRef.current && !profilePopRef.current.contains(e.target as Node)) {
        setShowProfilePop(false);
      }
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [showProfilePop]);

  const [mode, setMode] = useState<Mode>('existing');

  // Existing-mode state. Display name auto-fills from the folder
  // basename until the user edits it directly.
  const [existingPath, setExistingPath] = useState('');
  const [existingName, setExistingName] = useState('');
  const nameEditedRef = useRef(false);

  // Create-mode state. The path always = `<parentPath>/<folderName>`
  // unless the user has typed directly into the path field (which sets
  // pathEditedRef and pins createPath verbatim).
  //
  // Separating parentPath from folderName means clicking "Select
  // parent…" before typing a name still respects the name when the
  // user types it afterwards — both are live inputs into effectivePath.
  const [folderName, setFolderName] = useState('');
  const [parentPath, setParentPath] = useState(DEFAULT_PARENT);
  const [createPath, setCreatePath] = useState('');
  const pathEditedRef = useRef(false);
  const [initGit, setInitGit] = useState(true);
  const effectivePath = pathEditedRef.current
    ? createPath
    : `${parentPath}/${folderName.trim() || ''}`;

  // Reset parentPath when the user toggles between Local and Remote
  // SSH. The local default (`~/baton`) typically doesn't exist on a
  // fresh remote; the remote default (`~`) is sometimes too broad for
  // local. Reset clears stale path edits too — switching connection
  // kind invalidates the previous target anyway. Uses `kind` directly
  // because the `isRemote` derived const is declared further down.
  useEffect(() => {
    setParentPath(kind === 'ssh' ? '~' : DEFAULT_PARENT);
    setCreatePath('');
    pathEditedRef.current = false;
  }, [kind]);

  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // RemoteFolderPicker open state. The picker is used for two purposes:
  //   - 'existing' (Add existing tab): pick the project folder itself
  //   - 'parent'   (Create new   tab): pick the parent dir, then we
  //                                    append the project name
  const [folderPicker, setFolderPicker] = useState<null | 'existing' | 'parent'>(null);

  const effectiveConnectionId = kind === 'local' ? 'local' : profileId;
  const isRemote = kind === 'ssh';

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
    if (isRemote && !effectiveConnectionId) {
      setError('Pick a connection profile, or create a new one.');
      return;
    }
    setSubmitting(true);
    try {
      let project: Project;
      if (mode === 'existing') {
        if (!existingPath.trim()) throw new Error('Pick a folder.');
        const req: { path: string; name?: string; connectionId?: string } = {
          path: existingPath.trim(),
        };
        const name = existingName.trim();
        if (name) req.name = name;
        if (isRemote) req.connectionId = effectiveConnectionId;
        const res = await window.baton.call('project.add', req);
        project = res.project;
      } else {
        const targetPath = effectivePath.trim();
        if (!targetPath || targetPath === DEFAULT_PARENT + '/') {
          throw new Error('Project name is required.');
        }
        const req: { path: string; initGit?: boolean; connectionId?: string } = {
          path: targetPath,
          initGit,
        };
        if (isRemote) req.connectionId = effectiveConnectionId;
        const res = await window.baton.call('project.create', req);
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
  const selectedProfile: ConnectionProfile | undefined = isRemote
    ? connectionsRecord[profileId]
    : undefined;

  // Submit gating:
  //   Local: behave as before — folder picked / name typed.
  //   Remote: must have a profile selected. For Add-existing, we
  //     don't require a successful Validate — main re-checks paths on
  //     the spawn side anyway, and forcing Validate breaks the flow
  //     for users who know their layout.
  const canSubmitExisting = !!existingPath.trim();
  const canSubmitCreate = effectivePath.trim() !== '' && effectivePath.trim() !== `${DEFAULT_PARENT}/`;
  const canSubmitConn = !isRemote || !!profileId;
  const canSubmit = canSubmitConn && (mode === 'existing' ? canSubmitExisting : canSubmitCreate);

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
          <p className="dim">
            {isRemote
              ? 'Point baton at a folder on the remote, or create a fresh one there.'
              : 'Point baton at an existing folder, or create a fresh one.'}
          </p>
        </div>

        <div className="dialog-body">

          {/* Connection picker — toggle on the left; profile dropdown
              only shown when Remote SSH is selected. */}
          <div className="conn-row">
            <span className="conn-row-label">Run on</span>
            <div className="conn-toggle" role="radiogroup" aria-label="Connection target">
              <button
                type="button"
                role="radio"
                aria-checked={kind === 'local'}
                className={`conn-toggle-btn ${kind === 'local' ? 'active' : ''}`}
                onClick={() => { setKind('local'); setError(null); }}
                disabled={disabled}
              >
                <span className="conn-toggle-ic" aria-hidden>💻</span>
                Local Mac
              </button>
              <button
                type="button"
                role="radio"
                aria-checked={kind === 'ssh'}
                className={`conn-toggle-btn ${kind === 'ssh' ? 'active' : ''}`}
                onClick={() => { setKind('ssh'); setError(null); }}
                disabled={disabled}
              >
                <span className="conn-toggle-ic" aria-hidden>🛰</span>
                Remote SSH
              </button>
            </div>

            {isRemote ? (
              <div className="conn-picker" ref={profilePopRef}>
                {sshProfiles.length === 0 ? (
                  <button
                    type="button"
                    className="btn btn-small"
                    onClick={() => setShowNewConn(true)}
                    disabled={disabled}
                  >
                    + New connection…
                  </button>
                ) : (
                  <>
                    <button
                      type="button"
                      className="conn-profile-select"
                      onClick={() => setShowProfilePop((v) => !v)}
                      disabled={disabled}
                      aria-haspopup="listbox"
                      aria-expanded={showProfilePop}
                    >
                      {selectedProfile ? (
                        <span className="conn-profile-text">
                          <span className="conn-profile-name">{selectedProfile.name}</span>
                          <span className="conn-profile-host">
                            {selectedProfile.user}@{selectedProfile.host}
                            {selectedProfile.port && selectedProfile.port !== 22
                              ? `:${selectedProfile.port}` : ''}
                          </span>
                        </span>
                      ) : (
                        <span className="conn-profile-text">
                          <span className="conn-profile-placeholder">Select a connection…</span>
                        </span>
                      )}
                      <span className="conn-profile-chev" aria-hidden>▾</span>
                    </button>
                    {showProfilePop ? (
                      <div className="conn-profile-pop" role="listbox">
                        {sshProfiles.map((p) => (
                          <button
                            key={p.id}
                            type="button"
                            role="option"
                            aria-selected={p.id === profileId}
                            className={`conn-profile-item ${p.id === profileId ? 'selected' : ''}`}
                            onClick={() => { setProfileId(p.id); setShowProfilePop(false); }}
                          >
                            <span className="conn-profile-text">
                              <span className="conn-profile-name">{p.name}</span>
                              <span className="conn-profile-host">
                                {p.user}@{p.host}{p.port && p.port !== 22 ? `:${p.port}` : ''}
                              </span>
                            </span>
                            {p.lastStatus ? (
                              <span className={`conn-profile-badge badge-${p.lastStatus}`}>
                                {p.lastStatus === 'success' ? 'ok'
                                  : p.lastStatus === 'auth_failed' ? 'auth'
                                  : p.lastStatus === 'unreachable' ? 'unreachable'
                                  : p.lastStatus === 'timeout' ? 'timeout'
                                  : p.lastStatus}
                              </span>
                            ) : null}
                          </button>
                        ))}
                        <button
                          type="button"
                          className="conn-profile-item conn-profile-new"
                          onClick={() => { setShowProfilePop(false); setShowNewConn(true); }}
                        >
                          + New connection…
                        </button>
                      </div>
                    ) : null}
                  </>
                )}
              </div>
            ) : null}
          </div>

          {/* Add-existing / Create-new tabs — unchanged structure */}
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

          {mode === 'existing' ? (
            <>
              <label className="dialog-field">
                <span>{isRemote ? 'Folder on remote' : 'Folder'}</span>
                <div className="row-with-button">
                  <input
                    type="text"
                    value={existingPath}
                    onChange={(e) => {
                      setExistingPath(e.target.value);
                      if (!nameEditedRef.current) setExistingName(basename(e.target.value));
                    }}
                    placeholder={isRemote ? '~/work/my-repo' : '/Users/you/code/my-project'}
                    spellCheck={false}
                    autoComplete="off"
                  />
                  {isRemote ? (
                    <button
                      type="button"
                      className="btn"
                      onClick={() => setFolderPicker('existing')}
                      disabled={disabled || !profileId}
                      title="Browse the remote filesystem"
                    >
                      Select…
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="btn"
                      onClick={() => void chooseExistingPath()}
                      disabled={disabled}
                    >
                      Choose…
                    </button>
                  )}
                </div>
                {isRemote ? (
                  <span className="dialog-hint">
                    Path is evaluated on the remote. <code>~</code> expands to the
                    remote home.
                  </span>
                ) : null}
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
                <span>{isRemote ? 'Folder path on remote' : 'Folder path'}</span>
                {isRemote ? (
                  <div className="row-with-button">
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
                    <button
                      type="button"
                      className="btn"
                      onClick={() => setFolderPicker('parent')}
                      disabled={disabled || !profileId}
                      title="Pick a parent folder on the remote"
                    >
                      Select parent…
                    </button>
                  </div>
                ) : (
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
                )}
              </label>
              <p className="dialog-hint">
                {isRemote ? (
                  <>
                    Defaults to <code>~/baton/&lt;name&gt;</code> on the remote.
                    The folder is created lazily on first use.
                  </>
                ) : (
                  <>
                    Defaults to {DEFAULT_PARENT}/&lt;name&gt;. Edit to put the
                    project somewhere else — <code>~</code> expands to your
                    home folder.
                  </>
                )}
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

      {showNewConn ? (
        <NewConnectionDialog
          busy={busy}
          onCancel={() => setShowNewConn(false)}
          onCreated={(p) => {
            setShowNewConn(false);
            setProfileId(p.id);
          }}
        />
      ) : null}

      {folderPicker && profileId ? (
        folderPicker === 'existing' ? (
          <RemoteFolderPicker
            connectionId={profileId}
            initialPath={existingPath.trim() || '~'}
            onCancel={() => setFolderPicker(null)}
            onSelect={(absPath) => {
              setFolderPicker(null);
              setExistingPath(absPath);
              if (!nameEditedRef.current) setExistingName(basename(absPath));
            }}
          />
        ) : (
          <RemoteFolderPicker
            connectionId={profileId}
            // For "parent" picker, start in the current parent so the
            // user lands somewhere familiar. parentPath is the source
            // of truth when pathEditedRef is false; if they've edited
            // the path field, fall back to that path's parent.
            initialPath={
              pathEditedRef.current
                ? (parentOf(createPath) || '~')
                : (parentPath || '~')
            }
            onCancel={() => setFolderPicker(null)}
            onSelect={(absPath) => {
              setFolderPicker(null);
              // Only update the parent — folderName stays where it is,
              // so the path field continues to auto-track both as the
              // user types. Clears the manual-edit flag so editing the
              // name afterwards still updates the displayed path.
              setParentPath(absPath.replace(/\/+$/, ''));
              pathEditedRef.current = false;
            }}
          />
        )
      ) : null}
    </div>
  );
}
