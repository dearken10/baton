# PM Additions — baton PRD v2

## Contents
1. Detailed use cases
2. User stories (Given/When/Then) for under-specified F-requirements
3. Acceptance criteria per F-section
4. Edge cases by F-section
5. Scope cuts
6. New proposals

---

## 1. Detailed use cases

### UC-1. The 9:47am triage (four-agent morning)
Solo founder. Last night: three agents on `web-app` (auth, billing, e2e flake) + one on `llm-docker` (TTS retry). Opens laptop at a cafe; baton restores (F2.4, NF4). Cold start <3s. Radar: 2 amber, 1 green, 1 blue, 1 red. `Cmd+Shift+U` → oldest amber (`billing-webhooks` asking `Allow curl to stripe.com?`); approve HITL (F3.8). Second amber wants to edit `package.json`; read summary (F3.3), open diff (F7.3), deny with inline comment "use existing zod" (F7.4). Green = e2e flake → combined diff (F7.5), commit (F7.6). Red = TTS retry errored on `pnpm install`; fix `setup.json` (F1.4), Restart (F2.3). ~4 min. **Without baton:** four VS Code windows, alt-tab, miss the errored one; at noon discover 2.5hrs of useless token burn.

### UC-2. On-call interrupt
Mid-prompt in `infra · main` ("wire up Datadog APM"). PagerDuty fires. Right-click `infra` → New agent → branch `hotfix/5xx`, prompt "tail prod logs, find 5xx, do not deploy" (F5.3). Worktree LLM-named `prod-5xx-investigation` (F2.2). Setup script runs <8s, streamed (F1.4). Original agent untouched on its worktree (F2.5, F7.2 `withLock`). After 90s, summary: "Found 5xx from `worker-3` OOM". Kills the APM agent (F2.3). **Without baton:** juggle two VS Code windows on the same repo (stash to wrong branch) or pause the original work.

### UC-3. Code review on an overnight PR
Yesterday: agent prompted "implement passkeys for /login". Morning: chip green, "11 files, awaiting review." Click chip → Conversation (F6.4) + editor. Combined diff (F7.5). On `webauthn.ts:88` agent invented `parseAttestation`; select lines, inline-comment "use `decodeAttestation` in lib/webauthn-utils" (F7.4) — structured, not prose. Agent resumes, summary "Replacing inline parseAttestation with lib helper". Spend $2.40 / $6.12 daily (F11.2). Commits (F7.6). **Without baton:** VS Code, checkout worktree, paste prose comments into terminal and hope the agent maps to the right line.

### UC-4. Exploration spike (parallel hypotheses)
Bun vs. tuned-Node for the queue layer. New agent `spike/bun-rewrite`, "port worker.ts to Bun, keep API". Immediately another `spike/node-perf`, "tune Node worker for 2x". Two chips, same project, both blue. After lunch: Bun chip amber ("Allow editing package.json to add bun runtime?") → deny. Node chip green, +180 -42, benchmarks in conversation. Keeps Node. **Without baton:** sequential runs, or two clones in two VS Code windows with worktree confusion.

### UC-5. Long-tail flake debugging
Two-week-old CI flake. New agent: "Reproduce `checkout.spec.ts` flake, fix it. 4 hours, $5 budget." Soft cap (F11.4). Summary: "Reproduced 3/47". User works elsewhere. 3hrs later chip amber: "Suspect race in cart-state. Add `waitFor` or fix `useCart`?" Picks "fix the race". 20 min later: green. 1-line fix + test. $1.87 of $5. **Without baton:** watch terminal 3 hours, or find at EOD that the agent stalled on a permission prompt at hour 1.

### UC-6. Forced restart recovery
Three agents running. macOS forces a 2am restart. App relaunches; restore reads `~/.baton/events.jsonl` + hook session map (F2.4 temp-then-commit). Resumable agents become "paused — resume?" (not auto). Non-resumable show "session lost — last summary: …" with `Re-spawn with last prompt`. Worktrees on disk; new agents attach. No git state lost. **Without baton:** three terminal tabs `[Process completed]`, no record of what each was doing.

### UC-7. "Where are we on billing?" mid-standup
In Zoom standup. Earlier: `web-app · feat/billing-overhaul`. Dock badge `0`. Cmd+Tab to baton. Summary: "Migrating Stripe webhook handlers, 6 of 11, no errors". Elapsed `00:22:11`, spend `$1.43`. Answers "two-thirds through Stripe, no blockers". **Without baton:** alt-tab, scroll terminal, lose 30s of meeting.

---

