/**
 * WorktreeManager — creates and tears down git worktrees for
 * worktree-per-agent sessions (PRD F2.2 / F7.2).
 *
 * Worktrees live at `<projectRoot>/.code24/worktrees/<branchSlug>/`,
 * inside the user's project — same pattern as Crystal. The `.code24/`
 * directory is gitignored on first create so the project never sees
 * any of our state as untracked files, and the same dir is reserved
 * for future per-project app state (caches, session metadata, etc.).
 *
 * Mirrors Crystal's `worktreeManager.ts` pattern: withLock-serialised
 * creates, tolerant remove. (Crystal's code is the precedent we
 * cited in `docs/prior-art.md`.)
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import simpleGit from 'simple-git';

const CODE24_DIR_NAME = '.code24';
const WORKTREES_SUBDIR = 'worktrees';
const GITIGNORE_MARKER = '# code24: per-project app state (worktrees, caches, …)';

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
  const wtDir = path.join(
    args.projectRoot,
    CODE24_DIR_NAME,
    WORKTREES_SUBDIR,
    branchSlug
  );
  const lockKey = `wt:${args.projectRoot}:${branchSlug}`;

  return withLock(lockKey, async () => {
    if (fs.existsSync(wtDir)) {
      throw new Error(`A worktree already exists at ${wtDir}.`);
    }
    if (!fs.existsSync(path.join(args.projectRoot, '.git'))) {
      throw new Error(
        `Cannot create a worktree: ${args.projectRoot} is not a git repo.`
      );
    }

    // Make sure .code24-worktrees/ is gitignored BEFORE we create the
    // worktree inside it — otherwise `git status` in the project root
    // shows the worktree as untracked, which users will accidentally
    // commit. Best-effort; failure is logged but not fatal.
    try {
      ensureGitignored(args.projectRoot);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(
        `[code24] could not update .gitignore in ${args.projectRoot}:`,
        err
      );
    }

    fs.mkdirSync(path.dirname(wtDir), { recursive: true });

    const git = simpleGit(args.projectRoot);
    // `git worktree add -b <branch> <path> [base]`
    const cmd = ['worktree', 'add', '-b', branch, wtDir];
    if (args.base) cmd.push(args.base);
    try {
      await git.raw(cmd);
    } catch (err) {
      // Clean up the partial dir so a retry can succeed.
      try { fs.rmSync(wtDir, { recursive: true, force: true }); } catch { /* ignore */ }
      throw new Error(
        `git worktree add failed: ${err instanceof Error ? err.message : String(err)}`
      );
    }

    return { path: wtDir, branch };
  });
}

/**
 * Append `.code24/` to the project's `.gitignore` if it isn't already
 * excluded. Idempotent — re-running on a project that already has the
 * entry is a no-op. Creates a `.gitignore` if one doesn't exist.
 *
 * We exclude the WHOLE `.code24/` dir (not just `.code24/worktrees/`)
 * because the same dir is reserved for other per-project app state.
 */
function ensureGitignored(projectRoot: string): void {
  const gitignorePath = path.join(projectRoot, '.gitignore');
  let content = '';
  if (fs.existsSync(gitignorePath)) {
    content = fs.readFileSync(gitignorePath, 'utf-8');
    const lines = content.split(/\r?\n/).map((l) => l.trim());
    const isExcluded = lines.some((line) =>
      line === `${CODE24_DIR_NAME}/` ||
      line === CODE24_DIR_NAME ||
      line === `/${CODE24_DIR_NAME}/` ||
      line === `/${CODE24_DIR_NAME}`
    );
    if (isExcluded) return; // already excluded
  }
  const sep = content.length === 0 || content.endsWith('\n') ? '' : '\n';
  const block = `${sep}\n${GITIGNORE_MARKER}\n${CODE24_DIR_NAME}/\n`;
  fs.writeFileSync(gitignorePath, content + block);
}

export interface RenameWorktreeArgs {
  projectRoot: string;
  worktreePath: string;
  newBranchName: string;
}

/**
 * Rename a worktree's branch + move its directory to match. Used when
 * the user picked the auto-generated `wip-<hex>` default and now wants
 * a real branch name.
 *
 * Steps:
 *   1) git branch -m <old> <new>  (inside the worktree)
 *   2) git worktree move <oldDir> <newDir>  (from the project root)
 *
 * Caller is responsible for ensuring the worktree's pty/agent is NOT
 * live (no held file handles).
 */
export async function renameWorktree(
  args: RenameWorktreeArgs
): Promise<WorktreeInfo> {
  const newBranch = args.newBranchName.trim();
  if (!newBranch) throw new Error('New branch name is required.');

  const newSlug = slugify(newBranch);
  const newDir = path.join(
    path.dirname(args.worktreePath),
    newSlug
  );
  if (newDir === args.worktreePath) {
    // No real change. Read the current branch and return.
    const cur = await simpleGit(args.worktreePath).revparse([
      '--abbrev-ref', 'HEAD',
    ]);
    return { path: args.worktreePath, branch: cur.trim() };
  }
  if (fs.existsSync(newDir)) {
    throw new Error(`A worktree already exists at ${newDir}.`);
  }

  const lockKey = `wt:${args.projectRoot}:${newSlug}`;
  return withLock(lockKey, async () => {
    const wtGit = simpleGit(args.worktreePath);
    const oldBranch = (
      await wtGit.revparse(['--abbrev-ref', 'HEAD'])
    ).trim();

    // 1) Rename the branch inside the worktree. `branch -m` keeps
    //    HEAD pointing at the renamed ref.
    if (oldBranch !== newBranch) {
      try {
        await wtGit.raw(['branch', '-m', oldBranch, newBranch]);
      } catch (err) {
        throw new Error(
          `git branch -m failed: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }

    // 2) Move the worktree directory. From the project root.
    try {
      await simpleGit(args.projectRoot).raw([
        'worktree', 'move', args.worktreePath, newDir,
      ]);
    } catch (err) {
      // Try to roll the branch rename back so we don't leave the
      // user in a confused half-state.
      try {
        if (oldBranch !== newBranch) {
          await wtGit.raw(['branch', '-m', newBranch, oldBranch]);
        }
      } catch { /* best-effort rollback */ }
      throw new Error(
        `git worktree move failed: ${err instanceof Error ? err.message : String(err)}`
      );
    }

    return { path: newDir, branch: newBranch };
  });
}

/** Tolerant remove — never throws. */
export async function removeWorktree(
  projectRoot: string,
  worktreePath: string
): Promise<void> {
  try {
    const git = simpleGit(projectRoot);
    await git.raw(['worktree', 'remove', '--force', worktreePath]);
  } catch {
    // It may already be gone, or the project root may have moved.
    // The cleanup below handles that case.
  }
  try {
    if (fs.existsSync(worktreePath)) {
      fs.rmSync(worktreePath, { recursive: true, force: true });
    }
  } catch { /* ignore */ }
}
