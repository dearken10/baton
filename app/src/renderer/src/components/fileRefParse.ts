/** Pure parsing of file references out of transcript text. Kept free of
 *  React / store imports so it's cheap to unit-test in the node vitest
 *  environment. The rendering wrapper lives in FileRefText.tsx. */

/** A file reference detected in transcript text, e.g.
 *  `process-sop.service.ts:1158` or `src/foo/bar.ts`. */
export interface FileRef {
  /** The exact substring that matched (rendered as the link label). */
  raw: string;
  /** Path portion only (no `:line:col`), as it appeared. */
  path: string;
  line: number | null;
  col: number | null;
}

export type Segment =
  | { kind: 'text'; text: string }
  | { kind: 'ref'; ref: FileRef };

// A path-ish token ending in `.ext`, with an optional `:line[:col]`
// suffix. The leading lookbehind rejects matches that sit inside a
// larger token (URLs like https://x/y.ts, emails) so we don't linkify
// fragments of URLs.
const FILE_REF_RE =
  /(?<![\w/@:.-])((?:\.\/)?(?:[\w.-]+\/)*[\w.-]+\.[A-Za-z][\w]{0,9})(?::(\d+)(?::(\d+))?)?/g;

/** A file reference located within a blob of text, carrying the
 *  half-open `[start, end)` character offsets of the matched substring.
 *  Used by the xterm link provider to build cell ranges. */
export interface LocatedFileRef {
  ref: FileRef;
  start: number;
  end: number;
}

/** Scan `text` and return every substring that is a linkable file
 *  reference, with its character offsets. Shared by `parseFileRefs`
 *  (renderer segments) and the terminal link provider (cell ranges). */
export function findFileRefs(text: string): LocatedFileRef[] {
  const found: LocatedFileRef[] = [];
  // Reset the shared regex's cursor — it's stateful with the /g flag.
  FILE_REF_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = FILE_REF_RE.exec(text)) !== null) {
    const path = m[1];
    const line = m[2] ? Number(m[2]) : null;
    const col = m[3] ? Number(m[3]) : null;
    // Only accept as a link when it's unambiguously a file reference:
    // it carries an explicit `:line` suffix, or a directory component.
    // A bare `name.ext` in prose (e.g. "Node.js", "package.json") is too
    // noisy and often a dead link, so we leave those as plain text.
    const isLink = line !== null || path.includes('/');
    if (!isLink) continue;
    found.push({
      ref: { raw: m[0], path, line, col },
      start: m.index,
      end: m.index + m[0].length,
    });
  }
  return found;
}

/** Split a blob of text into alternating plain-text and file-reference
 *  segments. */
export function parseFileRefs(text: string): Segment[] {
  const segments: Segment[] = [];
  let lastIndex = 0;
  for (const { ref, start, end } of findFileRefs(text)) {
    if (start > lastIndex) {
      segments.push({ kind: 'text', text: text.slice(lastIndex, start) });
    }
    segments.push({ kind: 'ref', ref });
    lastIndex = end;
  }
  if (lastIndex < text.length) {
    segments.push({ kind: 'text', text: text.slice(lastIndex) });
  }
  return segments;
}