## 2. User stories (Given/When/Then) for under-specified F-requirements

### F1.4 — Per-project setup script
- **US-1.4a.** Given a new worktree + `setup.sh`, when the agent is about to spawn, then the script runs with stdout/stderr streamed into the agent's terminal; spawn gated on exit code 0.
- **US-1.4b.** Given a non-zero exit, then the session is `errored` with summary "setup failed: <last 80 chars stderr>" + Retry action; agent does not spawn.
- **US-1.4c.** Given `setup.json` `copyFiles: [".env", ".env.local"]`, then files are hardlinked (copied cross-device) before `runCommands`; missing files → warning row, not failure.

### F2.5 — Panels per session
- **US-2.5a.** Agent panel exists, user opens a file: an `editor` panel is added and persisted; restart reopens.
- **US-2.5b.** Multiple `agent` panels (Claude + Codex), one changes status: only that panel updates; chip badge is worst-status-wins.
- **US-2.5c.** `diff` panel + worktree change on disk: re-renders ≤500ms without losing scroll or pending inline comments.

### F3.8 — HITL semaphore
- **US-3.8a.** Given PreToolUse + Approve within 120s, then the hook unblocks with `{"decision":"allow"}` and `workstream.jsonl` records `{request_id, sessionId, decision, latency_ms, user_action_ts}`.
- **US-3.8b.** Given HITL pending ≥120s, then the hook gets `{}`, the agent's native prompt takes over, chip → `running`, log `decision:"timeout"`.
- **US-3.8c.** Given app crash while HITL open, when the app restarts, then the hook has timed out within 120s (no zombie semaphore); log `decision:"timeout_app_crash"`.

### F6.4 — Conversation always visible
- **US-6.4a.** Tabbed mode + file tab focus, agent sends a message: pinned Conversation badge increments and flashes ≤200ms; clears on focus.
- **US-6.4b.** Split mode, handle drags conversation <120px: snaps to collapsed strip (composer + latest agent line) with "↑ expand".
- **US-6.4c.** User composing, switches file tabs: composer text preserved.

### F7.4 — Inline diff comments
- **US-7.4a.** Lines 42–47 of `auth.ts` selected, user submits comment: agent receives `<review-comment file="src/auth.ts" line="42-47" hunk="...">…</review-comment>`; chip → `running`.
- **US-7.4b.** Multiple unsent comments, "Send all (3)" clicked: ship as one agent turn with per-comment file/line metadata preserved.
- **US-7.4c.** Unsent comment on since-changed hunk: line anchor rebases if possible; if hunk is gone, mark `stale` with "still send?" action.

### F10.x — Event stream
- **US-10.2a.** Consumer reconnects within 4096-event replay with last `seq`: receives missed events in order before live resume.
- **US-10.2b.** Reconnect with `seq` older than window: server emits `{type:"replay_overflow", from_seq, to_seq}`; consumer reloads from `~/.baton/events.jsonl`.
- **US-10.2c.** Consumer reconnects with stale `boot_id`: receives `{type:"boot_changed"}`, resyncs from `seq=0`.
- **US-10.3a.** 1000 events fire in one tick on a single UI subscription: renderer batches into one Zustand update ≤16ms.

### F11.x — Cost visibility
- **US-11.1a.** Token-usage hook fires: chip `$X.XX` updates ≤1s; daily footer updates atomically.
- **US-11.4a.** Session cap $2.00 crossed: next PreToolUse held by HITL with "Spend cap $2.00 reached, continue? [+$1, +$5, no cap]"; decline → `paused`.
- **US-11.4b.** Daily aggregate over user cap: New Agent dialog blocks "Daily cap reached: $X of $Y. Spawn anyway?" requiring explicit confirm.

---

## 3. Acceptance criteria per F-section

### Project management (F1.x)
- Add persists (stable sort). Remove preserves files; worktrees cleaned only on user confirm. F1.4 setup: <60s normal, >60s "still running", >10min hard-killed. `setup.json` validated on add; invalid JSON path shown inline.

### Agent session (F2.x)
- Concurrent spawns succeed without lock contention (F7.2 `withLock`). F2.2 falls back to `wt-<short-uuid>` on Haiku failure or >30 chars.
- F2.3 ops serialized per session: rapid `pause; resume; pause; kill` execute in order; no orphan pty. F2.4 restore observable via `tfa restore --dry-run`. F2.6 a no-op `AgentBackend` runs chip lifecycle without Claude Code installed. F2.7 every hook returns ≤250ms, preserves `$?`; hung IPC → timeout + fail-open.

