/**
 * Git watcher — replaces the renderer's old 3s polling timer with
 * event-driven refreshes. One chokidar watcher per live local worktree;
 * on a debounced filesystem change it emits a `worktree.changed`
 * AppEvent, and the renderer re-fetches git status + the file tree.
 *
 * Why this exists: the old model polled `worktree.gitStatus` every 3s
 * unconditionally, and the local path walked the whole tree in
 * isomorphic-git. Together that produced a 100%-CPU / 15GB GC
 * death-spiral under worktree churn (see
 * claudedocs/perf-cpu-ram-investigation.md). Watching means zero work
 * when idle and one refresh per real change.
 *
 * Scope: LOCAL worktrees only. Remote (SSH) worktrees have no local FS
 * to watch — they keep an explicit/lightweight refresh in the renderer.
 *
 * Critical correctness notes:
 *  - We watch the worktree itself AND the git metadata dir(s). For a
 *    LINKED worktree (baton's worktree-per-agent model), `.git` is a
 *    pointer FILE and the index/HEAD/refs live OUTSIDE the worktree
 *    under `<repo>/.git/worktrees/<name>/` and the common `<repo>/.git`.
 *    We resolve those via `git rev-parse --git-dir --git-common-dir` and
 *    watch them too, or staging/commit/branch changes produce no event.
 *  - The git OBJECT store is EXCLUDED everywhere. A commit or `git gc`
 *    writes thousands of object files; watching them causes event storms.
 *  - Heavy/derived dirs (node_modules, dist, …) are excluded via the
 *    same SKIP_DIRS the file-tree walk uses.
 *  - Watchers are ref-counted by worktree path (multiple sessions can
 *    share a worktree) and torn down on every session-end path.
 */

import chokidar, { type FSWatcher } from 'chokidar';
import { execFileSync } from 'node:child_process';
import * as path from 'node:path';
import { emit } from './eventBus.js';
import { trace } from './statusTrace.js';
import { SKIP_DIRS } from './worktreeReader.js';

/** Debounce window: coalesce a burst of FS events (a save that touches
 *  several files, a checkout) into a single refresh. */
const DEBOUNCE_MS = 300;

/** Max directory depth to watch — bounds the watch set on monorepos.
 *  Matches the spirit of the file-tree depth cap. */
const WATCH_DEPTH = 12;

/** Git metadata entries that signal a status change (staging, commit,
 *  branch switch). Everything else in a git dir — notably `objects` and
 *  `lfs` — is excluded to avoid event storms. */
const GIT_META_WATCH = new Set(['HEAD', 'index', 'refs', 'packed-refs', 'MERGE_HEAD']);

interface WatchEntry {
  watcher: FSWatcher;
  /** session ids currently relying on this watcher (ref-count). */
  sessionIds: Set<string>;
  /** worktree path being watched (the map key). */
  worktreePath: string;
  /** resolved git-dir + git-common-dir watched alongside the worktree. */
  gitDirs: string[];
  debounceTimer: NodeJS.Timeout | null;
}

/** Keyed by worktree path (the thing we actually watch), not session id —
 *  sibling sessions on the same worktree share one watcher. */
const watches = new Map<string, WatchEntry>();
/** session id → worktree path, so stopWatch can find the entry. */
const sessionToPath = new Map<string, string>();
/** Worktree paths whose watcher is mid-close(). A startWatch for the
 *  same path must wait for the close to settle before reopening, or we
 *  end up with a second watcher while the first is still tearing down. */
const closing = new Map<string, Promise<void>>();

/** Resolve the git metadata dirs for a worktree. For a linked worktree
 *  these point OUTSIDE the worktree (the per-worktree dir + the common
 *  dir). Returns [] if `dir` isn't a git repo or git isn't installed. */
