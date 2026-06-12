import { useCallback, useEffect, useState } from 'react';
import { useAppStore } from '../store.js';
import { FileContextMenu } from './FileContextMenu.js';
import { PromptDialog } from './PromptDialog.js';
import { buildFileMenuItems } from './fileOps.js';
import type { FileTreeNodeT } from '@shared/ipc.js';

const HTML_EXTS = new Set(['html', 'htm']);
export function isHtmlPath(p: string): boolean {
  const dot = p.lastIndexOf('.');
  if (dot < 0) return false;
  return HTML_EXTS.has(p.slice(dot + 1).toLowerCase());
}

interface Props {
  sessionId: string;
  worktreePath: string;
  refreshKey: number;
}

/**
 * Collapsible file tree for the selected session's worktree. Clicking
 * a file opens it in the system default application (no Monaco yet —
 * F6 is a bigger lift).
 *
 * We open all top-level dirs by default; everything else stays
 * collapsed until the user clicks it.
 */
/** MIME used for dragging a single file path out of Files/Git into the
 *  terminal host. Value is mirrored in GitPanel and TerminalPane —
 *  keep them in sync if you rename it. */
export const DRAG_FILE_PATH = 'application/x-baton-filepath';

/** Module-level handle on the currently-dragged source path. Set in
 *  onDragStart, cleared in onDragEnd. We need it during onDragOver to
 *  decide whether the cursor should show "move allowed" — the
 *  dataTransfer payload is not readable in dragover for security
 *  reasons, so we keep our own ref. Scoped to the renderer process so
 *  it can't leak across windows. */
let currentDragSource: string | null = null;

