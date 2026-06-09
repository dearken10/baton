/**
 * Worktree readers — file tree + git status for the right column.
 *
 * Local path (Fs.isLocal): `isomorphic-git`'s `statusMatrix` for git
 * status and `fs.readdir` for the tree. Same code as before the Stage 2
 * refactor — no subprocess on the steady-state polling path.
 *
 * Remote path: SSH via the BatonFs. The tree walk uses Fs.readdir;
 * git status shells `git -C <dir> status --porcelain=v2 --branch -z`
 * and parses the result. ahead/behind comes from the branch.ab line in
 * the porcelain v2 header.
 *
 * Per PRD F7.6, the file tree is intentionally bounded — depth and
 * fanout caps stop runaway scans on monorepo trees.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as git from 'isomorphic-git';
import { readCurrentBranch } from './gitReader.js';
import type { BatonFs } from './fs/types.js';

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

export async function readFileTree(batonFs: BatonFs, root: string): Promise<FileTreeNode> {
  const name = path.basename(root) || root;
  const node: FileTreeNode = { name, path: '', type: 'dir', children: [] };
  await walk(batonFs, root, node, 0);
  return node;
}

/** Read one level of children for an existing directory inside the
 *  worktree. Used by the renderer to lazily load nodes the initial
 *  fileTree call left at the depth cap. `relPath` is `/`-separated and
 *  relative to the worktree root; empty means the root itself. */
export async function readSubdir(
  batonFs: BatonFs,
  root: string,
  relPath: string,
): Promise<{ children: FileTreeNode[]; truncated: boolean }> {
  const safeRel = relPath.replace(/^\/+|\/+$/g, '');
  if (safeRel.split('/').some((seg) => seg === '..')) {
    return { children: [], truncated: false };
  }
  const absDir = safeRel === '' ? root : posixJoin(root, safeRel);
  const entries = await batonFs.readdir(absDir);
  if (entries.length === 0) return { children: [], truncated: false };

  entries.sort((a, b) => {
    const ad = a.kind === 'dir' ? 0 : 1;
    const bd = b.kind === 'dir' ? 0 : 1;
    if (ad !== bd) return ad - bd;
    return a.name.localeCompare(b.name);
  });
  const limited = entries.slice(0, MAX_ENTRIES_PER_DIR);
  const truncated = entries.length > MAX_ENTRIES_PER_DIR;
  const children: FileTreeNode[] = [];
  for (const entry of limited) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const childRel = safeRel === '' ? entry.name : `${safeRel}/${entry.name}`;
    if (entry.kind === 'dir') {
      children.push({ name: entry.name, path: childRel, type: 'dir' });
    } else if (entry.kind === 'file' || entry.kind === 'symlink') {
      children.push({ name: entry.name, path: childRel, type: 'file' });
    }
  }
  return { children, truncated };
}

async function walk(
  batonFs: BatonFs,
  absDir: string,
  node: FileTreeNode,
  depth: number,
): Promise<void> {
  if (depth >= MAX_DEPTH) { node.truncated = true; delete node.children; return; }
  const entries = await batonFs.readdir(absDir);
  if (entries.length === 0) { node.children = []; return; }

  entries.sort((a, b) => {
    const ad = a.kind === 'dir' ? 0 : 1;
    const bd = b.kind === 'dir' ? 0 : 1;
    if (ad !== bd) return ad - bd;
    return a.name.localeCompare(b.name);
  });

  const limited = entries.slice(0, MAX_ENTRIES_PER_DIR);
  if (entries.length > MAX_ENTRIES_PER_DIR) node.truncated = true;

  const children: FileTreeNode[] = [];
  for (const entry of limited) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const childAbs = posixJoin(absDir, entry.name);
    const childRel = node.path === '' ? entry.name : `${node.path}/${entry.name}`;
    if (entry.kind === 'dir') {
      const child: FileTreeNode = {
        name: entry.name, path: childRel, type: 'dir', children: [],
      };
      await walk(batonFs, childAbs, child, depth + 1);
      children.push(child);
    } else if (entry.kind === 'file' || entry.kind === 'symlink') {
      children.push({ name: entry.name, path: childRel, type: 'file' });
    }
  }
  node.children = children;
}

/** POSIX-style path join. Path-separator on remote hosts is always `/`,
 *  but `path.join` defaults to the host's separator — which on
 *  Windows would produce backslashes. Forcing `/` keeps the strings
 *  consistent across both Fs impls. */
function posixJoin(a: string, b: string): string {
  return a.endsWith('/') ? `${a}${b}` : `${a}/${b}`;
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

export async function readGitStatus(batonFs: BatonFs, dir: string): Promise<GitStatusReport> {
  if (batonFs.isLocal) return readGitStatusLocal(dir);
  return readGitStatusRemote(batonFs, dir);
}

/**
 * Local path: isomorphic-git's statusMatrix. This is the original
 * implementation — kept for parity / no-regression on local projects.
 */
async function readGitStatusLocal(dir: string): Promise<GitStatusReport> {
  const empty: GitStatusReport = {
    branch: null, ahead: 0, behind: 0, files: [], dirty: false,
  };
  try {
    if (!fs.existsSync(path.join(dir, '.git'))) return empty;
  } catch {
    return empty;
  }

  // Note: readCurrentBranch needs an Fs param now; we build a
  // pseudo-LocalFs reference by importing the singleton.
  const branch = await readCurrentBranchLocal(dir);

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
    if (head === 1 && workdir === 1 && stage === 1) continue;
    let state: GitStatusFile['state'];
    if (head === 0 && workdir === 2 && stage === 0) state = 'untracked';
    else if (workdir === 0 && head === 1) state = 'deleted';
    else if (stage === 2 || stage === 3) state = 'staged';
    else state = 'modified';
    files.push({ path: filepath, state });
  }

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
          ahead = await countAhead(dir, local, remote, 50);
          behind = await countAhead(dir, remote, local, 50);
        }
      }
    }
  } catch {
    // best-effort
  }

  return { branch, ahead, behind, files, dirty: files.length > 0 };
}

