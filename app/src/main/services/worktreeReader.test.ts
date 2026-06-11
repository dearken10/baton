/**
 * Tests for parsePorcelainV2 — the shared parser for
 * `git status --porcelain=v2 --branch -z` used by both the local and
 * remote git-status paths.
 *
 * With `-z`, git NUL-terminates EVERY record — including each `# branch.*`
 * header (they are NOT newline-joined). The parser splits on NUL, so each
 * fixture below joins its records with NUL via `rec()`. Verified against
 * real `git status --porcelain=v2 --branch -z` output.
 */

import { describe, expect, it } from 'vitest';
import { parsePorcelainV2 } from './worktreeReader.js';

const NUL = String.fromCharCode(0);
/** Join porcelain records the way `-z` emits them: NUL after each. */
function rec(...records: string[]): string {
  return records.map((r) => r + NUL).join('');
}

describe('parsePorcelainV2', () => {
  it('parses branch + ahead/behind from the header', () => {
    const out = rec(
      '# branch.oid abc123',
      '# branch.head main',
      '# branch.upstream origin/main',
      '# branch.ab +2 -3',
    );
    const r = parsePorcelainV2(out);
    expect(r.branch).toBe('main');
    expect(r.ahead).toBe(2);
    expect(r.behind).toBe(3);
    expect(r.files).toEqual([]);
    expect(r.dirty).toBe(false);
  });

  it('treats a detached HEAD as no branch', () => {
    const out = rec('# branch.oid abc123', '# branch.head (detached)');
    const r = parsePorcelainV2(out);
    expect(r.branch).toBeNull();
  });

  it('handles an initial commit (no ab line)', () => {
    const out = rec('# branch.oid (initial)', '# branch.head main');
    const r = parsePorcelainV2(out);
    expect(r.branch).toBe('main');
    expect(r.ahead).toBe(0);
    expect(r.behind).toBe(0);
  });

  it('parses an untracked file', () => {
    const out = rec('# branch.head main', '? newfile.txt');
    const r = parsePorcelainV2(out);
    expect(r.files).toEqual([{ path: 'newfile.txt', state: 'untracked' }]);
    expect(r.dirty).toBe(true);
  });

  it('parses a worktree-modified file (XY = ".M")', () => {
    const out = rec(
      '# branch.head main',
      '1 .M N... 100644 100644 100644 aaa bbb src/app.ts',
    );
    const r = parsePorcelainV2(out);
    expect(r.files).toEqual([{ path: 'src/app.ts', state: 'modified' }]);
  });

  it('parses a staged file (X != ".")', () => {
    const out = rec(
      '# branch.head main',
      '1 M. N... 100644 100644 100644 aaa bbb staged.ts',
    );
    const r = parsePorcelainV2(out);
    expect(r.files).toEqual([{ path: 'staged.ts', state: 'staged' }]);
  });

  it('parses a deleted file', () => {
    const out = rec(
      '# branch.head main',
      '1 .D N... 100644 100644 000000 aaa bbb gone.ts',
    );
    const r = parsePorcelainV2(out);
    expect(r.files).toEqual([{ path: 'gone.ts', state: 'deleted' }]);
  });

  it('parses a rename ("2" entry) and skips the source path record', () => {
    // A "2" entry is followed by a separate NUL-terminated original path.
    const out = rec(
      '# branch.head main',
      '2 R. N... 100644 100644 100644 aaa bbb R100 newname.ts',
      'oldname.ts',
      '? after.txt',
    );
    const r = parsePorcelainV2(out);
    // newname.ts (staged rename) + after.txt (untracked); oldname.ts skipped.
    expect(r.files).toEqual([
      { path: 'newname.ts', state: 'staged' },
      { path: 'after.txt', state: 'untracked' },
    ]);
  });

  it('parses a conflicted ("u") entry', () => {
    const out = rec(
      '# branch.head main',
      'u UU N... 100644 100644 100644 100644 aaa bbb ccc conflict.ts',
    );
    const r = parsePorcelainV2(out);
    expect(r.files).toEqual([{ path: 'conflict.ts', state: 'conflicted' }]);
  });

  it('ignores "!" ignored entries', () => {
    const out = rec('# branch.head main', '! ignored.log');
    const r = parsePorcelainV2(out);
    expect(r.files).toEqual([]);
    expect(r.dirty).toBe(false);
  });

  it('handles paths containing spaces', () => {
    const out = rec(
      '# branch.head main',
      '1 .M N... 100644 100644 100644 aaa bbb my file.ts',
    );
    const r = parsePorcelainV2(out);
    expect(r.files).toEqual([{ path: 'my file.ts', state: 'modified' }]);
  });

  it('returns an empty clean report for empty output', () => {
    const r = parsePorcelainV2('');
    expect(r).toEqual({ branch: null, ahead: 0, behind: 0, files: [], dirty: false });
  });

  it('combines multiple entries and marks dirty', () => {
    const out = rec(
      '# branch.head main',
      '# branch.ab +0 -0',
      '1 M. N... 100644 100644 100644 aaa bbb a.ts',
      '1 .M N... 100644 100644 100644 aaa bbb b.ts',
      '? c.ts',
    );
    const r = parsePorcelainV2(out);
    expect(r.branch).toBe('main');
    expect(r.files).toHaveLength(3);
    expect(r.dirty).toBe(true);
  });
});
