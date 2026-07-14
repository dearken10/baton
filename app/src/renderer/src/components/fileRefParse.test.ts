import { describe, it, expect } from 'vitest';
import { parseFileRefs, type FileRef } from './fileRefParse.js';

/** Pull just the ref segments out for terse assertions. */
function refs(text: string): FileRef[] {
  return parseFileRefs(text)
    .filter((s): s is { kind: 'ref'; ref: FileRef } => s.kind === 'ref')
    .map((s) => s.ref);
}

describe('parseFileRefs', () => {
  it('detects a basename with a line number', () => {
    const r = refs('See process-sop.service.ts:1158 for details.');
    expect(r).toEqual([
      { raw: 'process-sop.service.ts:1158', path: 'process-sop.service.ts', line: 1158, col: null },
    ]);
  });

  it('captures line and column', () => {
    const r = refs('at src/foo/bar.ts:42:7 here');
    expect(r).toEqual([
      { raw: 'src/foo/bar.ts:42:7', path: 'src/foo/bar.ts', line: 42, col: 7 },
    ]);
  });

  it('linkifies a path with a directory even without a line', () => {
    const r = refs('edited src/store.ts today');
    expect(r).toEqual([
      { raw: 'src/store.ts', path: 'src/store.ts', line: null, col: null },
    ]);
  });

  it('does not linkify a bare filename with no line or directory', () => {
    // Too noisy in prose ("Node.js", "package.json") — needs a line or a
    // path component to become a link.
    expect(refs('open store.ts please')).toEqual([]);
  });

  it('strips a leading ./', () => {
    const r = refs('./app/main.ts:3');
    expect(r).toEqual([
      { raw: './app/main.ts:3', path: './app/main.ts', line: 3, col: null },
    ]);
  });

  it('does not linkify prose with an unknown extension and no path/line', () => {
    expect(refs('e.g. this and Node.js runtime')).toEqual([]);
  });

  it('does not linkify a fragment inside a URL', () => {
    expect(refs('https://example.com/app/bar.ts')).toEqual([]);
  });

  it('finds multiple references and preserves surrounding text', () => {
    const segs = parseFileRefs('a.ts:1 and b/c.py:2');
    expect(segs).toEqual([
      { kind: 'ref', ref: { raw: 'a.ts:1', path: 'a.ts', line: 1, col: null } },
      { kind: 'text', text: ' and ' },
      { kind: 'ref', ref: { raw: 'b/c.py:2', path: 'b/c.py', line: 2, col: null } },
    ]);
  });

  it('returns a single text segment when there are no references', () => {
    expect(parseFileRefs('just some words')).toEqual([
      { kind: 'text', text: 'just some words' },
    ]);
  });
});
