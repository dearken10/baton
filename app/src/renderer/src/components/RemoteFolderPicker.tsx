import { useEffect, useMemo, useRef, useState } from 'react';

interface Entry {
  name: string;
  kind: 'file' | 'dir' | 'symlink' | 'other';
}

interface Props {
  connectionId: string;
  /** Initial path. Defaults to `~`. */
  initialPath?: string;
  onCancel: () => void;
  /** Called with the absolute remote path the user picked. */
  onSelect: (absPath: string) => void;
}

/** Modal folder picker for a remote connection. Stages on top of
 *  AddProjectDialog and lists one level at a time via the
 *  `connection.listDir` IPC. The user can navigate into subfolders,
 *  go up the chain via the breadcrumb, or pick the current folder. */
export function RemoteFolderPicker({ connectionId, initialPath, onCancel, onSelect }: Props): JSX.Element {
  const [pathInput, setPathInput] = useState(initialPath ?? '~');
  const [currentPath, setCurrentPath] = useState<string>('');
  const [entries, setEntries] = useState<Entry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [showHidden, setShowHidden] = useState(false);
  const reqIdRef = useRef(0);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') onCancel(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onCancel]);

  // Load one level whenever the input path changes (after the user
  // hits enter or clicks a breadcrumb segment).
  //
  // Soft fall-back: if the requested path doesn't exist (typical for
  // first-open of the parent picker when the default `~/baton` hasn't
  // been created on the remote yet), retry at `~` so the user lands
  // somewhere usable instead of staring at a "can't cd to …" error.
  // We surface the original failure as a hint at the top.
  async function load(path: string, _isFallback = false): Promise<void> {
    const id = ++reqIdRef.current;
    setLoading(true);
    setError(null);
    try {
      const res = await window.baton.call('connection.listDir', {
        connectionId, path,
      });
      if (id !== reqIdRef.current) return; // out of date
      if (res.error) {
        if (!_isFallback && path !== '~') {
          setLoading(false);
          await load('~', true);
          if (id === reqIdRef.current) {
            setError(`Couldn't open ${path} on the remote. Showing your home folder.`);
          }
          return;
        }
        setError(res.error);
        setEntries([]);
        setCurrentPath('');
        return;
      }
      setCurrentPath(res.resolvedPath);
      setPathInput(res.resolvedPath);
      setEntries(res.entries);
    } catch (err) {
      if (id !== reqIdRef.current) return;
      setError(String(err));
      setEntries([]);
    } finally {
      if (id === reqIdRef.current) setLoading(false);
    }
  }

  // First load.
  useEffect(() => {
    void load(initialPath ?? '~');
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function navigateTo(path: string): void {
    setPathInput(path);
    void load(path);
  }

  function goUp(): void {
    if (!currentPath || currentPath === '/') return;
    const idx = currentPath.lastIndexOf('/');
    const parent = idx <= 0 ? '/' : currentPath.slice(0, idx);
    navigateTo(parent);
  }

  function enterFolder(name: string): void {
    const next = currentPath === '/' ? `/${name}` : `${currentPath}/${name}`;
    navigateTo(next);
  }

  // Breadcrumb segments for the resolved path so the user can click
  // back to any ancestor. We always render a leading `/` segment.
  const segments = useMemo(() => {
    if (!currentPath) return [];
    if (currentPath === '/') return [{ label: '/', path: '/' }];
    const parts = currentPath.split('/').filter(Boolean);
    const out: Array<{ label: string; path: string }> = [{ label: '/', path: '/' }];
    let acc = '';
    for (const seg of parts) {
      acc = `${acc}/${seg}`;
      out.push({ label: seg, path: acc });
    }
    return out;
  }, [currentPath]);

  const visible = useMemo(
    () => entries.filter((e) => showHidden || !e.name.startsWith('.')),
    [entries, showHidden]
  );
  const dirs = visible.filter((e) => e.kind === 'dir' || e.kind === 'symlink');
  const files = visible.filter((e) => e.kind !== 'dir' && e.kind !== 'symlink');

  return (
    <div className="dialog-overlay dialog-overlay-stacked" onMouseDown={onCancel}>
      <div
        className="dialog dialog-wide"
        role="dialog"
        aria-modal="true"
        aria-label="Select remote folder"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="dialog-head">
          <h3>Select a folder on the remote</h3>
          <p className="dim">Navigate into a subfolder, then click <strong>Select</strong>.</p>
        </div>
        <div className="dialog-body">
          <label className="dialog-field">
            <span>Path</span>
            <form
              onSubmit={(e) => { e.preventDefault(); void load(pathInput); }}
              className="row-with-button"
            >
              <input
                type="text"
                value={pathInput}
                onChange={(e) => setPathInput(e.target.value)}
                spellCheck={false}
                autoComplete="off"
                placeholder="~/work"
              />
              <button type="submit" className="btn">Go</button>
            </form>
          </label>

          {currentPath ? (
            <div className="folder-picker-crumbs" aria-label="Path breadcrumb">
              {segments.map((s, i) => (
                <span key={s.path}>
                  {i > 0 ? <span className="dim"> / </span> : null}
                  <button
                    type="button"
                    className="folder-picker-crumb"
                    onClick={() => navigateTo(s.path)}
                  >
                    {s.label}
                  </button>
                </span>
              ))}
            </div>
          ) : null}

          <div className="folder-picker-list">
            {loading ? (
              <div className="empty"><p className="dim">Reading…</p></div>
            ) : error ? (
              <div className="dialog-error">{error}</div>
            ) : (
              <>
                {currentPath && currentPath !== '/' ? (
                  <button
                    type="button"
                    className="folder-picker-row up"
                    onClick={() => goUp()}
                  >
                    <span className="folder-picker-ic" aria-hidden>↑</span>
                    <span>..</span>
                    <span className="dim" style={{ marginLeft: 'auto' }}>
                      parent folder
                    </span>
                  </button>
                ) : null}
                {dirs.map((e) => (
                  <button
                    key={e.name}
                    type="button"
                    className={`folder-picker-row dir ${e.name.startsWith('.') ? 'hidden' : ''}`}
                    onDoubleClick={() => enterFolder(e.name)}
                    onClick={() => enterFolder(e.name)}
                    title="Click to enter"
                  >
                    <span className="folder-picker-ic" aria-hidden>📁</span>
                    <span>{e.name}</span>
                    {e.kind === 'symlink'
                      ? <span className="dim" style={{ marginLeft: 'auto' }}>symlink</span>
                      : null}
                  </button>
                ))}
                {files.length > 0 ? (
                  <div className="folder-picker-files-head">
                    Files in this folder ({files.length})
                  </div>
                ) : null}
                {files.slice(0, 30).map((e) => (
                  <div
                    key={`f-${e.name}`}
                    className={`folder-picker-row file ${e.name.startsWith('.') ? 'hidden' : ''}`}
                  >
                    <span className="folder-picker-ic" aria-hidden>📄</span>
                    <span>{e.name}</span>
                  </div>
                ))}
                {files.length > 30 ? (
                  <div className="folder-picker-files-head dim">
                    + {files.length - 30} more files
                  </div>
                ) : null}
                {visible.length === 0 ? (
                  <div className="empty">
                    <p className="dim">Empty folder.</p>
                  </div>
                ) : null}
              </>
            )}
          </div>

          <label className="dialog-checkbox" style={{ marginTop: 4 }}>
            <input
              type="checkbox"
              checked={showHidden}
              onChange={(e) => setShowHidden(e.target.checked)}
            />
            <span>Show hidden entries</span>
          </label>
        </div>
        <div className="dialog-actions">
          <button type="button" className="btn" onClick={onCancel}>
            Cancel
          </button>
          <div style={{ flex: 1 }} />
          <button
            type="button"
            className="btn primary"
            onClick={() => {
              if (!currentPath) return;
              onSelect(currentPath);
            }}
            disabled={!currentPath || !!error}
            title={currentPath ? `Select ${currentPath}` : ''}
          >
            Select this folder
          </button>
        </div>
      </div>
    </div>
  );
}
