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

export function FilesPanel({ sessionId, worktreePath, refreshKey }: Props): JSX.Element {
  const [root, setRoot] = useState<FileTreeNodeT | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [openPaths, setOpenPaths] = useState<Set<string>>(new Set(['']));
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; absPath: string; isDir: boolean } | null>(null);
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
  const openInEditor = useAppStore((s) => s.openFile);
  const onChanged = useCallback(() => setLocalNonce((n) => n + 1), []);
  const onRequestRename = useCallback((absPath: string, currentName: string) => {
    setRenameTarget({ absPath, currentName });
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
      await window.baton.call('file.rename', { absPath: t.absPath, newName });
      onChanged();
    } catch (err) {
      alert(`Rename failed: ${String(err)}`);
    }
  }

  function openContextMenu(e: React.MouseEvent, absPath: string, isDir: boolean): void {
    e.preventDefault();
    setCtxMenu({ x: e.clientX, y: e.clientY, absPath, isDir });
  }

  useEffect(() => {
    let cancelled = false;
    setError(null);
    // A fresh root invalidates any lazily-loaded subtrees — drop them.
    setExtraChildren({});
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
      />
      {ctxMenu ? (
        <FileContextMenu
          x={ctxMenu.x}
          y={ctxMenu.y}
          items={buildFileMenuItems({
            absPath: ctxMenu.absPath,
            isDir: ctxMenu.isDir,
            openFile: openInEditor,
            onChanged,
            onRequestRename,
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
  onContextMenu: (e: React.MouseEvent, absPath: string, isDir: boolean) => void;
  worktreePath: string;
}

function TreeNode({
  node, depth, openPaths, extraChildren, loadingPaths,
  onToggle, onPreview, onPin, onContextMenu, worktreePath,
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
    // The worktree root is `node.path === ''` — skip the menu there
    // so users can't rename/delete the project root from inside.
    const isRoot = node.path === '';
    const absDir = isRoot ? worktreePath : `${worktreePath}/${node.path}`;
    return (
      <div>
        <button
          type="button"
          className="tree-row"
          style={{ paddingLeft: 8 + indent }}
          onClick={() => onToggle(node)}
          onContextMenu={isRoot ? undefined : (e) => onContextMenu(e, absDir, true)}
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
      onContextMenu={(e) => onContextMenu(e, abs, false)}
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData(DRAG_FILE_PATH, abs);
        e.dataTransfer.setData('text/plain', abs);
        e.dataTransfer.effectAllowed = 'copy';
      }}
      title={`Click to preview · double-click to pin · drag into terminal to paste path  ·  ${node.path}`}
    >
      <span className="tree-caret" />
      <span className="tree-icon">📄</span>
      <span className="tree-name">{node.name}</span>
    </button>
  );
}
