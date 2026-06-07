import { useEffect, useState } from 'react';
import { useAppStore } from '../store.js';
import type { FileTreeNodeT } from '@shared/ipc.js';

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
export function FilesPanel({ sessionId, worktreePath, refreshKey }: Props): JSX.Element {
  const [root, setRoot] = useState<FileTreeNodeT | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [openPaths, setOpenPaths] = useState<Set<string>>(new Set(['']));
  const openInEditor = useAppStore((s) => s.openFile);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    window.code24
      .call('worktree.fileTree', { sessionId })
      .then((res) => { if (!cancelled) setRoot(res.root); })
      .catch((err) => { if (!cancelled) setError(String(err)); });
    return () => { cancelled = true; };
  }, [sessionId, refreshKey]);

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
      />
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
}

function TreeNode({ node, depth, openPaths, onToggle, onPreview, onPin }: NodeProps): JSX.Element {
  const isOpen = openPaths.has(node.path);
  const indent = depth * 12;
  if (node.type === 'dir') {
    const children = node.children ?? [];
    return (
      <div>
        <button
          type="button"
          className="tree-row"
          style={{ paddingLeft: 8 + indent }}
          onClick={() => onToggle(node.path)}
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
              />
            ))}
          </div>
        ) : null}
      </div>
    );
  }
  return (
    <button
      type="button"
      className="tree-row tree-file"
      style={{ paddingLeft: 8 + indent }}
      onClick={() => onPreview(node.path)}
      onDoubleClick={() => onPin(node.path)}
      title={`Click to preview · double-click to pin ${node.path}`}
    >
      <span className="tree-caret" />
      <span className="tree-icon">📄</span>
      <span className="tree-name">{node.name}</span>
    </button>
  );
}
