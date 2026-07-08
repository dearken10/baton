/**
 * Git plumbing for "revert to this turn": snapshot a worktree's
 * working-tree state into a dangling commit, and later restore the
 * worktree to one of those commits.
 *
 * Kept deliberately free of electron / node-pty / SQLite imports so it
 * can be exercised headlessly against a real temp repo (see
 * worktreeSnapshot.test.ts). The SessionManager owns the surrounding
 * orchestration (when to snapshot, the turn↔commit bookkeeping in the
 * DB, kill/respawn); this module is only the git half.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { BatonFs } from './fs/types.js';

/**
 * Snapshot `cwd`'s current working tree into a dangling commit and park
 * a ref at refs/baton/snap/<sha> so gc can't reap it. Returns the commit
 * sha, or null if anything went wrong (caller treats null as "this turn
 * has no code snapshot").
 *
 * The capture writes through a throwaway GIT_INDEX_FILE, so the
 * worktree's real index is never touched. An empty temp index + `add -A`
 * yields a tree that is exactly the working tree minus .gitignored paths
 * — which is what we want, since the restore's `clean -fd` likewise
 * leaves ignored files (node_modules &c.) alone.
 */
export async function captureWorktreeSnapshot(
  batonFs: BatonFs,
  cwd: string,
): Promise<string | null> {
  const tmpIndex = path.join(
    os.tmpdir(),
    `baton-snap-index-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  const env = { GIT_INDEX_FILE: tmpIndex };
  try {
    // Parent on HEAD when there is one; tolerate an unborn HEAD (a
    // brand-new repo with no commits yet).
    const head = await batonFs.exec('git', ['rev-parse', 'HEAD'], {
      cwd, timeoutMs: 8000,
    });
    const headSha = head.code === 0 ? head.stdout.trim() : '';

    const add = await batonFs.exec('git', ['add', '-A'], {
      cwd, env, timeoutMs: 30000,
    });
    if (add.code !== 0) return null;

    const tree = await batonFs.exec('git', ['write-tree'], {
      cwd, env, timeoutMs: 20000,
    });
    const treeSha = tree.stdout.trim();
    if (tree.code !== 0 || !treeSha) return null;

    const commitArgs = ['commit-tree', treeSha, '-m', 'baton turn snapshot'];
    if (headSha) commitArgs.push('-p', headSha);
    const commit = await batonFs.exec('git', commitArgs, {
      cwd, env, timeoutMs: 8000,
    });
    const commitSha = commit.stdout.trim();
    if (commit.code !== 0 || !commitSha) return null;

    // Park a ref so the dangling commit survives gc.
    await batonFs.exec(
      'git', ['update-ref', `refs/baton/snap/${commitSha}`, commitSha],
      { cwd, timeoutMs: 8000 },
    );
    return commitSha;
  } catch {
    return null;
  } finally {
    try { fs.unlinkSync(tmpIndex); } catch { /* may not exist */ }
  }
}

/**
 * Restore `cwd`'s files to the tree of `commitSha`. Sequence matters:
 *   1. read-tree -u --reset → worktree + index match the snapshot
 *      (overwrites edits, removes tracked files that didn't exist then)
 *   2. clean -fd            → drop files created after the snapshot.
 *      Runs while the index still matches the snapshot, so snapshot
 *      files count as tracked and are preserved; only genuinely-new
 *      untracked files are swept. Respects .gitignore (node_modules &c.
 *      survive).
 *   3. reset --mixed HEAD   → point the index back at HEAD without
 *      touching the worktree, so the restored changes show up as
 *      ordinary unstaged edits — exactly how the agent left them.
 * Returns false on any git failure so the caller can report a
 * conversation-only revert.
 */
export async function restoreWorktreeToCommit(
  batonFs: BatonFs,
  cwd: string,
  commitSha: string,
): Promise<boolean> {
  try {
    const read = await batonFs.exec(
      'git', ['read-tree', '-u', '--reset', commitSha],
      { cwd, timeoutMs: 30000 },
    );
    if (read.code !== 0) return false;
    await batonFs.exec('git', ['clean', '-fd'], { cwd, timeoutMs: 30000 });
    await batonFs.exec('git', ['reset', '--mixed', 'HEAD'], {
      cwd, timeoutMs: 20000,
    });
    return true;
  } catch {
    return false;
  }
}
