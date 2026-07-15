/** Shared "resolve a file reference and open it in the editor pane"
 *  logic, used by both the Turns view (<FileRefText>) and the Live
 *  terminal's link provider so the two behave identically. Kept out of
 *  FileRefText.tsx so the terminal can call it without pulling in React. */
import type { FileRef } from './fileRefParse.js';

type OpenFile = (
  path: string,
  kind?: 'preview' | 'sticky',
  goto?: { line: number; col: number },
) => void;

/** Resolve `ref` to an absolute path (via the worktree file index when
 *  it's relative) and open it, jumping to the referenced line when one
 *  is present. No-op when the ref can't be resolved to a real file. */
export async function resolveAndOpenFileRef(args: {
  ref: FileRef;
  sessionId: string;
  worktreePath: string | null;
  openFile: OpenFile;
}): Promise<void> {
  const { ref, sessionId, worktreePath, openFile } = args;
  let abs: string | null = null;
  if (ref.path.startsWith('/')) {
    abs = ref.path;
  } else if (worktreePath) {
    try {
      const res = await window.baton.call('worktree.resolveFile', {
        sessionId,
        ref: ref.path,
      });
      if (res.matches.length > 0) {
        abs = `${worktreePath}/${res.matches[0]}`;
      } else if (ref.path.includes('/')) {
        // No index hit but the ref carries a directory — best-effort
        // join. A bare basename with no match we leave alone rather than
        // open a path that probably doesn't exist.
        abs = `${worktreePath}/${ref.path.replace(/^\.\//, '')}`;
      }
    } catch {
      abs = null;
    }
  }
  if (!abs) return;
  openFile(
    abs,
    'preview',
    ref.line !== null ? { line: ref.line, col: ref.col ?? 1 } : undefined,
  );
}
