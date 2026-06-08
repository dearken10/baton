/**
 * Worktree readers — file tree + git status for the right column.
 *
 * Per PRD F7.1, read-only metadata avoids shelling out to `git`. We
 * use `isomorphic-git`'s `statusMatrix` for status because it gives
 * us a structured per-file result in one call. Branch + ahead/behind
 * are derived alongside.
 *
 * Per PRD F7.6, the file tree is intentionally bounded — depth and
 * fanout caps stop runaway scans on monorepo trees.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as git from 'isomorphic-git';
import { readCurrentBranch } from './gitReader.js';

/** Directories we always skip — large, derived, or noisy. */
const SKIP_DIRS = new Set([
  '.git',
  'node_modules',
  '.baton',
  'dist',
  'build',
  'out',
  '.next',
  '.cache',
  '.turbo',
  '.parcel-cache',
  '.vite',
  'coverage',
  '.DS_Store',
]);

const MAX_DEPTH = 4;
const MAX_ENTRIES_PER_DIR = 200;

export interface FileTreeNode {
  /** File / dir name. */
  name: string;
  /** Path relative to the worktree root, with `/` separators. */
  path: string;
  /** Always 'file' or 'dir'. */
  type: 'file' | 'dir';
  /** Children for dirs, undefined for files. Empty array means
   *  scanned-but-empty; absent means depth cap hit. */
  children?: FileTreeNode[];
  /** True when we stopped descending because of depth cap or fanout. */
  truncated?: boolean;
}

export async function readFileTree(root: string): Promise<FileTreeNode> {
  const name = path.basename(root) || root;
  const node: FileTreeNode = { name, path: '', type: 'dir', children: [] };
  await walk(root, node, 0);
  return node;
}

async function walk(absDir: string, node: FileTreeNode, depth: number): Promise<void> {
  if (depth >= MAX_DEPTH) { node.truncated = true; delete node.children; return; }
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(absDir, { withFileTypes: true });
  } catch {
    node.children = [];
    return;
  }

  // Sort dirs first, then files, both alphabetical.
  entries.sort((a, b) => {
    const ad = a.isDirectory() ? 0 : 1;
    const bd = b.isDirectory() ? 0 : 1;
    if (ad !== bd) return ad - bd;
    return a.name.localeCompare(b.name);
  });

  const limited = entries.slice(0, MAX_ENTRIES_PER_DIR);
  if (entries.length > MAX_ENTRIES_PER_DIR) node.truncated = true;

  const children: FileTreeNode[] = [];
  for (const entry of limited) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const childAbs = path.join(absDir, entry.name);
    const childRel = node.path === '' ? entry.name : `${node.path}/${entry.name}`;
    if (entry.isDirectory()) {
      const child: FileTreeNode = {
        name: entry.name, path: childRel, type: 'dir', children: [],
      };
      await walk(childAbs, child, depth + 1);
      children.push(child);
    } else if (entry.isFile() || entry.isSymbolicLink()) {
      children.push({ name: entry.name, path: childRel, type: 'file' });
    }
  }
  node.children = children;
}

export interface GitStatusFile {
  /** Path relative to the worktree root. */
  path: string;
  /** A coarse bucket the UI groups by. */
  state: 'modified' | 'staged' | 'untracked' | 'deleted' | 'conflicted';
}

export interface GitStatusReport {
  branch: string | null;
  ahead: number;
  behind: number;
  files: GitStatusFile[];
  dirty: boolean;
}

/**
 * isomorphic-git's statusMatrix returns rows of
 *   [filepath, head, workdir, stage]
 * where each numeric is 0/1/2/3 — see the docs. We bucket into the
 * five states the UI cares about.
 */
export async function readGitStatus(dir: string): Promise<GitStatusReport> {
  const empty: GitStatusReport = {
    branch: null, ahead: 0, behind: 0, files: [], dirty: false,
  };
  try {
    if (!fs.existsSync(path.join(dir, '.git'))) return empty;
  } catch {
    return empty;
  }

  const branch = await readCurrentBranch(dir);

  let matrix: Array<[string, number, number, number]> = [];
  try {
    matrix = (await git.statusMatrix({ fs, dir })) as Array<
      [string, number, number, number]
    >;
  } catch {
    return { ...empty, branch };
  }

  const files: GitStatusFile[] = [];
  for (const [filepath, head, workdir, stage] of matrix) {
    // Unchanged: head=1, workdir=1, stage=1. Skip those.
    if (head === 1 && workdir === 1 && stage === 1) continue;
    let state: GitStatusFile['state'];
    if (head === 0 && workdir === 2 && stage === 0) state = 'untracked';
    else if (workdir === 0 && head === 1) state = 'deleted';
    else if (stage === 2 || stage === 3) state = 'staged';
    else state = 'modified';
    files.push({ path: filepath, state });
  }

  // Best-effort ahead/behind. Needs the remote ref; if it's missing we
  // just leave zeros. Real ahead/behind requires a fetched remote.
  let ahead = 0;
  let behind = 0;
  try {
    if (branch) {
      const cfg = await git.getConfig({ fs, dir, path: `branch.${branch}.remote` });
      const remoteBranch = await git.getConfig({
        fs, dir, path: `branch.${branch}.merge`,
      });
      if (cfg && remoteBranch) {
        const remoteName = String(cfg);
        const remoteRefShort = String(remoteBranch).replace('refs/heads/', '');
        const local = await git.resolveRef({ fs, dir, ref: branch });
        const remote = await git.resolveRef({
          fs, dir, ref: `refs/remotes/${remoteName}/${remoteRefShort}`,
        }).catch(() => null);
        if (remote) {
          // Cheap walk: count commits reachable from local but not remote
          // and vice versa. Cap at 50 each so a wildly diverged branch
          // doesn't lock the UI.
          ahead = await countAhead(dir, local, remote, 50);
          behind = await countAhead(dir, remote, local, 50);
        }
      }
    }
  } catch {
    // ahead/behind isn't critical — leave at 0
  }

  return { branch, ahead, behind, files, dirty: files.length > 0 };
}

async function countAhead(
  dir: string, from: string, until: string, cap: number
): Promise<number> {
  try {
    const log = await git.log({ fs, dir, ref: from, depth: cap });
    let n = 0;
    for (const commit of log) {
      if (commit.oid === until) break;
      n++;
    }
    return n;
  } catch {
    return 0;
  }
}