export function FilesPanel({ sessionId, worktreePath, refreshKey }: Props): JSX.Element {
  const session = useAppStore((s) => s.sessions[sessionId]);
  const project = useAppStore((s) => session ? s.projects[session.projectId] : undefined);
  const connection = useAppStore((s) => project ? s.connections[project.connectionId] : undefined);
  const isRemote = !!connection && connection.kind !== 'local';
  const [root, setRoot] = useState<FileTreeNodeT | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [openPaths, setOpenPaths] = useState<Set<string>>(new Set(['']));
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; absPath: string; isDir: boolean; isRoot: boolean } | null>(null);
  // Bumped after a file op (rename / duplicate / delete) to re-read
  // the tree without waiting for the parent's refreshKey to tick.
  const [localNonce, setLocalNonce] = useState(0);
  // Lazy-loaded children keyed by repo-relative path. Populated when
  // the user expands a directory whose contents weren't included in the
  // initial fileTree response (i.e. anything past the depth cap, or
  // anything with `truncated` after a refresh).
  const [extraChildren, setExtraChildren] = useState<Record<string, FileTreeNodeT[]>>({});
  const [loadingPaths, setLoadingPaths] = useState<Set<string>>(new Set());
  // Rename dialog state — Electron's renderer doesn't support
  // window.prompt(), so the menu's "Rename…" routes here.
  const [renameTarget, setRenameTarget] = useState<{ absPath: string; currentName: string } | null>(null);
  // "New file" dialog target — `parentAbsPath` is the directory the
  // new file will be created inside. Defaults to the worktree root
  // when triggered from the toolbar; set to a subdir when triggered
  // from a directory's context menu.
  const [newFileParent, setNewFileParent] = useState<string | null>(null);
  // Absolute path of the directory currently being hovered with a drag,
  // or null if no drag is in progress. Drives the drop-target highlight.
  const [dragOverDir, setDragOverDir] = useState<string | null>(null);
  const openInEditor = useAppStore((s) => s.openFile);
  const onChanged = useCallback(() => setLocalNonce((n) => n + 1), []);

  const moveInto = useCallback(async (srcAbs: string, destDirAbs: string): Promise<void> => {
    // Same-parent drop is a silent no-op; the handler also returns
    // success in that case, but bailing here saves an IPC round-trip
    // and prevents a needless tree refresh flash.
    const srcParent = srcAbs.replace(/\/+[^/]+\/?$/, '') || '/';
    if (srcParent === destDirAbs) return;
    if (destDirAbs === srcAbs || destDirAbs.startsWith(srcAbs + '/')) {
      alert("Can't move a folder into itself.");
      return;
    }
    try {
      await window.baton.call('file.move', {
        absPath: srcAbs,
        destDirAbsPath: destDirAbs,
        sessionId,
      });
      onChanged();
    } catch (err) {
      alert(`Move failed: ${String(err)}`);
    }
  }, [sessionId, onChanged]);
  const onRequestRename = useCallback((absPath: string, currentName: string) => {
    setRenameTarget({ absPath, currentName });
  }, []);
  const onRequestNewFile = useCallback((parentAbsPath: string) => {
    setNewFileParent(parentAbsPath);
  }, []);

  const loadChildren = useCallback(async (relPath: string): Promise<void> => {
    setLoadingPaths((prev) => {
      if (prev.has(relPath)) return prev;
      const next = new Set(prev);
      next.add(relPath);
      return next;
    });
    try {
      const res = await window.baton.call('worktree.readDir', { sessionId, relPath });
      setExtraChildren((prev) => ({ ...prev, [relPath]: res.children }));
    } catch {
      // Best-effort. Leave extraChildren un-set so a retry click can
      // try again. If we cached an error, the tree would be stuck.
    } finally {
      setLoadingPaths((prev) => {
        const next = new Set(prev);
        next.delete(relPath);
        return next;
      });
    }
  }, [sessionId]);
  async function submitRename(newName: string): Promise<void> {
    const t = renameTarget;
    setRenameTarget(null);
    if (!t) return;
    try {
      await window.baton.call('file.rename', { absPath: t.absPath, newName, sessionId });
      onChanged();
    } catch (err) {
      alert(`Rename failed: ${String(err)}`);
    }
  }

  async function submitNewFile(name: string): Promise<void> {
    const parent = newFileParent;
    setNewFileParent(null);
    if (!parent) return;
    // Allow forward-slash segments so "src/foo.ts" creates the parent
    // dirs too — main does mkdir -p. We reject backslashes and leading
    // slashes (would escape the worktree) and reserved segments.
    const trimmed = name.trim();
    if (!trimmed || trimmed.startsWith('/') || trimmed.includes('\\') ||
        trimmed.split('/').some((s) => s === '' || s === '.' || s === '..')) {
      alert('Invalid file name.');
      return;
    }
    const absPath = `${parent}/${trimmed}`;
    try {
      await window.baton.call('file.create', { absPath });
      // Open the path that contains the new file so the user sees it.
      const dirsToOpen = trimmed.split('/').slice(0, -1);
      if (dirsToOpen.length > 0) {
        const parentRel = parent === worktreePath
          ? ''
          : parent.slice(worktreePath.length + 1);
        setOpenPaths((prev) => {
          const next = new Set(prev);
          let acc = parentRel;
          next.add(acc);
          for (const seg of dirsToOpen) {
            acc = acc ? `${acc}/${seg}` : seg;
            next.add(acc);
          }
          return next;
        });
      }
      onChanged();
      openInEditor(absPath, 'sticky');
    } catch (err) {
      alert(`Create failed: ${String(err)}`);
    }
  }

  function openContextMenu(e: React.MouseEvent, absPath: string, isDir: boolean, isRoot: boolean): void {
    e.preventDefault();
    setCtxMenu({ x: e.clientX, y: e.clientY, absPath, isDir, isRoot });
  }

  // Drop the lazy-load cache only when the worktree actually changes
  // (session switch) or after one of our own file ops (rename / move /
  // delete via localNonce). The parent's 3-second polling refresh
  // (refreshKey) used to wipe it too, which made depth-4+ expansions
  // collapse the moment the next poll fired — what looked like
  // "opens momentarily then collapses" on the second click.
  useEffect(() => {
    setExtraChildren({});
  }, [sessionId, localNonce]);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    window.baton
      .call('worktree.fileTree', { sessionId })
      .then((res) => { if (!cancelled) setRoot(res.root); })
      .catch((err) => { if (!cancelled) setError(String(err)); });
    return () => { cancelled = true; };
  }, [sessionId, refreshKey, localNonce]);

  function toggle(node: FileTreeNodeT): void {
    const p = node.path;
    setOpenPaths((prev) => {
      const next = new Set(prev);
      if (next.has(p)) next.delete(p); else next.add(p);
      return next;
    });
    // If the user is OPENING a dir whose children we don't have yet,
    // fetch them. children===undefined = depth cap stopped us; we
    // detect by checking both the eager tree and our extra cache.
    const eager = node.children;
    const cached = extraChildren[p];
    const needs = (eager === undefined || node.truncated) && cached === undefined;
    if (needs) void loadChildren(p);
  }

  function openFilePreview(relPath: string): void {
    openInEditor(`${worktreePath}/${relPath}`, 'preview');
  }
  function openFileSticky(relPath: string): void {
    openInEditor(`${worktreePath}/${relPath}`, 'sticky');
  }

  if (error) {
    return <div className="empty"><p className="dim">{error}</p></div>;
  }
  if (!root) {
    return <div className="empty"><p className="dim">Reading worktree…</p></div>;
  }

  return (
    <div className="file-tree">
      <div className="file-tree-toolbar">
        <button
          type="button"
          className="btn ghost file-tree-new"
          onClick={() => setNewFileParent(worktreePath)}
          title="Create a new file in the worktree root"
        >
          + New File
        </button>
      </div>
      <TreeNode
        node={root}
        depth={0}
        openPaths={openPaths}
        extraChildren={extraChildren}
        loadingPaths={loadingPaths}
        onToggle={toggle}
        onPreview={openFilePreview}
        onPin={openFileSticky}
        onContextMenu={openContextMenu}
        worktreePath={worktreePath}
        dragOverDir={dragOverDir}
        setDragOverDir={setDragOverDir}
        onMoveInto={(src, dest) => void moveInto(src, dest)}
      />
      {ctxMenu ? (
        <FileContextMenu
          x={ctxMenu.x}
          y={ctxMenu.y}
          items={buildFileMenuItems({
            absPath: ctxMenu.absPath,
            isDir: ctxMenu.isDir,
            isRoot: ctxMenu.isRoot,
            openFile: openInEditor,
            onChanged,
            onRequestRename,
            onRequestNewFile,
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
          onConfirm={(v) => void submitRename(v)}
        />
      ) : null}
      {newFileParent ? (
        <PromptDialog
          title="New File"
          label={newFileParent === worktreePath
            ? 'File name (relative to worktree root)'
            : `File name in ${newFileParent.split('/').pop() ?? ''}`}
          placeholder="untitled.txt"
          initialValue=""
          confirmLabel="Create"
          onCancel={() => setNewFileParent(null)}
          onConfirm={(v) => void submitNewFile(v)}
        />
      ) : null}
    </div>
  );
}

interface NodeProps {
  node: FileTreeNodeT;
  depth: number;
  openPaths: Set<string>;
  extraChildren: Record<string, FileTreeNodeT[]>;
  loadingPaths: Set<string>;
  onToggle: (node: FileTreeNodeT) => void;
  onPreview: (path: string) => void;
  onPin: (path: string) => void;
  onContextMenu: (e: React.MouseEvent, absPath: string, isDir: boolean, isRoot: boolean) => void;
  worktreePath: string;
  dragOverDir: string | null;
  setDragOverDir: (p: string | null) => void;
  onMoveInto: (srcAbs: string, destDirAbs: string) => void;
}

function TreeNode({
  node, depth, openPaths, extraChildren, loadingPaths,
  onToggle, onPreview, onPin, onContextMenu, worktreePath,
  dragOverDir, setDragOverDir, onMoveInto,
}: NodeProps): JSX.Element {
  const isOpen = openPaths.has(node.path);
  const indent = depth * 12;
  if (node.type === 'dir') {
    // Children come from either the eager fileTree fetch or the lazy
    // readDir cache. Lazy wins so a refreshed subtree replaces stale
    // eager data.
    const cached = extraChildren[node.path];
    const children: FileTreeNodeT[] | undefined = cached ?? node.children;
    const isLoading = loadingPaths.has(node.path);
    // The worktree root is `node.path === ''`. We allow the context
    // menu on it but the menu builder hides rename/delete/duplicate
    // when `isRoot`, so destructive ops on the project root stay
    // impossible from the tree.
    const isRoot = node.path === '';
    const absDir = isRoot ? worktreePath : `${worktreePath}/${node.path}`;
    // Disable the drop highlight when this dir is the source or one of
    // its ancestors of the source — the handler would reject the move
    // anyway, but the cursor should already say "not allowed".
    const dragSrc = currentDragSource;
    const isInvalidDropTarget = dragSrc != null && (
      dragSrc === absDir || absDir === dragSrc || absDir.startsWith(dragSrc + '/')
    );
    const showDropHighlight = dragOverDir === absDir && !isInvalidDropTarget;
    return (
      <div>
        <button
          type="button"
          className={`tree-row${showDropHighlight ? ' tree-row-drop' : ''}`}
          style={{ paddingLeft: 8 + indent }}
          onClick={() => onToggle(node)}
          onContextMenu={(e) => onContextMenu(e, absDir, true, isRoot)}
          // The worktree root is conceptually a folder too, but dragging
          // it would let the user try to move the entire project — make
          // it drop-only, not drag-source.
          draggable={!isRoot}
          onDragStart={isRoot ? undefined : (e) => {
            e.dataTransfer.setData(DRAG_FILE_PATH, absDir);
            e.dataTransfer.setData('text/plain', absDir);
            e.dataTransfer.effectAllowed = 'copyMove';
            currentDragSource = absDir;
          }}
          onDragEnd={() => { currentDragSource = null; }}
          onDragEnter={(e) => {
            if (!e.dataTransfer.types.includes(DRAG_FILE_PATH)) return;
            e.preventDefault();
            if (!isInvalidDropTarget) setDragOverDir(absDir);
          }}
          onDragOver={(e) => {
            if (!e.dataTransfer.types.includes(DRAG_FILE_PATH)) return;
            e.preventDefault();
            e.dataTransfer.dropEffect = isInvalidDropTarget ? 'none' : 'move';
            if (!isInvalidDropTarget && dragOverDir !== absDir) setDragOverDir(absDir);
          }}
          onDragLeave={() => {
            // Only clear if WE were the highlighted target — another
            // row's dragenter may have already moved the highlight, and
            // we'd otherwise clobber it.
            if (dragOverDir === absDir) setDragOverDir(null);
          }}
          onDrop={(e) => {
            if (!e.dataTransfer.types.includes(DRAG_FILE_PATH)) return;
            e.preventDefault();
            setDragOverDir(null);
            const src = e.dataTransfer.getData(DRAG_FILE_PATH);
            currentDragSource = null;
            if (!src || isInvalidDropTarget) return;
            onMoveInto(src, absDir);
          }}
        >
          <span className="tree-caret">{isOpen ? '▾' : '▸'}</span>
          <span className="tree-icon">📁</span>
          <span className="tree-name">{node.name || '/'}</span>
          {node.truncated && cached === undefined ? <span className="tree-trunc">…</span> : null}
        </button>
        {isOpen ? (
          <div>
            {isLoading && children === undefined ? (
              <div className="tree-row dim" style={{ paddingLeft: 8 + (depth + 1) * 12 }}>
                <span className="tree-caret" />
                <span className="tree-icon" />
                <span className="tree-name">Loading…</span>
              </div>
            ) : null}
            {(children ?? []).map((c) => (
              <TreeNode
                key={c.path}
                node={c}
                depth={depth + 1}
                openPaths={openPaths}
                extraChildren={extraChildren}
                loadingPaths={loadingPaths}
                onToggle={onToggle}
                onPreview={onPreview}
                onPin={onPin}
                onContextMenu={onContextMenu}
                worktreePath={worktreePath}
                dragOverDir={dragOverDir}
                setDragOverDir={setDragOverDir}
                onMoveInto={onMoveInto}
              />
            ))}
          </div>
        ) : null}
      </div>
    );
  }
  const abs = `${worktreePath}/${node.path}`;
  return (
    <button
      type="button"
      className="tree-row tree-file"
      style={{ paddingLeft: 8 + indent }}
      onClick={() => onPreview(node.path)}
      onDoubleClick={() => onPin(node.path)}
      onContextMenu={(e) => onContextMenu(e, abs, false, false)}
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData(DRAG_FILE_PATH, abs);
        e.dataTransfer.setData('text/plain', abs);
        // copyMove (not copy) so the same drag works for two drop kinds:
        // the terminal/editor copies the path, a folder row moves the file.
        e.dataTransfer.effectAllowed = 'copyMove';
        currentDragSource = abs;
      }}
      onDragEnd={() => { currentDragSource = null; }}
      title={`Click to preview · double-click to pin · drag onto a folder to move · drag into terminal to paste path  ·  ${node.path}`}
    >
      <span className="tree-caret" />
      <span className="tree-icon">📄</span>
      <span className="tree-name">{node.name}</span>
    </button>
  );
}
