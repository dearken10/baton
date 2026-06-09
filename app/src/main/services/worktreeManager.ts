/**
 * WorktreeManager — creates and tears down git worktrees for
 * worktree-per-agent sessions (PRD F2.2 / F7.2).
 *
 * Worktrees live at `<projectRoot>/.baton/worktrees/<branchSlug>/`,
 * inside the user's project — same pattern as Crystal. The `.baton/`
 * directory is gitignored on first create so the project never sees
 * any of our state as untracked files.
 *
 * Stage 2: every git/fs op routes through the project's BatonFs.
 * LocalFs runs the same code as before; RemoteFs shells the same
 * commands over SSH.
 */

import { posix } from 'node:path';
import type { BatonFs } from './fs/types.js';

const BATON_DIR_NAME = '.baton';
const WORKTREES_SUBDIR = 'worktrees';
const GITIGNORE_MARKER = '# baton: per-project app state (worktrees, caches, …)';

/** Slugify a branch name into a filesystem-safe directory name. */
function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9-_]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

export interface CreateWorktreeArgs {
  /** Stable project id (we use it as the parent dir). */
  projectId: string;
  /** Path of the user's project root (must be a git repo). */
  projectRoot: string;
  /** Branch name to create (e.g. "tts/fix-retries"). */
  branchName: string;
  /** Optional: base commit / branch / ref to branch off from.
   *  Defaults to the current HEAD of the project root. */
  base?: string;
  /** The BatonFs that owns projectRoot (local or remote). */
  fs: BatonFs;
}

export interface WorktreeInfo {
  /** Absolute path to the new worktree directory. */
  path: string;
  /** Branch name (the input, possibly normalised). */
  branch: string;
}

const inFlight = new Map<string, Promise<unknown>>();
function withLock<T>(key: string, op: () => Promise<T>): Promise<T> {
  const prev = inFlight.get(key) ?? Promise.resolve();
  const next = prev.catch(() => undefined).then(op);
  inFlight.set(
    key,
    next.finally(() => {
      if (inFlight.get(key) === next) inFlight.delete(key);
    })
  );
  return next;
}

/** Throws on non-git projects (the caller decides what to do). */
export async function createWorktree(args: CreateWorktreeArgs): Promise<WorktreeInfo> {
  const branch = args.branchName.trim();
  if (!branch) throw new Error('Branch name is required.');

  const branchSlug = slugify(branch);
  const wtDir = posix.join(
    args.projectRoot,
    BATON_DIR_NAME,
    WORKTREES_SUBDIR,
    branchSlug
  );
  const lockKey = `wt:${args.projectRoot}:${branchSlug}`;
  const { fs } = args;

  return withLock(lockKey, async () => {
    if (await fs.exists(wtDir)) {
      throw new Error(`A worktree already exists at ${wtDir}.`);
    }
    if (!(await fs.exists(posix.join(args.projectRoot, '.git')))) {
      throw new Error(
        `Cannot create a worktree: ${args.projectRoot} is not a git repo.`
      );
    }

    try {
      await ensureGitignored(fs, args.projectRoot);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(
        `[baton] could not update .gitignore in ${args.projectRoot}:`,
        err
      );
    }

    await fs.mkdir(posix.dirname(wtDir), { recursive: true });

    const gitArgs = ['worktree', 'add', '-b', branch, wtDir];
    if (args.base) gitArgs.push(args.base);
    const res = await fs.exec('git', gitArgs, {
      cwd: args.projectRoot,
      timeoutMs: 60_000,
    });
    if (res.code !== 0) {
      // Best-effort cleanup so a retry can succeed.
      try { await fs.rm(wtDir, { recursive: true, force: true }); } catch { /* ignore */ }
      throw new Error(
        `git worktree add failed: ${res.stderr.trim() || res.stdout.trim() || `exit ${res.code}`}`
      );
    }
    return { path: wtDir, branch };
  });
}

/**
 * Append `.baton/` to the project's `.gitignore` if it isn't already
 * excluded. Idempotent — re-running on a project that already has the
 * entry is a no-op. Creates a `.gitignore` if one doesn't exist.
 */
async function ensureGitignored(fs: BatonFs, projectRoot: string): Promise<void> {
  const gitignorePath = posix.join(projectRoot, '.gitignore');
  let content = '';
  if (await fs.exists(gitignorePath)) {
    const read = await fs.readFile(gitignorePath, { maxBytes: 256 * 1024 });
    if (read.tooLarge || read.binary) return; // leave it alone
    content = read.content;
    const lines = content.split(/\r?\n/).map((l) => l.trim());
    const isExcluded = lines.some((line) =>
      line === `${BATON_DIR_NAME}/` ||
      line === BATON_DIR_NAME ||
      line === `/${BATON_DIR_NAME}/` ||
      line === `/${BATON_DIR_NAME}`
    );
    if (isExcluded) return;
  }
  const sep = content.length === 0 || content.endsWith('\n') ? '' : '\n';
  const block = `${sep}\n${GITIGNORE_MARKER}\n${BATON_DIR_NAME}/\n`;
  await fs.writeFile(gitignorePath, content + block);
}

