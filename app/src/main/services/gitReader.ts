/**
 * Pure-Node git metadata reader.
 *
 * Local: isomorphic-git on the local fs. No subprocess.
 * Remote: `git -C <dir> rev-parse --abbrev-ref HEAD` over SSH.
 *
 * The Fs parameter is what tells us which path to take. Callers should
 * resolve the Fs from the project's connection (registry.getFs*).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { currentBranch } from 'isomorphic-git';
import type { BatonFs } from './fs/types.js';

/**
 * Return the current branch name for `dir`, or null if it's not a
 * git repo or is in a detached-HEAD state. Never throws — failures
 * become null.
 */
export async function readCurrentBranch(
  batonFs: BatonFs,
  dir: string,
): Promise<string | null> {
  try {
    if (batonFs.isLocal) {
      if (!fs.existsSync(path.join(dir, '.git'))) return null;
      const branch = await currentBranch({ fs, dir, fullname: false });
      if (!branch) return null;
      return branch;
    }
    const res = await batonFs.exec(
      'git', ['rev-parse', '--abbrev-ref', 'HEAD'],
      { cwd: dir, timeoutMs: 8000 }
    );
    if (res.code !== 0) return null;
    const branch = res.stdout.trim();
    if (!branch || branch === 'HEAD') return null;
    return branch;
  } catch {
    return null;
  }
}
