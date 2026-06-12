/**
 * Shared file-operation helpers used by FilesPanel and GitPanel
 * context menus. Each operation here calls main via IPC and surfaces
 * errors as alert() — these are deliberately blunt user prompts because
 * the operations are destructive enough to warrant a hard stop.
 *
 * The functions return `true` on success so the caller can decide
 * whether to bump its refresh nonce.
 */

import { isHtmlPath } from './FilesPanel.js';
import { browserTabId } from './tabIds.js';

type OpenFile = (idOrPath: string, kind: 'preview' | 'sticky') => void;

export interface MenuItem {
  label: string;
  onClick: () => void;
  disabled?: boolean;
}

/** Items for "any file or directory" — used in Files (tree leaves +
 *  directories) and Git (always files). `isDir` toggles the "Open in
 *  browser" item off for directories. `onChanged` is the parent's
 *  refresh hook — called whenever something on disk moved.
 *  `onRequestRename` opens the parent's rename PromptDialog (Electron
 *  renderers don't support window.prompt, so we can't do it here). */
export function buildFileMenuItems(opts: {
  absPath: string;
  isDir: boolean;
  /** True when `absPath` is the worktree root. Hides duplicate/rename/
   *  delete so users can't accidentally trash the project root from
   *  inside its own tree. New File / Copy path / Reveal still show. */
  isRoot?: boolean;
  openFile: OpenFile;
  onChanged: () => void;
  onRequestRename: (absPath: string, currentName: string) => void;
  /** Open a "new file" prompt with `parentAbsPath` preselected. Only
   *  the Files panel passes this; the Git panel leaves it undefined
   *  (and hits files, not dirs, anyway). */
  onRequestNewFile?: (parentAbsPath: string) => void;
  /** Pass the active session id so file ops on a remote project go
   *  through SSH rather than the local fs. Undefined for places where
   *  the menu has no session context (e.g. project-level actions). */
  sessionId?: string;
  /** True when the project's connection isn't local. Used to suppress
   *  "Reveal in Finder" (which can't open a remote path) and re-label
   *  "Delete (move to Trash)" since remote Linux has no trash. */
  isRemote?: boolean;
}): MenuItem[] {
  const { absPath, isDir, isRoot = false, openFile, onChanged, onRequestRename, onRequestNewFile, sessionId, isRemote } = opts;
  const items: MenuItem[] = [];
  const sidPayload = sessionId ? { sessionId } : {};

  if (isDir && onRequestNewFile) {
    items.push({
      label: 'New File…',
      onClick: () => onRequestNewFile(absPath),
    });
  }

  if (!isDir && isHtmlPath(absPath)) {
    items.push({
      label: 'Open in browser',
      onClick: () => openFile(browserTabId(absPath), 'sticky'),
    });
  }

  items.push({
    label: 'Copy path',
    onClick: () => {
      void navigator.clipboard.writeText(absPath).catch((err) => {
        alert(`Copy failed: ${String(err)}`);
      });
    },
  });

  if (!isRemote) {
    items.push({
      label: 'Reveal in Finder',
      onClick: () => {
        void window.baton.call('file.revealInFinder', { absPath, ...sidPayload }).catch((err) => {
          alert(`Reveal failed: ${String(err)}`);
        });
      },
    });
  }

  if (!isRoot) {
    items.push({
      label: 'Duplicate',
      onClick: () => {
        void (async () => {
          try {
            await window.baton.call('file.copy', { absPath, ...sidPayload });
            onChanged();
          } catch (err) {
            alert(`Duplicate failed: ${String(err)}`);
          }
        })();
      },
    });

    items.push({
      label: 'Rename…',
      onClick: () => {
        const oldName = absPath.split('/').pop() ?? '';
        onRequestRename(absPath, oldName);
      },
    });

    items.push({
      label: isRemote ? 'Delete (permanent)' : 'Delete (move to Trash)',
      onClick: () => {
        const name = absPath.split('/').pop() ?? absPath;
        const lead = isRemote
          ? `Permanently delete "${name}" on the remote?\n\n` +
            (isDir
              ? 'The folder and everything inside it will be removed (rm -rf). There is no remote trash.'
              : 'The file will be removed (rm). There is no remote trash.')
          : `Move "${name}" to the Trash?\n\n` +
            (isDir
              ? 'The folder and everything inside it will be moved to the OS Trash.'
              : 'The file will be moved to the OS Trash. You can restore it from Finder.');
        const ok = window.confirm(lead);
        if (!ok) return;
        void (async () => {
          try {
            await window.baton.call('file.delete', { absPath, ...sidPayload });
            onChanged();
          } catch (err) {
            alert(`Delete failed: ${String(err)}`);
          }
        })();
      },
    });
  }

  return items;
}
