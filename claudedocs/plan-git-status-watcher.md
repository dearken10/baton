# Plan: event-driven git status (native git + FS watcher)

**Goal:** replace the 3s polling + isomorphic-git `statusMatrix` (the cause of the
100%-CPU / 15GB GC death-spiral, see `perf-cpu-ram-investigation.md`) with the
IDE-standard approach: **native `git status` triggered by a filesystem watcher**.

## Decisions (from plan review)

- **Scope:** Both fixes — native git status (A) **and** FS watcher replacing the poll (B).
- **File tree:** the watcher drives **both** git status and the file-tree refresh
  (they share the same tick today).
- **No git:** if `git` is absent (binary missing) or the dir is not a repo →
  **silent empty status, watcher not started.** File tree still works (plain readdir).
  This mirrors how VS Code / JetBrains treat a non-git folder. Missing-binary case
  is logged to the status trace, not surfaced in UI.
- **isomorphic-git:** **removed from the status path.** `statusMatrix`, `log`
  (countAhead), and local `currentBranch` all replaced by a single
  `git status --porcelain=v2 --branch -z` (returns branch + ahead/behind + files
  at once). Reuses the **existing remote porcelain-v2 parser**.

## Architecture

### Before
```
RightColumn.tsx  setInterval(3000ms) → tick
   → GitPanel calls worktree.gitStatus  (pull, every 3s, always)
   → bus → readGitStatusLocal → isomorphic-git statusMatrix  (full JS walk, 15GB risk)
   → FilesPanel re-reads file tree on same tick
```
- No FS watcher exists. `chokidar` is in package.json but **unused**.
- No in-flight guard → overlapping 3s polls stack heaps under churn.

### After
```
session opens worktree → main starts a chokidar watcher on that worktree
   (ignores node_modules/.git/dist/... — reuse SKIP_DIRS)
   → on debounced FS change → emit AppEvent 'worktree.changed' { sessionId }
renderer (GitPanel + FilesPanel) subscribes to 'worktree.changed'
   → on event (debounced) → calls worktree.gitStatus / worktree.fileTree
   → bus → readGitStatusLocal → native `git status --porcelain=v2 --branch -z`
   → parsed by the shared porcelain-v2 parser
session closes / worktree changes → watcher torn down
```
- Idle CPU: ~0 (no timer; OS pushes events only on real change).
- Per refresh: native git, uses index stat-cache + native ignore pruning → cheap, bounded.
- In-flight coalescing on the verb prevents stacking even on rapid events.

## Changes by file

1. **`src/main/services/worktreeReader.ts`**
   - `readGitStatusLocal`: replace isomorphic-git with `fs.exec('git',
     ['status','--porcelain=v2','--branch','-z'], {cwd:dir})`. Refactor the existing
     remote porcelain-v2 parser (`readGitStatusRemote` body, lines ~304–360) into a
     shared `parsePorcelainV2(stdout)` and call it from both local + remote.
   - Branch + ahead/behind now come from the `# branch.head` / `# branch.ab` header
     lines — delete `countAhead` (git.log) and the local `currentBranch` usage.
   - No `.git` → return empty (as today). `git` ENOENT → return empty + `trace('GIT_ABSENT', …)`.
   - Remove now-dead isomorphic-git imports from the local path (keep `gitReader.ts`'s
     remote use if any; audit).

2. **`src/main/services/gitWatcher.ts`** (NEW)
   - `startWatch(sessionId, worktreePath)` / `stopWatch(sessionId)`.
   - `chokidar.watch(worktreePath, { ignored: SKIP_DIRS-derived globs, ignoreInitial:
     true, depth: <cap>, persistent: true, awaitWriteFinish: light })`.
   - Watch `.git/index`, `.git/HEAD`, `.git/refs` too (staging/commit/branch changes
     don't touch the worktree). Note: `.git` is in SKIP_DIRS for the tree walk, so the
     watcher must explicitly include those git-meta paths while excluding `.git/objects`.
   - Debounce events (~300ms) → `emit({ type:'worktree.changed', sessionId })`.
   - One watcher per live session worktree; ref-count if multiple sessions share a dir.
   - Tear down on session exit/delete (hook into sessionManager lifecycle).
   - **Local only** — remote worktrees keep an explicit refresh / lighter poll
     (SSH has no FS-watch; out of scope, leave remote as-is for now).

3. **`src/shared/ipc.ts`**
   - Add `WorktreeChangedEvent = EventEnvelope.extend({ type: z.literal('worktree.changed'),
     sessionId: SessionId })` to the `AppEvent` discriminated union.

4. **`src/main/ipc/bus.ts`**
   - `worktree.gitStatus`: add in-flight coalescing keyed by `(sessionId|worktreePath)` —
     return the in-flight promise if one is running (kills stacking).

5. **`src/main/services/sessionManager.ts`**
   - On spawn/resume of a **local** session with a worktree → `gitWatcher.startWatch`.
   - On exit/kill/delete → `gitWatcher.stopWatch`.

6. **`src/renderer/src/components/RightColumn.tsx`**
   - Remove `setInterval`/`tick`. Subscribe to `worktree.changed` (filtered to the
     selected session) via `window.baton.onEvent`, debounce, bump a refresh key.
   - Keep a manual refresh button (already exists in GitPanel) and an initial fetch on select.

7. **`src/renderer/src/components/GitPanel.tsx`** (+ FilesPanel if it reads the tick)
   - Drive off the new event-based refresh key instead of the timer tick.
   - For remote sessions (no watcher): keep a lightweight fallback refresh (manual +
     on-select; optionally a slow timer just for remote).

## Edge cases / risks

- **`.git/objects` churn:** a commit/gc writes thousands of object files. MUST exclude
  `.git/objects` from the watcher or it'll fire storms. Watch only `.git/{index,HEAD,refs}`.
- **Watcher leak:** must tear down on every session-end path (exit, kill, delete, app
  quit). Mirror how ptys are cleaned up. Ref-count shared worktrees.
- **FSEvents limits / huge trees:** `depth` cap + SKIP_DIRS ignore keep the watch set small.
- **Remote (SSH) sessions:** no local FS to watch. Keep them on an explicit/slow-poll
  refresh — don't regress remote. (Native git status already used remotely.)
- **Initial state:** `ignoreInitial:true` means first paint relies on the on-select
  fetch — keep that explicit fetch.
- **chokidar native dep:** chokidar 4 is pure-JS (fsevents optional) — no extra native
  rebuild burden. Confirm it loads under the Electron runtime.
- **Debounce both ends:** debounce in the watcher (coalesce FS bursts) AND coalesce in
  the bus verb (in-flight guard) — defense in depth against an `npm install` storm.

## Test / verification

- Unit: `parsePorcelainV2` against fixtures (modified/staged/untracked/deleted/rename/
  conflicted/ahead-behind/detached/initial) — covers both local + remote now.
- Manual: open a session, edit a file → panel updates within ~300ms with no timer;
  run a build in the worktree → CPU stays flat, no heap growth (the original repro).
- Manual: open a non-git folder → file tree works, git panel empty, no watcher started
  (verify via process/trace).
- Regression: existing 15 ipc tests still pass; typecheck clean.

## Out of scope (follow-ups)

- Remote FS watching over SSH (inotify-over-ssh) — keep explicit refresh for now.
- Gutter diff marks in the editor (separate feature).
- Removing isomorphic-git from package.json entirely (only after confirming nothing
  else imports it).
