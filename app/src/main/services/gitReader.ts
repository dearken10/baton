/**
 * Pure-Node git metadata reader.
 *
 * Per PRD F7.1: read-only metadata uses `isomorphic-git`, not a
 * shell-out to `git`. No subprocess on the steady-state polling
 * path. Cheap and predictable.
 *
 * Only the bits we need today live here. Branch, ahead/behind,
 * dirty/clean follow as we wire them into the radar.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { currentBranch } from 'isomorphic-git';

/**
 * Return the current branch name for `dir`, or null if it's not a
 * git repo or is in a detached-HEAD state. Never throws — failures
 * become null.
 */
export async function readCurrentBranch(dir: string): Promise<string | null> {
  try {
    // Cheap early-out: no .git? not a repo.
    if (!fs.existsSync(path.join(dir, '.git'))) return null;
    const branch = await currentBranch({ fs, dir, fullname: false });
    if (!branch) return null;
    return branch;
  } catch {
    return null;
  }
}
