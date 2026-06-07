/**
 * WorktreeManager — creates and tears down git worktrees for
 * worktree-per-agent sessions (PRD F2.2 / F7.2).
 *
 * Worktrees live at `~/.code24/worktrees/<projectId>/<branchSlug>/`,
 * deliberately *outside* the user's project root so:
 *   - they don't pollute the project tree,
 *   - they don't fight with the user's `.gitignore` rules,
 *   - they're trivial to clean up when a session ends.
 *
 * Mirrors Crystal's `worktreeManager.ts` pattern: withLock-serialised
 * creates, tolerant remove, init-on-empty-repo fallback. (Crystal's
 * code is the precedent we cited in `docs/prior-art.md`.)
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { homedir } from 'node:os';
import simpleGit from 'simple-git';

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

const WORKTREES_ROOT = path.join(homedir(), '.code24', 'worktrees');

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

  const wtDir = path.join(WORKTREES_ROOT, args.projectId, slugify(branch));
  const lockKey = `wt:${args.projectId}:${slugify(branch)}`;

  return withLock(lockKey, async () => {
    if (fs.existsSync(wtDir)) {
      throw new Error(`A worktree already exists at ${wtDir}.`);
    }
    if (!fs.existsSync(path.join(args.projectRoot, '.git'))) {
      throw new Error(
        `Cannot create a worktree: ${args.projectRoot} is not a git repo.`
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
