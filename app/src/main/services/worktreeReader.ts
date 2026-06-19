/**
 * Worktree readers — file tree + git status for the right column.
 *
 * Git status (both local and remote) shells `git status --porcelain=v2
 * --branch -z` and parses the result via the shared parsePorcelainV2.
 * ahead/behind comes from the branch.ab line in the porcelain v2 header.
 * Native git uses the index stat-cache and prunes .gitignore'd dirs, so
 * it's bounded and fast — unlike the old isomorphic-git statusMatrix,
 * which walked the whole tree into the heap (see
 * claudedocs/perf-cpu-ram-investigation.md).
 *
 * The file tree (Fs.readdir) is independent of git and works with or
 * without git present.
 *
 * Per PRD F7.6, the file tree is intentionally bounded — depth and
 * fanout caps stop runaway scans on monorepo trees.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { readCurrentBranch } from './gitReader.js';
import { getFs } from './fs/registry.js';
import { trace } from './statusTrace.js';
import type { BatonFs } from './fs/types.js';

/** Directories we always skip — large, derived, or noisy. Shared with
 *  the git watcher so the watch set matches the tree walk. */
export const SKIP_DIRS = new Set([
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
  /** True iff this entry is a submodule container (porcelain v2 `sub`
   *  field starts with `S`). Used by readGitStatus to decide which
   *  entries to expand into their inner file changes; stripped before
   *  the IPC zod schema serialises the response, so the renderer never
   *  sees it. */
  submodule?: boolean;
}

export interface GitStatusReport {
  branch: string | null;
  ahead: number;
  behind: number;
  files: GitStatusFile[];
  dirty: boolean;
}

export async function readGitStatus(batonFs: BatonFs, dir: string): Promise<GitStatusReport> {
  const root = batonFs.isLocal
    ? await readGitStatusLocal(dir)
    : await readGitStatusRemote(batonFs, dir);
  return expandSubmodules(batonFs, dir, root);
}

/**
 * Replace each submodule container entry (`SC..`, `SM..`, etc.) in the
 * report with that submodule's own file-level status, prefixed by the
 * submodule's relative path.
 *
 * Without this, a repo whose `backend/` is a submodule appears in the
 * Git tab as a single "Modified: backend" row — the whole point of
 * tracking changes there is invisible. Reuses readGitStatus*Local|Remote
 * directly (not the public readGitStatus) so we don't recurse into
 * nested submodules; one level handles the common monorepo case
 * without unbounded work.
 */
async function expandSubmodules(
  batonFs: BatonFs,
  dir: string,
  report: GitStatusReport,
): Promise<GitStatusReport> {
  const submoduleEntries = report.files.filter((f) => f.submodule);
  if (submoduleEntries.length === 0) {
    // Strip the (always undefined) submodule field on the way out so the
    // IPC schema doesn't see fields it doesn't know about.
    return { ...report, files: report.files.map(stripSubmoduleFlag) };
  }

  // For each submodule, record both its container entry and its
  // expanded inner files. We keep the container row when the
  // expansion is empty — that's the "submodule HEAD moved but no
  // working-tree changes inside" case (porcelain sub-flags SC..),
  // and dropping it would hide the only signal the user has that
  // something changed in there.
  const expansions = await Promise.all(
    submoduleEntries.map(async (sm): Promise<GitStatusFile[]> => {
      const childDir = joinForFs(batonFs, dir, sm.path);
      try {
        const child = batonFs.isLocal
          ? await readGitStatusLocal(childDir)
          : await readGitStatusRemote(batonFs, childDir);
        return child.files.map((f) => ({
          path: `${sm.path}/${f.path}`,
          state: f.state,
        }));
      } catch {
        // Submodule not initialised / not a repo / SSH blip — silently
        // skip; container row stays so the user knows something is up.
        return [];
      }
    }),
  );

  const droppedContainers = new Set<string>();
  for (let i = 0; i < submoduleEntries.length; i++) {
    if (expansions[i].length > 0) droppedContainers.add(submoduleEntries[i].path);
  }

  const merged: GitStatusFile[] = [
    ...report.files
      .filter((f) => !droppedContainers.has(f.path))
      .map(stripSubmoduleFlag),
    ...expansions.flat(),
  ];
  return { ...report, files: merged, dirty: merged.length > 0 };
}

function stripSubmoduleFlag(f: GitStatusFile): GitStatusFile {
  if (f.submodule === undefined) return f;
  const { submodule: _drop, ...rest } = f;
  void _drop;
  return rest;
}

/** Path-join that respects the fs's separator convention: native on
 *  local (handles Windows `\`), POSIX `/` on remote. */
function joinForFs(batonFs: BatonFs, parent: string, child: string): string {
  if (batonFs.isLocal) return path.join(parent, child);
  return `${parent.replace(/\/$/, '')}/${child}`;
}

const EMPTY_STATUS: GitStatusReport = {
  branch: null, ahead: 0, behind: 0, files: [], dirty: false,
};

/**
 * Local path: native `git status --porcelain=v2 --branch -z` via a
 * subprocess — the same command + parser the remote path uses.
 *
 * Why native git instead of isomorphic-git's statusMatrix: statusMatrix
 * walks the entire working tree in JS and inflates every blob into the
 * V8 heap. With overlapping refreshes that drove the main process to a
 * 15GB heap and a 100%-CPU GC death-spiral (see
 * claudedocs/perf-cpu-ram-investigation.md). Native git uses the index
 * stat-cache and prunes .gitignore'd dirs (node_modules) without ever
 * reading them — bounded memory, near-instant, and it's the source of
 * truth the user's own `git status` reports.
 *
 * git is a hard dependency of this tool (it drives coding agents). If
 * git is absent or the dir is not a repo we return empty status — the
 * file tree (plain readdir) still works, change-tracking is just silent,
 * mirroring how an IDE treats a non-git folder.
 */
async function readGitStatusLocal(dir: string): Promise<GitStatusReport> {
  try {
    if (!fs.existsSync(path.join(dir, '.git'))) return EMPTY_STATUS;
  } catch {
    return EMPTY_STATUS;
  }

  const res = await getFs('local').exec(
    'git', ['status', '--porcelain=v2', '--branch', '-z'],
    { cwd: dir, timeoutMs: 15_000 }
  );
  // ENOENT (git not installed) surfaces as code !== 0 with empty stdout.
  // Distinguish a missing binary from a genuine git error for diagnostics.
  if (res.code !== 0) {
    if (/ENOENT|not found|command not found/i.test(res.stderr)) {
      trace('GIT_ABSENT', { dir });
    }
    return EMPTY_STATUS;
  }
  return parsePorcelainV2(res.stdout);
}

/**
 * Remote path: shell `git status --porcelain=v2 --branch -z` over SSH.
 * Same command + parser as local now.
 */
async function readGitStatusRemote(batonFs: BatonFs, dir: string): Promise<GitStatusReport> {
  const branchProbe = await readCurrentBranch(batonFs, dir);
  if (branchProbe == null) {
    // not a git repo, or detached — but detached we still want status
    const isRepo = await batonFs.exists(`${dir.replace(/\/$/, '')}/.git`);
    if (!isRepo) return EMPTY_STATUS;
  }
  const res = await batonFs.exec(
    'git', ['status', '--porcelain=v2', '--branch', '-z'],
    { cwd: dir, timeoutMs: 15_000 }
  );
  if (res.code !== 0) return { ...EMPTY_STATUS, branch: branchProbe };
  const report = parsePorcelainV2(res.stdout);
  // Fall back to the branch probe if the porcelain header didn't name one.
  return report.branch ? report : { ...report, branch: branchProbe };
}

/**
 * Parse `git status --porcelain=v2 --branch -z` output into a
 * GitStatusReport. Shared by the local and remote paths.
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
export function parsePorcelainV2(stdout: string): GitStatusReport {
  let branch: string | null = null;
  let ahead = 0;
  let behind = 0;
  const files: GitStatusFile[] = [];

  // `-z` separates ENTRIES with NUL. Headers are still newline-prefixed.
  // We split on NUL first, then handle multi-record entries (renames).
  const records = stdout.split('\0');
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
      // "2 XY sub mH mI mW hH hI <Xscore> <path>" — a rename/copy has an
      // extra score field, so the path starts at index 9 (not 8). The
      // <orig> path follows as its own NUL-terminated record — skip it.
      const parsed = parseRenameEntry2(rec);
      if (parsed) files.push(parsed);
      i += 2;
    } else if (tag === 'u') {
      // "u XY sub m1 m2 m3 mW h1 h2 h3 <path>" — three stage modes + three
      // hashes, so the path starts at index 10.
      const parts = rec.split(' ');
      const filePath = parts.slice(10).join(' ');
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
  return parseChangedEntry(rec, 8);
}

/** Parse a porcelain v2 "2" (rename/copy) line:
 *  `2 XY sub mH mI mW hH hI <Xscore> <path>`. The extra <Xscore> field
 *  pushes the path to index 9. */
function parseRenameEntry2(rec: string): GitStatusFile | null {
  return parseChangedEntry(rec, 9);
}

/** Shared body for "1" and "2" entries — they differ only in where the
 *  path starts. XY decides the bucket: X is the staged column, Y the
 *  worktree column. */
function parseChangedEntry(rec: string, pathIndex: number): GitStatusFile | null {
  // Fields are space-separated except the path, which is the tail
  // (paths with spaces are allowed; -z prevents NUL issues per record).
  const parts = rec.split(' ');
  if (parts.length <= pathIndex) return null;
  const xy = parts[1] ?? '';
  const x = xy[0];
  const y = xy[1];
  // `sub` is the third field. Porcelain v2 spec: `N...` for non-submodule
  // entries; `S` followed by 3 letters (each `C/M/U/.`) for submodules.
  // We only need to know "is this a submodule entry" — the sub-flags
  // themselves don't change how we render.
  const sub = parts[2] ?? '';
  const isSubmodule = sub[0] === 'S';
  const filePath = parts.slice(pathIndex).join(' ');
  if (!filePath) return null;
  let state: GitStatusFile['state'];
  if (y === 'D') state = 'deleted';
  else if (x === 'D') state = 'deleted';
  else if (x && x !== '.') state = 'staged';
  else state = 'modified';
  return isSubmodule
    ? { path: filePath, state, submodule: true }
    : { path: filePath, state };
}