### Status surfacing (F3.1–F3.7)
- Status enum exhaustive in renderer `match`. F3.3 chip renders project, branch, badge, single-line summary, time-in-status (mm:ss), spend (`$0.00`). F3.4 deep link `tfa://session/<uuid>` survives relaunch. F3.5 notification from main process (architectural lint); click focuses app + correct chip. F3.6 nested subprocess (`sh -c "sh -c '<hook>'"`) routes to correct session. F3.7 sidebar metadata updates while a *different* project is focused.

### HITL (F3.8, F3.9)
- Card visible ≤500ms after hook. Approve/deny round-trip ≤200ms on local IPC. Timeout at 120s ±2s. Every decision (approve/deny/timeout/crash) → one append-only line in `workstream.jsonl`; never partial under concurrent writes.

### Summarizer (F4.x)
- Cadence ≤1/5s and ≥1/10s active. Summary ≤120 chars, single line, no markdown. No LLM call if no new pty data and no new hook event. Model swap = one config line.

### Project view (F5.x)
- Lazy expansion: 50k-file dir doesn't block UI >200ms. `.gitignore` respected per dir with override toggle. F5.4 ripgrep first results <300ms on 100k LOC. "New agent on this folder" pre-fills the dialog.

### Editor / viewer (F6.x)
- Monaco ≤1.5s first open; instant after. F6.2 viewers content-sniff. F6.3 layout persisted per project. F6.4 Conversation always in DOM; toggle preserves scroll/composer. F6.5 preview vs sticky behaves: single-click `a`, single-click `b` → only `b`; double-click `b`, single-click `c` → both. F6.6 opens *current file*, not project root.

### Git (F7.x)
- F7.1 read-only path makes 0 `git` subprocess calls in steady state. F7.2 concurrent spawns yield N distinct worktrees, no errors. F7.3 diff renders ≤500ms on 200-file changeset. F7.4 payload schema snapshot-tested. F7.5 combined-diff TOC jump <100ms. F7.6 commit refuses with nothing staged or empty message. F7.7 100 `gitStatus:repoA` calls in one tick → 1 actual read.

### Terminal (F8.x)
- 10k scrollback. OSC 9/99/777 each fire policy evaluation. F8.5 zero direct writes from `node-pty.onData` to xterm (architectural lint). F8.6 100MB/10s burst doesn't freeze renderer; dropped frames shown as "+N lines dropped" banner.

### Notifications (F9.x)
- F9.1 main process only (architectural lint). F9.2 dock badge = count of `needs-input` + `errored`. F9.4 sound per status; `done` muted by default. F9.5 `Effects` introspectable; muting desktop still records in-app.

### IPC / event stream (F10.x)
- Single IPC channel (architectural lint). `events.stream` survives sleep/wake. Replay memory bounded. JSONL rotates at 50MB; old logs gzipped.

### Cost (F11.x)
- Per-session spend updates on chip ≤1s after token-usage hook. Title bar = atomic sum of running session spends. Daily rollup persists. Cap authoritative on our side even if Claude's accounting diverges.

---

## 4. Edge cases by F-section

### Project management
- Symlinked dup: dedupe via `fs.realpath`. Folder deleted on disk: red "project missing"; tree expand doesn't crash. Setup needs `SSH_AUTH_SOCK`: declare required vars in `setup.json`; warn at add. Binary stdout: lossy UTF-8 decode. Disk full mid-worktree create: F7.2 tolerant remove cleans partial.

### Agent session
- Crash mid-tool-call (PreToolUse without PostToolUse/Stop): watchdog on pty exit → errored, notification, pending HITL → timeout. SIGSTOP mid-stream: buffer keeps receiving; no resume corruption. Same project in two baton windows: `~/.baton/lock`; second window read-only. Two agents same branch: `withLock` serializes; second offered fresh branch. Restart with pending HITL: card cancels (`session_restart`); no zombie hook.

### Status surfacing
- Status flap (10×/s PreToolUse): display ≥300ms hysteresis. Summary LLM fails 5× in row: pause 60s, fall back to last hook verb. Time-in-status across midnight: keeps counting.

### HITL
- Approve+Deny rapid: first wins; second no-op + toast. Revoke permission mid-stream: prior calls not undone; new calls re-prompt. Agent dies while card open: auto-dismiss; audit `agent_died`. 50 pending: queue sortable by latency.

### Summarizer
- 100MB/10s: reads last 50 lines of ring buffer. Haiku >10s: skip tick. Offline: "summary offline" indicator, no error spam.