function resolveGitDirs(dir: string): string[] {
  try {
    const out = execFileSync(
      'git', ['rev-parse', '--absolute-git-dir', '--git-common-dir'],
      { cwd: dir, encoding: 'utf-8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] },
    );
    const lines = out.split('\n').map((l) => l.trim()).filter(Boolean);
    // --git-common-dir can come back relative to cwd; resolve it.
    const dirs = lines.map((l) => path.resolve(dir, l));
    return [...new Set(dirs)];
  } catch {
    return [];
  }
}

/** Within a watched git dir, ignore everything except the metadata
 *  entries that signal a status change. `objects`/`lfs` excluded. */
function gitDirIgnored(absPath: string, gitDir: string): boolean {
  if (absPath === gitDir) return false;
  const rel = path.relative(gitDir, absPath);
  if (!rel || rel.startsWith('..')) return false;
  const top = rel.split(path.sep)[0] ?? '';
  return !GIT_META_WATCH.has(top);
}

/** True for any path under the worktree we never want to watch. */
function worktreeIgnored(absPath: string, worktreePath: string): boolean {
  if (absPath === worktreePath) return false;
  const rel = path.relative(worktreePath, absPath);
  if (!rel || rel.startsWith('..')) return false;
  const segments = rel.split(path.sep);
  // `.git` inside the worktree: for a normal repo it's a dir (watch the
  // metadata, skip objects); for a linked worktree it's a pointer file
  // (harmless to watch — its parent dirs are covered by gitDirs).
  if (segments[0] === '.git') {
    return segments[1] === 'objects' || segments[1] === 'lfs';
  }
  // Exclude heavy/derived dirs anywhere in the path.
  return segments.some((seg) => SKIP_DIRS.has(seg));
}

function scheduleEmit(entry: WatchEntry): void {
  if (entry.debounceTimer) clearTimeout(entry.debounceTimer);
  entry.debounceTimer = setTimeout(() => {
    entry.debounceTimer = null;
    for (const sessionId of entry.sessionIds) {
      emit({ type: 'worktree.changed', sessionId });
    }
  }, DEBOUNCE_MS);
}

function openWatcher(worktreePath: string, sessionId: string): void {
  const gitDirs = resolveGitDirs(worktreePath);

  let watcher: FSWatcher;
  try {
    // Watch the worktree + the resolved git metadata dirs (the latter
    // matters for linked worktrees, whose index/HEAD/refs live outside).
    const targets = [worktreePath, ...gitDirs];
    watcher = chokidar.watch(targets, {
      ignored: (p: string) => {
        // A path under any gitDir uses the git-meta filter; otherwise
        // the worktree filter.
        for (const gd of gitDirs) {
          if (p === gd || p.startsWith(gd + path.sep)) return gitDirIgnored(p, gd);
        }
        return worktreeIgnored(p, worktreePath);
      },
      ignoreInitial: true,
      persistent: true,
      depth: WATCH_DEPTH,
      awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 50 },
      ignorePermissionErrors: true,
    });
  } catch (err) {
    trace('GIT_WATCH_FAILED', { worktreePath, err: String(err) });
    return;
  }

  const entry: WatchEntry = {
    watcher,
    sessionIds: new Set([sessionId]),
    worktreePath,
    gitDirs,
    debounceTimer: null,
  };

  watcher.on('all', () => scheduleEmit(entry));
  watcher.on('error', (err) => {
    trace('GIT_WATCH_ERROR', { worktreePath, err: String(err) });
  });

  watches.set(worktreePath, entry);
  trace('GIT_WATCH_START', { worktreePath, sid: sessionId, gitDirs: gitDirs.length });
}

/**
 * Start (or join) a watcher for `worktreePath` on behalf of `sessionId`.
 * Idempotent per (sessionId, worktreePath). LOCAL worktrees only — the
 * caller is responsible for not calling this for remote sessions.
 */
export function startWatch(sessionId: string, worktreePath: string): void {
  if (!worktreePath) return;
  const prev = sessionToPath.get(sessionId);
  if (prev && prev !== worktreePath) {
    // Session moved to a different worktree (rename/respawn) — drop old.
    stopWatch(sessionId);
  }
  sessionToPath.set(sessionId, worktreePath);

  const existing = watches.get(worktreePath);
  if (existing) {
    existing.sessionIds.add(sessionId);
    return;
  }

  // If a previous watcher for this path is still closing, reopen only
  // after it settles — otherwise two watchers race on the same path.
  const inFlightClose = closing.get(worktreePath);
  if (inFlightClose) {
    void inFlightClose.then(() => {
      // Re-check: the session may have gone away, or another start may
      // have already opened it, during the await.
      if (sessionToPath.get(sessionId) !== worktreePath) return;
      if (watches.has(worktreePath)) {
        watches.get(worktreePath)!.sessionIds.add(sessionId);
        return;
      }
      openWatcher(worktreePath, sessionId);
    });
    return;
  }

  openWatcher(worktreePath, sessionId);
}

/**
 * Release `sessionId`'s hold on its watcher. When the last session for a
 * worktree releases, the watcher is closed. Safe to call for unknown /
 * already-stopped sessions.
 */
export function stopWatch(sessionId: string): void {
  const worktreePath = sessionToPath.get(sessionId);
  if (!worktreePath) return;
  sessionToPath.delete(sessionId);

  const entry = watches.get(worktreePath);
  if (!entry) return;
  entry.sessionIds.delete(sessionId);
  if (entry.sessionIds.size > 0) return; // other sessions still need it

  if (entry.debounceTimer) clearTimeout(entry.debounceTimer);
  watches.delete(worktreePath);
  const closePromise = entry.watcher.close()
    .catch((err) => {
      trace('GIT_WATCH_CLOSE_ERROR', { worktreePath, err: String(err) });
    })
    .finally(() => {
      // Only clear if no newer close replaced ours.
      if (closing.get(worktreePath) === closePromise) closing.delete(worktreePath);
    });
  closing.set(worktreePath, closePromise);
  trace('GIT_WATCH_STOP', { worktreePath, sid: sessionId });
}

/** Tear down every watcher — called on app quit. */
export function stopAllWatches(): void {
  for (const [, entry] of watches) {
    if (entry.debounceTimer) clearTimeout(entry.debounceTimer);
    void entry.watcher.close().catch(() => { /* best-effort on quit */ });
  }
  watches.clear();
  sessionToPath.clear();
  closing.clear();
}
