import { useCallback, useEffect, useState } from 'react';
import { useAppStore } from '../store.js';
import { FileContextMenu } from './FileContextMenu.js';
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
export const DRAG_FILE_PATH = 'application/x-code24-filepath';

export function FilesPanel({ sessionId, worktreePath, refreshKey }: Props): JSX.Element {
  const [root, setRoot] = useState<FileTreeNodeT | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [openPaths, setOpenPaths] = useState<Set<string>>(new Set(['']));
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; absPath: string; isDir: boolean } | null>(null);
  // Bumped after a file op (rename / duplicate / delete) to re-read
  // the tree without waiting for the parent's refreshKey to tick.
  const [localNonce, setLocalNonce] = useState(0);
  const openInEditor = useAppStore((s) => s.openFile);
  const onChanged = useCallback(() => setLocalNonce((n) => n + 1), []);

  function openContextMenu(e: React.MouseEvent, absPath: string, isDir: boolean): void {
    e.preventDefault();
    setCtxMenu({ x: e.clientX, y: e.clientY, absPath, isDir });
  }

  useEffect(() => {
    let cancelled = false;
    setError(null);
    window.code24
      .call('worktree.fileTree', { sessionId })
      .then((res) => { if (!cancelled) setRoot(res.root); })
      .catch((err) => { if (!cancelled) setError(String(err)); });
    return () => { cancelled = true; };
  }, [sessionId, refreshKey, localNonce]);

  function toggle(p: string): void {
    setOpenPaths((prev) => {
      const next = new Set(prev);
      if (next.has(p)) next.delete(p); else next.add(p);
      return next;
    });
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
          })}
          onClose={() => setCtxMenu(null)}
        />
      ) : null}
    </div>
  );
}

interface NodeProps {
  node: FileTreeNodeT;
  depth: number;
  openPaths: Set<string>;
  onToggle: (path: string) => void;
  onPreview: (path: string) => void;
  onPin: (path: string) => void;
  onContextMenu: (e: React.MouseEvent, absPath: string, isDir: boolean) => void;
  worktreePath: string;
}

function TreeNode({ node, depth, openPaths, onToggle, onPreview, onPin, onContextMenu, worktreePath }: NodeProps): JSX.Element {
  const isOpen = openPaths.has(node.path);
  const indent = depth * 12;
  if (node.type === 'dir') {
    const children = node.children ?? [];
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
          onClick={() => onToggle(node.path)}
          onContextMenu={isRoot ? undefined : (e) => onContextMenu(e, absDir, true)}
        >
          <span className="tree-caret">{isOpen ? '▾' : '▸'}</span>
          <span className="tree-icon">📁</span>
          <span className="tree-name">{node.name || '/'}</span>
          {node.truncated ? <span className="tree-trunc">…</span> : null}
        </button>
        {isOpen ? (
          <div>
            {children.map((c) => (
              <TreeNode
                key={c.path}
                node={c}
                depth={depth + 1}
                openPaths={openPaths}
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