### Project view
- Symlink cycles: inode-track, stop at depth N. `.gitignore` edited at runtime: re-apply ≤500ms.

### Editor / viewer
- File deleted by agent: "deleted on disk — keep/discard". Concurrent user+agent edit: 3-way merge modal. No VS Code installed: F6.6 grayed with tooltip. Multi-MB paste: cap 1MB with warning.

### Git
- Signing passphrase: detect on first commit, route to keychain, never hang. Shallow clone: prompt "convert to full?". 10k+ untracked (`node_modules` accident): cap entries; chip "+10k files (truncated)". Sibling worktree commit race: F7.2 lock serializes.

### Terminal
- pty restart mid-render: F2.3 queue serializes; grid cleared, reattached, no double-mount. Cmd+Q during pty restart: hook session map sufficient to resume. Scrollback overflow while user scrolled up: trim oldest, don't jump to bottom.

### Notifications
- macOS permission denied: in-app list + badge still work; one-time banner explains. 20 notifications in 5s: coalesce into "5 need input, 3 done".

### IPC / event stream
- Stale `boot_id`: `boot_changed`, must resync. Replay log corrupted by kill -9: skip truncated trailing line; never throw. Slow consumer >1024 behind: dropped, forced reconnect.

### Cost
- Token-usage hook never fires (older Claude): spend $0; chip warning "spend unknown — update Claude Code". Multiple agents on same API key: aggregate accurate as long as we sum from hooks. Cap reached mid-tool-call: gate the *next* PreToolUse, don't kill in flight. System clock change: rollup keys on local-TZ wall date; manual override.

---

## 5. Scope cuts

### Cut 1. Drop F5.4 ripgrep search.
Wedge is supervision, not navigation. Users have ripgrep in the shell. A results pane is its own feature. Cmd+K palette handles file-name jump; defer full-text until we see users editing *in* baton rather than escaping to VS Code.

### Cut 2. Drop F11.4 per-session soft cap; keep F11.1–F11.3.
Visibility (chip + title bar + daily rollup) is the high-leverage piece. A cap adds a second HITL surface that interacts non-obviously with F3.8. Add once we see real spend patterns.

### Cut 3. Drop F6.2 PDF and CSV viewers; keep Markdown, images, JSON.
PDF needs PDF.js; CSV needs pagination/sort/filter to be useful. Agents rarely produce either. Ship Markdown + images + JSON + raw-text + `Open in default app`.

### Cut 4. Don't implement a second `AgentBackend` in v1 — trait only.
PRD pushes Codex to v2; be stricter. Keep the trait (TS interface), don't write or test a Codex backend, not even a stub. Keeps radar/hooks/lifecycle opinionated.

### Cut 5. Drop tabbed layout (F6.3 tabbed); ship split only.
Two layouts double the test matrix for F6.4, F6.5, and resizing. Split is the opinionated default — conversation is structural. Target macOS 1440×900+. Add tabbed in v1.1 if small-laptop users complain.

---

## 6. New proposals

- **[+ NEW] Agent inbox.** Left-rail (Cmd+Shift+I) list of every chip in `needs-input` or `errored`, sorted by age. Makes the queue *visible* even when radar is scrolled.
- **[+ NEW] Per-agent intent label.** User-editable persistent label on the chip ("Stripe migration"). Worktree name is for git; label is for humans.
- **[+ NEW] Idle-timeout auto-pause.** If `idle` (no pty, no hooks) >N min (default 30), auto → `paused`, optionally SIGSTOP. Stops silent token burn.
- **[+ NEW] "Why did the chip change?" log.** Right-click → "Show transitions" → modal of every state change + timestamp + trigger. Trust-building.
- **[+ NEW] Deny-with-reason.** HITL card: Approve / Deny / **Deny with reason** → structured `<denial reason="...">`. Saves the deny-then-explain round-trip (UC-1, UC-3).
- **[+ NEW] Snapshot before destructive approval.** On approve of `rm -rf`, `git reset --hard`, etc., take a `git stash create` ref first. One-click "undo" on chip for ≤10 min.
- **[+ NEW] Worktree disk-usage indicator.** Per-project header shows total of `~/.baton/worktrees/<project>`. Action: clean up worktrees `done` >7 days.
- **[+ NEW] Settings split: per-project vs global.** Setup scripts, caps, summarizer cadence = per-project. Notifications, theme, model = global. Make explicit in UI.
- **[+ NEW] HITL keyboard row.** On focused HITL card: `A` approve, `D` deny, `R` reason-deny, `Esc` defer. Power flow for the four-agent morning triage.
