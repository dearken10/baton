# code24 Architecture Review

Author: Engineering Architect
Date: 2026-06-06
Scope: feasibility of Electron + React + Zustand + Monaco + xterm.js + node-pty + isomorphic-git + simple-git + chokidar + better-sqlite3 against PRD §5/§7 for v1.

---

## 1. Executive verdict

**Feasible for the ICP (solo dev, macOS, ≤10 agents), but undifferentiated from Crystal and over-scoped for v1.** Every individual tech choice is defensible; nothing is exotic. Crystal is a near-exact precedent — we know it can be built, and we know what killed it (thin wedge, not perf).

The **biggest risk is scope-shape**. PRD v1 asks for: radar, LLM summary, panels-from-MVP, HITL semaphore, dual git stack, combined diff, inline diff comments, per-project setup script, reconnectable event stream with replay, cost visibility, and pluggable AgentBackend. That is Crystal v0.3.4 + cmux Feed + Conductor diff comments — a 12-month build, not a v1.

The **biggest technical risk** is the IPC + event bus contract. Every shipped competitor hit memory leaks on this surface (cmux #5310, Crystal `setMaxListeners(100)`). If we get the bus wrong it metastasizes.

Recommendation: ship in feasible order (§8). Defer F7.4, F7.5, F11.3, F11.4, and F10.2's external socket to v1.1. Keep the AgentBackend trait (F2.6) — almost free now, expensive later.

---

## 2. Performance budgets

| Metric | Target | Measurement | Mitigation if missed |
|---|---|---|---|
| Cold start → interactive (NF1 <3s) | 1.8s first paint / 2.5s radar / 3.0s first agent | `performance.now()` main→renderer; CI bench on M1 Air | Restore agents off critical path; show `restoring…` chips |
| Memory idle | 280 MB RSS main+renderer | `process.memoryUsage()` 60s sample | Strip unused Monaco workers; lazy-load DiffEditor |
| Memory per running agent | +45 MB (pty + 10k xterm buffer + summarizer) | Spawn N, measure delta | Hard cap scrollback at 20k; rotate to disk |
| Memory per open file (Monaco) | +8 MB (≤500 KB) / +25 MB (≤5 MB) | Heap snapshot | Reject >10 MB; "Open in VS Code" escape |
| Memory per 100-msg conversation | +12 MB | Profiler heap snapshot | Virtualize at >50 messages |
| CPU idle | <2% sustained | `top` over 5 min | No polling timers; verify on blur |
| CPU 5 agents | <25% one core; bursts 60% OK | Sum pty rates + summarizer cadence | Verify F8.6, F7.7 in live |
| CPU 10 agents (NF2) | <45% one core sustained | Same | Move summarizer to worker thread; drop cadence to 20s |
| IPC roundtrip | p50 ≤2ms control / p99 ≤15ms; pty p99 ≤30ms end-to-end | Stamp seq+ts; log delta in renderer | Batch pty frames; split pty channel from control |
| Summarizer end-to-end | p50 ≤1.5s / p99 ≤4s | Tag event w/ request ts; compare UI mount | Pre-warm Haiku connection; cache identical inputs |
| xterm 1 MB/s noisy | No frame drop >100ms; no UI stall >50ms | `yes \| head -c 1000000`; rAF deltas | F8.6 debounce; raise drop threshold under load |
| Git status on 100k-file monorepo | <400ms p50 / <1200ms p99 via isogit; <3s shellout fallback | Linux kernel as bench | F7.7 dedup; restrict watcher globs; cache shellout 5s |

NF2 reality at 10 agents: 10×45 MB + 280 MB shell + ~150 MB per Claude subprocess + GC ≈ **2.5 GB working set**. Fine on 16 GB (ICP). Document it.

---

## 3. Security boundaries

**FS access.** Renderer never touches FS. All IO via `fs.*` IPC verbs scoped to the registered project roots (F1.1). Reads/writes outside the allowlist: reject in main. Renderer: `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true` — non-negotiable.

**Network egress.** Only main makes outbound HTTPS — `api.anthropic.com`, GitHub, update server. Renderer CSP: `connect-src 'self'`. All LLM calls logged to `~/.code24/network.jsonl` with token/cost. Summarizer enforces F4.3's 5s floor + hard fuse 20 req/min/session.

**Secrets.**
- **Claude API key:** macOS Keychain via `keytar`. Injected into Claude Code subprocess env at spawn. Never reaches renderer.
- **GitHub token:** **do not handle in v1.** Use the user's existing git credential helper.
- **`setup.sh` secrets:** users will paste `.env` exports. We must (a) redact lines matching `(KEY|TOKEN|SECRET|PASSWORD)=` before writing to `~/.code24/events.jsonl`, (b) refuse to cache setup.sh content in SQLite, (c) document the risk.

**IPC permission model.** Single bus (F10.1), Zod schema per verb compiled in CI. **A compromised renderer can call any verb** — no per-origin separation. Mitigation: every privileged verb is statically dispatched, no `eval`, no path concatenation from renderer input. Renderer is the threat boundary.

**macOS hardened runtime / sandbox / notarization.** Hardened runtime + notarization on every release. Entitlements: `com.apple.security.network.client` only — **not** `app-sandbox` (it forbids spawning arbitrary children, which we require). Document why.

**Worktree containment.** An agent runs as the user with full perms. **It can `cd ..` out of the worktree.** We can't prevent this without Endpoint Security or a separate user — both out of scope. Honest mitigation: the spawn confirmation says "this agent has access to your home dir, not just the worktree." Matches Claude Code's own model.

**Threat model — malicious dependency in `setup.sh`.** `npm install` postinstall scripts run as user. This is the dominant threat. Mitigations: (1) F1.4 already streams to terminal — good, (2) first-run requires explicit "I trust this script" confirmation per project, store hash, re-prompt on change, (3) `[+ NEW]` `setup.json` field `dry_run: true` shows what would run without executing.

---

## 4. Concurrency model

**Per-session lifecycle queue (F2.3).** One `AsyncQueue` per `sessionId`, all lifecycle ops enqueue, size cap 16 → reject `EBUSY`. Kills cmux #5458's `pty_free` vs `pty_spawn` race. Implementation: `Promise` chain keyed in `Map<sessionId, Promise<void>>`.

**Per-repo git job queue (F7.7).** One queue per `repoPath` + `Map<JobKey, Promise<Result>>` dedup in front. Keys: `gitStatus:<repo>`, `gitDiff:<repo>:<worktree>`, `treeRefresh:<repo>`. Writes go through `withLock('worktree-create-...')` mirroring Crystal.

**IPC event ordering.** Single bus → FIFO within a channel. Cross-channel ordering **not** guaranteed. Every event carries `{boot_id, seq, sessionId?, ts}`. Renderer state machine must tolerate out-of-order across sessionIds, in-order within one. Document — footgun otherwise.

**HITL semaphore vs hook timeout race (F2.7 + F3.8).** Hook blocks on `request_id` ≤120s. If user approves at t=119.9s and timeout fires at t=120s: who wins? Resolution: **hook owns the timeout**, UI calls `feed.resolve`, main holds `(request_id → decision|TIMED_OUT)` map. If timer fires first, main marks TIMED_OUT and emits `{}` to agent; subsequent `feed.resolve` returns `409`. Single source of truth, no double-decision.

**FS watcher backpressure.** chokidar on 10 projects × 100k files: (a) coalesce by directory at 100ms in main, (b) emit `tree.invalidate(path)` not per-file events, (c) drop+full-refresh if rate >500/s sustained 2s. Don't pause on `blur` — F3.7 requires off-focus refresh.

**Summarizer slower than event production.** Guaranteed under load. Policy: one in-flight call per session; newer events overwrite the *pending* input; when in-flight returns, fire again if pending changed (subject to F4.3 5s floor); LRU prioritize chip-visible sessions. **Never queue more than one pending per session** — recipe for falling-behind-forever.

---

## 5. Crash recovery

**Process tree.** Electron main = root. Children: one `node-pty` per agent (which spawns Claude Code, which spawns its own children), renderer. If main dies, **all pty children die via SIGHUP** — correct, no zombie agents, but agent work is lost. Mitigation: F2.4 durably writes every prompt/response to SQLite before main acks; `claude --resume <id>` after restart recovers context. Crystal + cmux both do this.

**Session restore (cmux #4446 lesson).** On launch: read SQLite into `RestoreCandidate`, validate every field, materialize a draft in-memory tree, **then** atomically swap into the live store. Validation failure → log + "restore failed, last session preserved." Never overwrite SQLite with destroyed state. Fuzz-test against malformed rows.

**Event stream resume (F10.2).** Cursor = `(boot_id, seq)`. Main keeps last 4096 in-memory + JSONL on disk. Client reconnect sends `(boot_id, last_seq)`: if `boot_id` matches and `last_seq` is in-ring, replay forward; if `boot_id` differs (main restarted), send `RESET` + snapshot, client clears. JSONL rotates at 100 MB, keep last 2 segments.

**Worktree leak detection.** On launch, for each project: `git worktree list --porcelain` ∩ SQLite session table. Unknowns surface in an "Orphaned worktrees" UI affordance — don't auto-delete (user may have CLI-created intentional ones).

**API key rotation mid-session.** Keychain poll on `app.on('focus')` (no good event). New requests use new key; in-flight complete with old. No restart needed.

---

## 6. Build / buy per component

**Electron vs Tauri vs native.** Electron — **correct for v1.** node-pty/simple-git/chokidar/xterm.js are all native Node; Crystal is a working precedent. Tauri = Rust↔JS shim around every native dep, weeks of cost for zero v1 user benefit. Revisit at v2.

**Monaco vs CodeMirror vs build-own.** Monaco — **correct.** DiffEditor for free (F7.3, F6.1 says "same as VS Code"). CodeMirror 6 leaner but DiffEditor isn't first-class. Don't load Monaco until first file open (~60 MB workers).

**xterm.js.** Only real choice. Required addons: `addon-fit`, **`addon-webgl` (critical — without it 1 MB/s collapses)**, `addon-search`, `addon-serialize` (F2.4 scrollback). `allowProposedApi: true` + write our own OSC 9/99/777 (F8.4) — upstream support is partial.

**node-pty vs Rust pty wrapper.** node-pty — **correct for v1.** Worst part of the stack (Electron rebuild hell, historical macOS arm64 gaps) but every Electron terminal uses it. `portable-pty` via napi is the v1.1 escape hatch — researched, not built.

**isomorphic-git vs simple-git vs libgit2.** Both isogit (read) + simple-git (write) — **defensible.** isogit fast on `HEAD`/`index`/`config`, no subprocess; simple-git for infrequent writes (`worktree add`, `commit`, `push`). **`nodegit` not worth it** — install pain, abandoned, no perf win. Matches Crystal's 40% CPU claim.

**chokidar vs native FSEvents.** chokidar — **acceptable for v1.** Already uses FSEvents on macOS via `fsevents`, so delta is marginal. Pain is recursive watches: `ignoreInitial: true, depth: 3, ignored: gitignore + node_modules`. If we miss §2 budget, drop to direct `fsevents` per root.

**better-sqlite3 vs IndexedDB.** better-sqlite3 — **correct.** Main-process sync API is fine. Durable, SQL-queryable. IndexedDB would force round-trips + lose on profile wipe. WAL mode, `synchronous=NORMAL`.

**Zustand vs Redux vs Jotai.** Zustand — **correct.** Crystal precedent, small surface. **Hard rule:** subscribe via selector hooks, never `useStore()` raw — that's the cmux #5310 listener-leak class.

**Single IPC channel.** **Sound in-process, three concerns:** (1) Zod schema per verb compiled in CI or main/renderer drift, (2) high-rate `pty.data` starves control verbs — **split `pty.data` into its own channel** with ring buffer, (3) defer external Unix socket (F10.1) to v1.1 — security + maintenance burden for v0.

**Claude Code CLI vs SDK.** CLI — **correct with caveat.** Reuses user's existing auth/hooks/MCPs. SDK forces us to re-implement hook orchestration. Caveat: detect CLI version on spawn, refuse versions lacking the hook contract, show "Please update Claude Code."

---

## 7. Testing strategy

**Unit-testable.** Lifecycle queue, git job dedup map, `AgentBackend.buildHookEnv`, RestoreCandidate validator (fuzz on malformed SQLite), summarizer rate limiter (frozen clock), caller-aware notification routing, IPC Zod schemas.

**E2E. Playwright with `_electron`** (Spectron is dead). Tests: cold start → spawn → chip appears; crash main mid-session → relaunch → state restored; hook timeout → agent's native TUI takes over (no freeze); two agents on one project + two worktrees → no diff cross-contamination.

**Property tests** (fast-check). Lifecycle queue: `Op = Spawn | Pause | Resume | Kill | Restart`, sequences 1–20; assert `kill` always reaches terminal, no two `spawn`s race, state == `reduce(initialState, ops)`.

**Snapshot tests for IPC contract.** Every verb's request/response Zod → JSON snapshot in `tests/snapshots/ipc/`. CI fails on diff without explicit ack. **Single most important test we have** — the contract between main, renderer, and future external tooling.

**Agent backends without burning tokens.** `MockAgentBackend` replays JSONL transcripts; all E2E + integration use it. `RecordingAgentBackend` captures real sessions to JSONL for fixtures. Summarizer mock returns canned strings. **Zero CI tests hit the real Anthropic API.**

---

## 8. v0 milestone proposal

Smallest thing that proves radar+summary: a top bar of chips, each = a Claude Code session in a worktree showing live hook-driven status + LLM summary, single terminal pane below for the focused chip.

**Ships in v0:** F1.1, F1.3; F2.1, F2.3 (no pause), F2.4 (non-negotiable), F2.6 (trait, Claude-only); F3.1–F3.4; F4.1–F4.4; F8.1–F8.3, F8.5, F8.6; F10.1 internal only; F10.3.

**Stubbed:** F1.4 setup script (manual `npm install`); F2.2 worktrees (project-root first, worktrees week 3); F2.5 panels (single terminal — **but model the data structure** so upgrade is mechanical); F2.7+F3.8 (week 3); F5.x (week 4); F6.x Monaco (week 4, flag-gated); F7.x git (read-only week 4, diff post-v0); F9.x (week 3); F11.x (per-chip week 4 only).

**Killed for v0:** F7.4 inline diff comments; F7.5 combined diff; F10.2 external consumers; F11.3, F11.4 rollups/caps.

**Week-by-week:**

- **W1.** Electron + React + Zustand skeleton. IPC bus + Zod schemas. SQLite + migrations. node-pty + xterm + adaptive debounce. Goal: type, see output, scrollback persists.
- **W2.** AgentBackend + ClaudeCodeBackend. Hooks (`SessionStart`, `Stop`, `Notification`) drive status. Chip w/ status + Haiku summary. **First demoable:** "I started Claude, closed the app, reopened, still there."
- **W3.** Worktree-per-agent + LLM-named worktrees. Per-session lifecycle queue. HITL semaphore w/ fail-open. Main-process notifications + dock badge. **Second demoable:** "Three agents on three branches, notifications fire."
- **W4.** File tree. Monaco single-file open. isogit read path. Per-chip cost. Crash-recovery pass. **v0 ship.**

Aggressive but mirrors Crystal's actual pace.

---

## 9. Architectural risks ranked

1. **IPC bus design ossifies before we know the right shape.** Blast radius: every component; refactors global. Mitigation: ship bus + Zod schemas in week 1, **only extend, never restructure** until v1. Decide by **end of week 1**.

2. **Summarizer cost overruns NF3 ($0.05/hr/agent).** At Haiku 4.5 (~$1/Mtok in, $5/Mtok out), 500 tok in / 50 tok out / call, every 5s = 720 calls/hr = **$0.54/hr/agent — 10× over NF3.** Mitigation: default cadence 30s + hook-driven (F4.2), input ≤20 lines, cache identical inputs, ship a "low-budget mode." Decide by **week 2** before users see costs.

3. **Hook contract drift between Claude Code versions.** Anthropic owns it, changes it. Blast radius: status fails silently → radar lies. Mitigation: pin minimum CLI version, version-detect on spawn, nightly integration test against pinned. Decide by **week 2**.

4. **node-pty + Electron upgrade hell.** Every Electron major requires native rebuild; macOS arm64 has had gaps. Blast radius: can't ship updates. Mitigation: pin Electron + `electron-rebuild` combo; `portable-pty` napi escape hatch researched (not built) by v0. Decide by **week 4**.

5. **`setup.sh` running malicious user code.** Blast radius: user machine compromised, our app blamed. Mitigation: first-run confirmation w/ stored hash, log-redact, `[+ NEW]` `dry_run` mode, documented threat model. Decide by **week 3** before F1.4 ships.

---

## 10. Open architectural questions

1. **External Unix socket in v1 or v1.1?** PRD F10.1 says v1; recommend v1.1. Keep verbs socket-compatible regardless.
2. **Worktree-per-agent vs per-branch (PRD §9).** Recommend per-agent. Lock before week 3.
3. **Two agents on the same file in different worktrees** — separate FS copies, no conflict. Editor scopes to one session's worktree; opening from another opens a different tab with worktree path in title.
4. **Persist xterm scrollback across restarts?** Recommend structured log → SQLite; raw scrollback → per-session file capped 5 MB, replayed on focus.
5. **CRDT-collaborative editor with the agent (PRD §9)?** No, v2 at earliest. v1 answer: agent edits disk → chokidar invalidates → VS Code-style "file changed" prompt.
6. **Command palette Cmd+K (PRD §9)?** v1.1, not v0. Cheap later, expensive to retrofit shortcuts.
7. **`[+ NEW]` `setup.sh` "danger zone."** First-run shows script, explicit trust, hash stored, re-prompt on change. Not in PRD; should be — only realistic §3 mitigation.
8. **`[+ NEW]` Daily aggregate budget circuit breaker.** F11.4 is per-session. Also need a daily cap across all agents — runaway = pause-all, not pause-one. Lock before F11.x lands.
9. **`[+ NEW]` "Demo mode" with `MockAgentBackend`.** First-launch scripted mock — radar/summary/HITL without Claude credentials. Drops time-to-wow from minutes to seconds. Commit now so we don't bake real-Claude assumptions into the renderer.
10. **Kill F10.2 external `events.stream` for v1?** Complexity (auth, schema versioning) for consumers we don't have until the mobile companion (parked). Defer to v1.1 unless an external consumer joins the v1 roadmap.
