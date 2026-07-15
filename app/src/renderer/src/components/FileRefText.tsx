import { Fragment, useMemo } from 'react';
import { useAppStore } from '../store.js';
import { parseFileRefs, type FileRef } from './fileRefParse.js';
import { resolveAndOpenFileRef } from './openFileRef.js';

interface Props {
  text: string;
  sessionId: string;
}

/** Render transcript text with any file references (`foo/bar.ts:42`)
 *  turned into buttons that open the file in the editor pane, jumping to
 *  the referenced line when one is present. */
export function FileRefText({ text, sessionId }: Props): JSX.Element {
  const openFile = useAppStore((s) => s.openFile);
  const worktreePath = useAppStore((s) => s.sessions[sessionId]?.worktreePath ?? null);
  const segments = useMemo(() => parseFileRefs(text), [text]);

  function openRef(ref: FileRef): Promise<void> {
    return resolveAndOpenFileRef({ ref, sessionId, worktreePath, openFile });
  }

  return (
    <>
      {segments.map((seg, i) =>
        seg.kind === 'text' ? (
          <Fragment key={i}>{seg.text}</Fragment>
        ) : (
          <button
            key={i}
            type="button"
            className="file-ref"
            title={`Open ${seg.ref.path}${seg.ref.line !== null ? `:${seg.ref.line}` : ''}`}
            onClick={() => { void openRef(seg.ref); }}
          >
            {seg.ref.raw}
          </button>
        ),
      )}
    </>
  );
}