export interface RenameWorktreeArgs {
  projectRoot: string;
  worktreePath: string;
  newBranchName: string;
  fs: BatonFs;
}

/**
 * Rename a worktree's branch + move its directory to match. Used when
 * the user picked the auto-generated `wip-<hex>` default and now wants
 * a real branch name.
 */
export async function renameWorktree(
  args: RenameWorktreeArgs
): Promise<WorktreeInfo> {
  const newBranch = args.newBranchName.trim();
  if (!newBranch) throw new Error('New branch name is required.');

  const newSlug = slugify(newBranch);
  const newDir = posix.join(posix.dirname(args.worktreePath), newSlug);
  const { fs } = args;
  if (newDir === args.worktreePath) {
    const cur = await fs.exec('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd: args.worktreePath,
      timeoutMs: 8000,
    });
    return { path: args.worktreePath, branch: cur.stdout.trim() };
  }
  if (await fs.exists(newDir)) {
    throw new Error(`A worktree already exists at ${newDir}.`);
  }

  const lockKey = `wt:${args.projectRoot}:${newSlug}`;
  return withLock(lockKey, async () => {
    const oldBranchRes = await fs.exec('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd: args.worktreePath,
      timeoutMs: 8000,
    });
    const oldBranch = oldBranchRes.stdout.trim();

    if (oldBranch !== newBranch) {
      const rename = await fs.exec(
        'git', ['branch', '-m', oldBranch, newBranch],
        { cwd: args.worktreePath, timeoutMs: 15_000 }
      );
      if (rename.code !== 0) {
        throw new Error(
          `git branch -m failed: ${rename.stderr.trim() || `exit ${rename.code}`}`
        );
      }
    }

    const move = await fs.exec(
      'git', ['worktree', 'move', args.worktreePath, newDir],
      { cwd: args.projectRoot, timeoutMs: 30_000 }
    );
    if (move.code !== 0) {
      // Roll the branch rename back.
      if (oldBranch !== newBranch) {
        await fs.exec(
          'git', ['branch', '-m', newBranch, oldBranch],
          { cwd: args.worktreePath, timeoutMs: 15_000 }
        ).catch(() => { /* best-effort rollback */ });
      }
      throw new Error(
        `git worktree move failed: ${move.stderr.trim() || `exit ${move.code}`}`
      );
    }
    return { path: newDir, branch: newBranch };
  });
}

/** A `git worktree list` row we recognise. */
export interface WorktreeListEntry {
  path: string;
  branch: string | null;
  /** Commit OID (best-effort). */
  head: string | null;
}

/** Parse `git worktree list --porcelain`. */
export async function listWorktrees(
  fs: BatonFs,
  projectRoot: string,
): Promise<WorktreeListEntry[]> {
  if (!(await fs.exists(posix.join(projectRoot, '.git')))) return [];
  const res = await fs.exec(
    'git', ['worktree', 'list', '--porcelain'],
    { cwd: projectRoot, timeoutMs: 15_000 }
  );
  if (res.code !== 0) return [];
  const raw = res.stdout;
  const out: WorktreeListEntry[] = [];
  let cur: Partial<WorktreeListEntry> | null = null;
  for (const line of raw.split('\n')) {
    if (line.startsWith('worktree ')) {
      if (cur) out.push({ path: cur.path ?? '', branch: cur.branch ?? null, head: cur.head ?? null });
      cur = { path: line.slice('worktree '.length).trim() };
    } else if (cur && line.startsWith('HEAD ')) {
      cur.head = line.slice('HEAD '.length).trim();
    } else if (cur && line.startsWith('branch ')) {
      cur.branch = line.slice('branch '.length).trim().replace(/^refs\/heads\//, '');
    } else if (line.trim() === '' && cur) {
      out.push({ path: cur.path ?? '', branch: cur.branch ?? null, head: cur.head ?? null });
      cur = null;
    }
  }
  if (cur) out.push({ path: cur.path ?? '', branch: cur.branch ?? null, head: cur.head ?? null });
  return out.filter((w) => w.path !== projectRoot);
}

/** Tolerant remove — never throws. */
export async function removeWorktree(
  fs: BatonFs,
  projectRoot: string,
  worktreePath: string,
): Promise<void> {
  try {
    await fs.exec(
      'git', ['worktree', 'remove', '--force', worktreePath],
      { cwd: projectRoot, timeoutMs: 30_000 }
    );
  } catch {
    // best-effort
  }
  try {
    if (await fs.exists(worktreePath)) {
      await fs.rm(worktreePath, { recursive: true, force: true });
    }
  } catch { /* ignore */ }
}
