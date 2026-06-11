# baton — "heavy / hogging" investigation (CPU + RAM)

**Date:** 2026-06-11
**Question asked:** is baton hogging RAM or CPU, and which one?
**Answer:** **Both — and it's one root cause.** baton's Electron **main process**
ran at **~100% CPU** because **98% of that CPU was V8 garbage collection** over a
**15 GB heap**. The GC couldn't reclaim enough, so it GC'd continuously — a classic
"GC death spiral." High CPU was the *symptom*; the 15 GB heap was the *cause*.

The renderer (UI, 102 MB, 0% CPU) and the spawned `claude` agents (~350 MB each,
idle) were all healthy. The problem was entirely in `src/main`.

## Evidence (measured on the live runaway process, PID 97150)

| Signal | Reading | Tool |
|---|---|---|
| Main-process CPU | ~100% (peaks 135%), pinned on the main JS thread | `ps -M`, repeated `ps` |
| Main-process memory | **15 GB** real footprint (`ps` RSS *undercounted* at ~1.6 GB — rest was compressed) | `footprint -p` |
| CPU breakdown | **98.1% in `(garbage collector)`**; app JS <2% | CDP `Profiler` over inspector :9229 |
| Allocation churn | `isomorphic-git` (`oid`, `normalizeStats`, `Inflate.push`), glob/`picomatch` (`_testOne`, `makeRegex`), recursive fs (`readdir`, `lstat`, `readFileHandle`) | CDP `HeapProfiler` sampling |
| Footprint trend | flat at 15 GB while CPU pinned → spinning over a retained heap, not actively leaking at sample time | `footprint` over 16s |

Method note: opened the Node inspector on the live process with `kill -USR1 <pid>`
(Electron/Node opens :9229), then drove `Profiler` / `HeapProfiler` via the
Chrome DevTools Protocol using Node 26's built-in `WebSocket` global.

## Root cause

`worktreeReader.ts` → `readGitStatusLocal()` called isomorphic-git's
**`statusMatrix({ fs, dir })` with no `filter`**. `statusMatrix` walks the entire
working tree and inflates blobs to diff against HEAD/index.

This is **polled every 3 s** while the Git panel is open
(`RightColumn.tsx:9 REFRESH_MS = 3000` → `GitPanel.tsx` calls `worktree.gitStatus`).
The renderer effect's `cancelled` flag only *ignores the result* — it does **not**
cancel the in-flight walk in the main process.

**Amplifier:** when a session's agent is actively writing many files into the
worktree (e.g. a build, or an `npm install` producing a transiently huge tree),
a single `statusMatrix` can take >3 s. The next poll then starts before the
previous finishes, so **multiple full tree walks pile inflated trees into the
heap simultaneously** → 15 GB → GC death-spiral.

### Honesty / scope of proof

- **Proven:** the runaway was 98% GC over a 15 GB heap, with allocation churn in
  isomorphic-git + glob + recursive fs; git status is polled every 3 s with no
  in-flight guard; the call had no `filter`.
- **Not reproduced in isolation:** a single `statusMatrix` on the *clean* repo is
  cheap (97 rows, 15 MB, ~90 ms) — filtered *or* unfiltered — because
  `node_modules` is gitignored. The blowup needs the live conditions:
  repeated overlapping polls **while a worktree is churning with many files**.
  So the fix below is correct and necessary (bounds every walk) but the exact
  live trigger sequence was inferred from the profiles + the polling code, not
  replayed end-to-end.

## Fix applied

`app/src/main/services/worktreeReader.ts` — pass a `filter` to `statusMatrix` that
prunes descent into the same heavy/derived dirs the file-tree walk already skips
(`SKIP_DIRS`: `node_modules`, `.git`, `dist`, `build`, `out`, `.next`, `.cache`,
`.turbo`, `.vite`, `coverage`, `.baton`, …). isomorphic-git 1.38.4 evaluates
`filter` during the walk and skips entering rejected directories.

Measured effect (against this repo, Node 22):
`statusMatrix` filtered → 16 MB heap; unfiltered on clean tree → 15 MB (same result
set, since node_modules is ignored). The win shows up under the live churn case,
where unfiltered walks inflate the transient build/install output and filtered ones
don't. typecheck + 15 tests still pass.

## Recommended follow-ups (not yet done)

1. **In-flight guard / coalescing** on `worktree.gitStatus` in the main process so
   overlapping 3 s polls can't stack — e.g. dedupe by `(sessionId, worktreePath)`
   and return the in-flight promise, or skip a tick if one is running. This kills
   the amplifier regardless of tree size.
2. **Back off polling** when a session is `running` (agent actively writing) — or
   debounce git status off a file-watcher instead of a fixed 3 s timer.
3. **Cap `statusMatrix`** further with the `cache` option (reuse across polls) to
   avoid re-inflating unchanged objects.
4. Consider shelling out to native `git status --porcelain` for local repos (the
   remote path already does this) — far lower memory than isomorphic-git's walk.

## Unrelated but observed during this session

- System **Node 26** vs natives built for **Electron's ABI (via Node 22)** — direct
  `better-sqlite3` load under Node 26 fails (expected; confirms the toolchain
  mismatch noted in the Node-26/pnpm upgrade handover). Not the cause of this perf
  bug, but relevant to the planned upgrade.
- `claude` backend child spawned with `--dangerously-skip-permissions` (PID 266) —
  that's baton's own backend flag, noted for awareness, not a finding here.