async function readCurrentBranchLocal(dir: string): Promise<string | null> {
  try {
    if (!fs.existsSync(path.join(dir, '.git'))) return null;
    const b = await git.currentBranch({ fs, dir, fullname: false });
    return b ?? null;
  } catch {
    return null;
  }
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

/**
 * Remote path: shell `git status --porcelain=v2 --branch -z`. The v2
 * porcelain format is stable, machine-readable, and includes the
 * branch + ahead/behind line in the header.
 *
 * Format (NUL-terminated records):
 *   # branch.oid <oid>|(initial)
 *   # branch.head <branch>|(detached)
 *   # branch.upstream <upstream>
 *   # branch.ab +<ahead> -<behind>
 *   1 <XY> ... <path>\0
 *   2 <XY> ... <orig>\0<path>\0     (renames — two paths)
 *   u <XY> ... <path>\0             (conflicted)
 *   ? <path>\0                      (untracked)
 */
async function readGitStatusRemote(batonFs: BatonFs, dir: string): Promise<GitStatusReport> {
  const empty: GitStatusReport = {
    branch: null, ahead: 0, behind: 0, files: [], dirty: false,
  };
  const branchProbe = await readCurrentBranch(batonFs, dir);
  if (branchProbe == null) {
    // not a git repo, or detached — but detached we still want status
    const isRepo = await batonFs.exists(`${dir.replace(/\/$/, '')}/.git`);
    if (!isRepo) return empty;
  }
  const res = await batonFs.exec(
    'git', ['status', '--porcelain=v2', '--branch', '-z'],
    { cwd: dir, timeoutMs: 15_000 }
  );
  if (res.code !== 0) return { ...empty, branch: branchProbe };

  let branch: string | null = branchProbe;
  let ahead = 0;
  let behind = 0;
  const files: GitStatusFile[] = [];

  // `-z` separates ENTRIES with NUL. Headers are still newline-prefixed.
  // We split on NUL first, then handle multi-record entries (renames).
  const records = res.stdout.split('\0');
  let i = 0;
  while (i < records.length) {
    const rec = records[i] ?? '';
    if (!rec) { i++; continue; }
    if (rec.startsWith('# branch.head ')) {
      const head = rec.slice('# branch.head '.length).trim();
      if (head && head !== '(detached)') branch = head;
      i++; continue;
    }
    if (rec.startsWith('# branch.ab ')) {
      const m = /\+(\d+)\s+-(\d+)/.exec(rec);
      if (m) { ahead = Number(m[1]); behind = Number(m[2]); }
      i++; continue;
    }
    if (rec.startsWith('# ')) { i++; continue; }
    // Entry records — first char is the kind tag.
    const tag = rec[0];
    if (tag === '1') {
      // "1 XY sub ... <path>"
      const parsed = parseEntry1(rec);
      if (parsed) files.push(parsed);
      i++;
    } else if (tag === '2') {
      // "2 XY sub ... <new>" followed by a separate NUL-terminated <orig>
      const parsed = parseEntry1(rec);
      if (parsed) files.push(parsed);
      // skip the rename source path too
      i += 2;
    } else if (tag === 'u') {
      // unmerged
      const m = /^u\s+(\S+)\s+/.exec(rec);
      void m;
      const parts = rec.split(' ');
      const filePath = parts.slice(8).join(' ');
      if (filePath) files.push({ path: filePath, state: 'conflicted' });
      i++;
    } else if (tag === '?') {
      const filePath = rec.slice(2);
      if (filePath) files.push({ path: filePath, state: 'untracked' });
      i++;
    } else if (tag === '!') {
      // ignored — skip
      i++;
    } else {
      i++;
    }
  }

  return { branch, ahead, behind, files, dirty: files.length > 0 };
}

/** Parse a porcelain v2 "1" line: `1 XY sub mH mI mW hH hI <path>`. */
function parseEntry1(rec: string): GitStatusFile | null {
  // Fields are space-separated except the last one, which is the path
  // (paths with spaces are allowed; -z prevents NUL issues per record).
  const parts = rec.split(' ');
  if (parts.length < 9) return null;
  const xy = parts[1] ?? '';
  const x = xy[0];
  const y = xy[1];
  const filePath = parts.slice(8).join(' ');
  if (!filePath) return null;
  let state: GitStatusFile['state'];
  if (y === 'D') state = 'deleted';
  else if (x === 'D') state = 'deleted';
  else if (x && x !== '.') state = 'staged';
  else state = 'modified';
  return { path: filePath, state };
}
