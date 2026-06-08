# PRD: baton

**Version:** v2.1 · 2026-06-06 · post-Reviewer-pass.

A multi-project, multi-agent coding workspace that lets one developer
supervise many AI coding sessions at once without alt-tabbing.

**Codename:** baton (24-hour coding — the agents work, you supervise).
**Category:** parallel-agent supervisor.
**Platform:** macOS, Electron. v1 macOS-only; cross-platform v2.

**If you're starting to build Monday morning,** jump straight to:
§13 (v0 4-week plan) → §11 (architecture) → §5 (F-requirements) →
§7 (acceptance criteria). Glossary at the bottom (Appendix B).

**What changed in v2:** dropped tabbed layout (split-only); hybrid
intent line (tool name + LLM summary) gated on Week-3 dogfood; ICP
broadened so single-project users aren't penalized; Nimbalyst-style
5h/7d Claude-plan-usage indicator replaces daily-cost rollup; daily
aggregate budget circuit breaker added; per-session cost cap deferred
to v1.1; F5.4 ripgrep cut; PDF viewer cut; renamed `24code` →
`baton`, `~/.tfa/` → `~/.baton/`.

**Primary ICP:** senior or staff engineers and indie technical founders
(6–15 YoE) who work on multiple projects simultaneously, run **4+ Claude
Code agents in parallel**, juggle multiple VS Code windows and terminal
tabs, need ambient progress updates on long-running AI agent tasks, and
waste meaningful time context-switching and polling sessions to see "is
it done yet?".

**Secondary user:** the same developer working on **one project with
many parallel branches** (the bulk of HN parallel-agent power users).
The IA must not penalize them — multi-project is the headline wedge but
single-project-multi-agent is not a second-class citizen.

---

## 1. Problem

I run several Claude Code sessions in parallel — different projects,
sometimes multiple agents on the same project on different branches.
Today each session lives in its own VS Code window. To know whether any
one of them is running / stuck / done I have to physically visit it. I
lose track of which window is doing what, and permission prompts sit
unanswered.

Existing tools each solve part of this:

- **cmux** — great agent radar (status, notification ring), but
  terminal-only. No file tree, diff view, or git UI; sends you back to
  VS Code to review diffs.
- **Conductor / Nimbalyst** — workspace + diff + git, but each agent is
  siloed in its own workspace and there is no single global status strip
  across *projects*.
- **VS Code per project** — gives editor + git + files, but no
  cross-window agent dashboard at all.

None give me **all of**: cross-project radar, per-agent intent line,
in-app file tree + editor + diffs + git, and parallel agents on one
project on different branches.

## 2. Goals

- **G1.** One window shows every active agent across every project.
- **G2.** Status of each agent (`running` / `needs-input` / `done` /
  `errored` / `idle` / `paused`) is visible at the top without clicking
  into the session.
- **G3.** Each chip carries a **hybrid intent line**: the current tool
  name from the last `PreToolUse` hook *plus* an LLM-generated short
  summary of intent. The summary line is a v1 **hypothesis gated on a
  Week-3 dogfood**; the tool-name line is the always-accurate fallback.
- **G4.** Multiple agents can run on the same project on different git
  branches concurrently, without conflicting (worktree-per-agent).
- **G5.** Built-in folder browser + file editor + viewers for common
  file types, so I can intervene or review without leaving the app.
- **G6.** Live diff view of each agent's uncommitted changes (Monaco
  `DiffEditor`; multi-file combined-diff is v1.1).

## 3. Non-goals (v1)

- Full IDE feature parity with VS Code (no language server, debugger,
  or extension ecosystem).
- Multi-user / shared sessions.
- Gemini / OpenCode / other agents beyond Claude Code + Codex (the
  `AgentBackend` trait is open for them in v2).
- Remote / SSH workspaces.
- Windows / Linux.
- A second middle-pane layout (we ship **split only**; tabbed v1.1).
- Cloud sync, mobile companion, team / enterprise SKU, PR review UI.

## 4. Users & primary flow

**Primary user persona** (fleshed out from PMM positioning):

- Senior/staff engineer or indie technical founder.
- 6–15 YoE; pays for Claude Pro/Max + Cursor/Windsurf; total AI spend
  $50–500/mo.
- Daily workflow opens 4–6 VS Code windows; spawns Claude Code in each.
- Hangs out on r/ClaudeAI, Claude Developers Discord, HN, Twitter
  (@swyx, @karpathy, @theo, @levelsio, @t3dotgg, @simonw).
- Quote: "*I need a damn dashboard.*"

**Primary flow:**

1. Launch the app. Cold start < 3 s.
2. App restores last session: N projects loaded, M agents running.
3. Top **Agent Radar** shows every agent as a chip:
   `project · branch · status badge · tool-name · LLM summary · spend`.
4. A chip turns amber → that agent needs input. Click it → middle pane
   surfaces the **HITL approval card** with `Approve / Deny / Reason`.
   Hotkeys `A` / `D` / `R` / `Esc`.
5. While that agent runs, I click another chip → editor + diff for that
   project surfaces in the middle pane (editor on top, conversation
   below). Review the diff inline.
6. I right-click a project in the left pane → "**New agent on branch…**"
   → spawn a second Claude Code session on a new worktree branch. The
   worktree gets an LLM-generated intent name (`tts-retry-fix`).

---

## 5. Functional requirements

> Each F-requirement carries a one-line citation when it originates from
> the prior-art research (cmux / Conductor / Crystal / Zed). When you
> see *(Source: X)*, the file paths and rationale are in `prior-art.md`.

### Project management

- **F1.1** Add project = pick a folder on disk. Persisted across launches.
- **F1.2** Remove project (keeps the folder, just drops it from the
  workspace).
- **F1.3** Project shows: name, root path, current main branch, list of
  agents attached, **worktree disk-usage indicator** (sum of
  `~/.baton/worktrees/<project>` with "Clean up worktrees done > 7 days"
  action).
- **F1.4** **Per-project setup script** (`setup.sh` or `setup.json` with
  `copyFiles` + `runCommands`), runs after `git worktree add` and before
  the agent spawns. Solves the worktree-doesn't-carry-`node_modules`-`.env`
  gap. Output streamed to the agent's terminal so the user sees what
  happened. **Precedence: `setup.json` wins if both exist;
  `setup.json.runCommands` may explicitly invoke `setup.sh`** (or any
  other script) as one of its commands. Missing-file copies → warning
  row, not failure. *(Source: Conductor — most consistently raised
  pain.)*
- **F1.5** **Setup script trust + hash.** First-run `setup.sh` requires
  explicit "I trust this script" confirmation per project. The script's
  SHA256 is stored in SQLite; any change to the file re-prompts.
  *(Threat model: malicious dependency `postinstall` running as the
  user; cannot be sandboxed without macOS Endpoint Security.)*
- **F1.6** **`setup.json --dry-run`** mode: shows what would copy/run
  without executing. Surfaced as a "Preview setup" button in the
  add-project flow and the new-agent dialog.

### Agent session management

- **F2.1** Spawn a Claude Code session attached to a project. Choose:
  branch (existing or new), working directory (project root or
  worktree). **Spawn confirmation says, plainly: *"This agent runs as
  you with full access to your home directory, not just the
  worktree."*** *(Honest disclosure — we cannot sandbox without
  Endpoint Security; matches Claude Code's own model.)*
- **F2.2** Multiple sessions per project allowed. **Worktree-per-agent**
  is the default (not worktree-per-branch). Worktree names are
  **LLM-generated** from the session prompt (2–4 words, ≤30 chars,
  deterministic fallback to `wt-<short-uuid>`), so the radar shows
  intent-named slots like `tts-retry-fix` rather than `wt-a`.
  Onboarding has an opt-out for users who prefer one-checkout-many-agents
  (Steinberger-style). *(Source: Crystal `worktreeNameGenerator.ts`.)*
- **F2.3** Session lifecycle: start, pause (SIGSTOP), resume, kill,
  restart. Lifecycle ops are **serialized through a per-session queue**
  to avoid pty/worktree races. *(Source: cmux #5458.)*
- **F2.4** Session persists prompt log + last-known summary across
  app restarts. **Restore writes to a temp model first; commits only
  after validation success.** Restore must never destroy current
  state. *(Source: cmux #4446 / #4982 / #4859.)*
- **F2.5** **A session has many panels** (first-class). A panel is one
  of: `agent` (Claude Code, Codex, etc.), `editor` (one open file),
  `diff`, `terminal`. Multiple agents can share a worktree.
  *(Source: Crystal v0.3.4 — they had to refactor session=agent into
  this shape later; we model it from MVP.)*
- **F2.6** **Pluggable agent backend.** `AgentBackend` TS interface.
  v1 ships **two real backends + a test backend**:
  - `ClaudeCodeBackend` — primary.
  - `CodexBackend` — first-class v1 alternative; required because
    onboarding (F13.3) accepts either Claude or Codex.
  - `MockAgentBackend` — Demo mode (F2.8) and tests.
  Each backend declares its own lifecycle signal mapping
  (Stop / Notification / PreToolUse equivalents) — do **not** assume
  Claude Code's signals work for Codex. New-agent dialog has a
  backend picker; default is the first one detected as installed.
  *(Source: cmux #5501 — Gemini never emits `Stop`. Gemini /
  OpenCode / other backends are v2.)*
- **F2.7** **Hooks must fail-open.** Every agent hook we install (for
  status, notifications, HITL approvals) preserves `$?`, returns within
  a bounded time, and falls back to the agent's own behavior on
  timeout/error. Never freeze the agent. *(Source: cmux #5389 broke
  Starship; #4768 blocked Antigravity tools.)*
- **F2.8** **Demo mode.** First launch shows a "Try the demo" button
  that spawns a `MockAgentBackend` with a scripted transcript.
  Exercises radar + summary + HITL without requiring Claude credentials.
  Drops time-to-wow.

### Status surfacing (the "radar")

- **F3.1** Each session has a derived status from this enum:
  `running`, `needs-input`, `idle`, `done`, `errored`, `paused`,
  `disconnected` (Remote SSH only — see F14.8).
- **F3.2** Status comes **primarily from Claude Code hooks**
  (`SessionStart`, `PreToolUse`, `Notification`, `Stop`, `SessionEnd`)
  via our IPC channel. pty heuristics are a fallback for hookless
  agents only. *(Source: cmux's hook-based approach is more reliable
  than tailing output.)*
- **F3.3** Status chip shows: project name, branch, status badge
  (color + icon + glyph for color-blind users), **hybrid intent line**
  (tool name from `PreToolUse` on top, LLM summary line below — see
  F4), time-in-current-status, **accumulated token spend**, and (if
  configured) **Claude plan 5h-window usage %**.
- **F3.4** Clicking a chip focuses that session in the main area. Chips
  are addressable by **stable UUID**, not by index — deep links survive
  relaunch (`baton://session/<uuid>`). *(Source: cmux #5486.)*
- **F3.5** Native macOS notification (from the **main process**, not
  the renderer) fires on transitions to `needs-input`, `done`,
  `errored`. Dock badge count tracks unread. Notification click →
  focuses the chip. *(Source: Crystal pitfall — renderer Web
  Notification API loses focus/badge affordances.)*
- **F3.6** **Caller-aware routing:** every hook invocation passes
  `{sessionId, pid, ppid, tty}` so the notification surfaces in the
  right session card even when fired from a nested subprocess.
  *(Source: cmux `TerminalNotificationCallerResolver`.)*
- **F3.7** Sidebar metadata (status, summary, ports, git branch)
  refreshes regardless of which workspace is focused. *(Source: cmux
  TODO P0 — gating on focus made the Claude loading indicator go
  stale.)*
- **F3.8** **Agent inbox** (Cmd+Shift+I) — left-rail list of every
  chip in `needs-input` or `errored`, sorted by age. Makes the queue
  visible even when radar is scrolled.
- **F3.9** **Per-agent intent label** — user-editable persistent label
  ("Stripe migration"). Worktree name is for git; label is for humans.
- **F3.10** **Transitions log** ("Why did the chip change?") —
  right-click → modal with every state change + timestamp + trigger.
  Trust-building for the hybrid intent line.

### Human-in-the-loop approvals (HITL)

- **F3.11** When an agent hooks for permission (e.g. `PreToolUse` with
  a destructive command), the hook **blocks on a `request_id` semaphore**
  for ≤120 s. Our UI surfaces a card in the Conversation panel; user
  approve/deny wakes the hook via IPC. **On timeout the hook emits an
  empty response so the agent's native prompt takes over** — never
  freeze. *(Source: cmux Feed pattern.)*
- **F3.12** HITL card has **Approve / Deny / Deny-with-reason**. The
  reason variant ships a structured `<denial reason="…">` to the agent —
  saves the deny-then-explain round-trip.
- **F3.13** **HITL keyboard row.** Focused card responds to `A` (approve),
  `D` (deny), `R` (deny-with-reason), `Esc` (defer). Power flow for the
  morning triage.
- **F3.14** All HITL decisions are append-only-logged to a JSONL audit
  file (`~/.baton/workstream.jsonl`).

### LLM-generated summary — hybrid, gated on Week-3 dogfood

- **F4.1** Every session has a background "summarizer" that reads the
  **tail of pty buffer (≤20 lines) + last 3 hook events** and produces a
  short (`≤120 chars`, single line, no markdown) "what is the agent
  doing right now" summary.
- **F4.2** Summarizer cadence: **every 30 s while the session is
  active OR on every Claude Code hook event** (whichever comes first),
  with a **5 s floor** between consecutive calls per session.
- **F4.3** Summarizer input is **capped at 20 lines** of tail buffer +
  the last 3 hook events, with **cache on identical inputs** (no LLM
  call if nothing has changed).
- **F4.4** Model: **Claude Haiku 4.5** (cheap, fast). Configurable.
- **F4.5** **Low-budget mode** (toggle in settings, default off):
  cadence drops to 60 s; no LLM call until ≥ 1 hook event since the
  last summary.
- **F4.6** **Hybrid surface (G3).** The chip ALWAYS shows the
  tool-name line from the last `PreToolUse` hook (e.g. `Edit(svc.ts)`).
  The LLM summary line is rendered above it. **If the user disables
  the summarizer (or the Week-3 experiment kills it), the tool-name
  line stands alone** — chip remains functional without LLM.
- **F4.7** **Gate.** Summarizer ships behind a runtime kill-switch
  (`Settings → Summarizer → Show summary line on chip`, default ON).
  Week-3 dogfood (Researcher's plan) measures over a 5-day window:
  - **Click-through** = `terminal_focus_within_5s_of_summary_update / summary_updates`, gated to read-only focus (no `terminal.input` within the 5 s window so the user isn't simply typing).
  - **Accuracy** = median of opt-in thumbs (1/50 sample, 1–5 scale).
  If click-through > 40% **OR** median accuracy < 3 on n ≥ 50
  judgments, the summary line is removed from the chip default and
  becomes opt-in in Settings. Tool-name line stays per F4.6.

### Project view (left pane)

- **F5.1** Project tree per added project. Lazy-load directory contents.
- **F5.2** Respects `.gitignore`.
- **F5.3** Right-click menu: open file, reveal in Finder, copy path,
  new agent on this folder.
- ~~F5.4 ripgrep search — **cut for v1.** Users have rg in the
  shell.~~

### File editor / viewer (center pane)

- **F6.1** Code editor with syntax highlighting (Monaco — same engine
  as VS Code, gives diff editor for free). Edits write through to disk
  on save (Cmd+S).
- **F6.2** Viewers for: **Markdown** (rendered), **images**
  (PNG/JPG/SVG/WebP), **JSON** (formatted + tree), **CSV** (table).
  Fall back to raw text. ~~PDF cut for v1.~~
- **F6.3** **Split layout only** (v1 ships one layout). Top-to-bottom
  vertical stack:
  1. **File tab strip** (always visible at the very top).
  2. **Editor** for the active file tab (default ~50% of vertical
     space, user-adjustable).
  3. **Draggable horizontal handle** to resize. Position persisted
     across restarts.
  4. **Live terminal / conversation** at the bottom (default ~50%,
     user-adjustable). This is the xterm rendering of the Claude
     Code CLI — agent output and the prompt composer share the
     same surface (see §8: F8.1 is hosted here, not in the right
     pane).
  Both editor and terminal are visible at all times; switching
  file tabs at the top changes the editor without affecting the
  terminal below.
- **F6.4** **Conversation is always visible** by construction (it's
  the bottom region of the split, not a tab). No pinned-tab logic
  needed.
- **F6.5** File tabs scroll horizontally on overflow. Single-click
  opens a file in a **preview tab** (italicized, replaced on next
  single-click); double-click or edit promotes it to a **sticky tab**.
- **F6.6** Per-file "Open in VS Code / Cursor / Zed" escape hatch in
  the editor header.
- **F6.7** No language server in v1.

### Git integration

- **F7.1** Per project: current branch indicator, dirty / clean state,
  ahead/behind counts. **Read-only metadata uses `isomorphic-git`** —
  no `git status` subprocess for the polling path. Write ops (commit,
  push, worktree create) shell out via `simple-git`. *(Source: cmux
  `CmuxGit`; Crystal noted 40% CPU reduction from smarter polling.)*
- **F7.2** Worktree creation when spawning an agent on a new branch.
  Mirrors Crystal's `worktreeManager.ts`: `withLock` serialization,
  base-commit capture, `git init` fallback for empty repos, tolerant
  remove.
- **F7.3** Diff view: side-by-side diff of uncommitted changes, scoped
  to the agent's worktree. Built on Monaco's `DiffEditor`.
- **F7.4** Basic git actions: stage / unstage hunk, commit, switch
  branch, pull, push. (No interactive rebase in v1.)
- **F7.5** **Dedup'd job queue** for git ops keyed by `(repo, kind)` —
  identical pending refreshes collapse. *(Source: Zed `GitJobKey`.)*
- **F7.6** **Worktree leak detection.** On launch: `git worktree list`
  ∩ SQLite session table. Unknowns surface in an "Orphaned worktrees
  (N)" project context-menu entry — don't auto-delete.
- *Deferred to v1.1 (see §15):* inline diff comments → structured
  agent context; combined multi-file diff; snapshot-before-destructive-
  approval.

### Live terminal (middle-bottom of the center pane)

> Layout change vs. the original draft: the terminal lives in the
> bottom half of the center pane (under F6.3), not in a separate
> right pane. The right pane is now the **Files + Git sidebar**
> (file tree, git status, orphaned-worktree cleanup). The xterm
> specs below are unchanged — only the location is.

- **F8.1** Embedded terminal (xterm.js) showing the live Claude Code
  session.
- **F8.2** Supports input — typing is forwarded to the pty.
- **F8.3** Scrollback ≥ 10k lines.
- **F8.4** OSC notification sequences (9 / 99 / 777) honored.
- **F8.5** **PTY data path:** `node-pty.onData` → event bus →
  consumers (xterm renderer, summarizer, hook router). Never write to
  xterm directly from the pty callback. *(Source: Zed `alacritty.rs`.)*
- **F8.6** **Adaptive debouncing on `xterm.write`:** coalesce pty data
  into ~16 ms frames; drop frames if the queue depth exceeds N. The
  summarizer consumes the raw stream, not the rate-limited one.
  *(Source: Crystal v0.3.1 — 2800 ms frame drops without this.)*
- **F8.7** Required xterm addons: `addon-fit`, `addon-webgl`
  (critical), `addon-search`, `addon-serialize` (for scrollback
  persistence per F8.8).
- **F8.8** **Scrollback persistence.** Two stores per session:
  (a) **structured event log** (every hook event, every status
  transition) → SQLite, durable. (b) **Raw xterm scrollback** →
  per-session file `~/.baton/scrollback/<session_id>.bin`, capped
  at **5 MB ring buffer**, replayed on focus via
  `addon-serialize`. Last 10 k visible lines guaranteed across
  restarts. *(Source: Architect §10.)*

### Notifications

- **F9.1** Native macOS notifications from the **main process**
  (`new Notification(...)`), not the renderer.
- **F9.2** Dock badge count tracks unread `needs-input` + `errored`
  (`app.dock.setBadgeCount`).
- **F9.3** In-app notification list with unread count.
- **F9.4** Sound configurable per status transition (`done` muted by
  default).
- **F9.5** Notification policy is a composable `Effects` struct —
  `{record, markUnread, reorderProject, desktop, sound, paneFlash}` —
  so users can mute desktop banners but keep history. *(Source: cmux
  `TerminalNotificationPolicy.swift`.)*

### IPC and event stream

- **F10.1** **Single internal IPC channel** (Electron `ipcMain`).
  Verbs: `session.*`, `agent.*`, `feed.*` (HITL), `events.stream`,
  `notification.create`, `pty.*`. Each verb has a **Zod schema**;
  CI compares snapshots, fails on drift. **Most important test in the
  suite.** *(Source: Architect's review.)*
- **F10.2** **`pty.data` lives on its own channel** (not shared with
  control verbs) so high-rate terminal data cannot starve status
  events. *(Source: Architect's review.)*
- **F10.3** **Reconnectable event stream** with `seq` + `boot_id` +
  bounded in-memory replay (4096 events) + JSONL audit log on disk
  (`~/.baton/events.jsonl`, rotated at 100 MB, last 2 segments kept).
  Renderer reconnect with last `seq` replays missed events; mismatched
  `boot_id` → `RESET` + snapshot. *(Source: cmux `docs/events.md`.)*
- **F10.4** Engine emits granular typed events; UI subscribes once via
  Zustand selectors and exhaustively matches. **No per-component
  `EventEmitter.on(...)`.** *(Source: cmux #5310 / Crystal
  `setMaxListeners(100)`.)*
- *Deferred to v1.1 (see §15):* external Unix socket for third-party
  tooling.

### Cost visibility & budget control

- **F11.1** Per-session token spend shown in the radar chip in real
  time.
- **F11.2** Aggregate spend across all running agents shown in the
  title bar.
- **F11.3** **Claude plan usage display** — Nimbalyst-style. Rolling
  **5-hour window** and rolling **7-day window** token usage shown as
  **% of the user's Claude plan limit** (plan detected or configured
  in Settings). Derived from token-usage hooks. Surfaced in the title
  bar and a settings page.
- **F11.4** **Idle-timeout auto-pause.** If a session is `idle` (no
  pty data, no hook events) for >`idleTimeoutMin` minutes, auto-
  transition to `paused` and `SIGSTOP` the pty. Setting is
  **per-project** (per F12.1), default `30`, range `5–240`. `0`
  disables. Stops silent token burn while letting the user resume
  cheaply.
- **F11.5** **Daily aggregate budget circuit breaker.** Hard cap
  across all agents; when crossed, the next attempted agent spawn is
  blocked with "Daily cap reached: $X of $Y. Spawn anyway?" requiring
  explicit confirmation. Different from per-session caps. *(Source:
  Architect.)*
- *Deferred to v1.1 (see §15):* per-session soft cost cap (interacts
  non-obviously with F3.11 HITL).

### Onboarding (F13.x)

First-launch flow that takes a brand-new user from install to first
agent. Three steps; Skip-to-Demo escape at every step (lands in
F2.8 Demo mode).

- **F13.1** First launch shows a **3-step onboarding modal** over a
  dimmed workspace: **Connection → Environment → First project.**
  Step indicator (`●○○ / ○●○ / ○○●`) + Back / Skip-to-Demo /
  Continue buttons. Onboarding state persists; quitting mid-flow
  resumes at the same step.
- **F13.2** **Step 1 — Connection target.** User picks where Claude
  Code will actually run:
  - **Local Mac** (default).
  - **Remote SSH** — Claude Code runs on a remote server; pty
    streamed over SSH via a small baton remote daemon (see §F14).
    Form: `host`, `user`, `port` (22), auth method (SSH key file
    picker / ssh-agent / password). **Test Connection** button
    runs `ssh -o BatchMode=yes -o ConnectTimeout=5` and reports
    `success / auth_failed / unreachable / timeout` within 5 s.
  - Connection profiles named + saved; reusable across projects.
- **F13.3** **Step 2 — Environment check.** The visible check is
  **agent CLIs only**, applied identically on Local and Remote
  targets: at least one of `claude` / `codex` must be present.
  - Two rows: `claude --version` and `codex --version`, both tagged
    **either-or**.
  - Each row: tool name, status (`✓ v<x.y.z>` / `○ Not installed`),
    inline `Copy install command` for the missing one.
  - Summary banner: `✓ Ready to continue` when at least one is `✓`;
    `⚠ Install at least one agent CLI to continue` otherwise. The
    Continue button mirrors this.
  - **Re-detect** link re-runs the probes after the user installs.
  - **Remote daemon dependencies (Node ≥18 and Git) are probed
    silently when the user clicks Continue,** not surfaced as rows
    in the env check. If either is missing on the remote, an inline
    error appears with the package-manager-specific install command
    (auto-detected: apt / yum / pacman on Linux remote) and a Retry
    button. *(Source: avoid pre-Continue noise; keep the visible
    check focused on what the *user* installs vs. what the daemon
    needs.)*
- **F13.4** **Step 3 — First project.** Two paths exposed as
  segmented tabs:
  - **Open existing folder** — native directory picker; project
    added via F1.1.
  - **Clone from git** — URL field (`git@github.com:user/repo.git`
    or `https://github.com/user/repo`), destination folder picker
    (default `~/baton/<repo-name>`), branch (default upstream
    HEAD). Uses user's existing git credentials (matches F7.1).
    Clone progress streamed; failures surface inline with the
    underlying git error.
  - On success, project is added and the user lands in the main
    workspace with a `Spawn first agent` CTA pre-filled.
- **F13.5** **Skip-to-Demo.** Visible at every step. Drops the user
  into the main workspace with a single `MockAgentBackend` session
  already running (F2.8). The Demo session is destroyed when the
  user adds a real project.
- **F13.6** **Re-entry.** `Settings → General → Re-run onboarding`
  returns to step 1 at any time without losing existing projects or
  sessions.
- **F13.7** **Telemetry on the funnel.** Onboarding emits:
  `onboarding.started`, `onboarding.step_completed { step, ms }`,
  `onboarding.skipped { at_step, to_demo }`, `onboarding.finished`,
  `connection.remote_interest`, `env.tool_missing { tool }`.

### Remote execution (F14.x)

When the user picks Remote SSH in onboarding (F13.2), Claude Code
runs on the remote host, not locally. baton stays on the Mac and
streams the agent's pty + hooks over the SSH connection. This is a
v1 feature; cmux's `cmuxd-remote` Go daemon is the architectural
precedent.

- **F14.1** **baton-remote daemon.** A small Node binary
  (`@baton/remote-daemon`) installed on the remote host. Bundled
  for `darwin-x64`, `darwin-arm64`, `linux-x64`, `linux-arm64`.
  Responsibilities:
  - Spawn / pause / kill Claude Code pty subprocess (same as local
    `node-pty` path).
  - Read project files for the file tree and diff view.
  - Run `setup.sh` / `setup.json` on the remote worktree.
  - Watch FS via `chokidar` and emit invalidation events.
  - Forward hook events from Claude Code back over the stream.
  - **Auto-install on first connection** if missing: baton SCPs the
    binary to `~/.baton/remote-daemon` and runs it under a small
    bootstrap script (`bash -c '$HOME/.baton/remote-daemon serve'`).
- **F14.2** **Stream protocol.** One SSH connection per remote host;
  multiplexed over OpenSSH ControlMaster (no per-session reconnect).
  On top: a length-prefixed framed protocol (same IPC verbs as
  F10.1, just transport-swapped) carrying:
  - `pty.data` (high rate; backpressure-aware).
  - `session.*`, `events.stream`, `feed.*`, `notification.create`
    control verbs.
  - `fs.read` / `fs.write` / `fs.watch.event` for editor + diff
    panes.
- **F14.3** **Reconnect.** If SSH drops, baton reconnects with
  exponential backoff (`2s → 30s, max 5 min`); event stream resumes
  via F10.3's `seq` + `boot_id` mechanism. Sessions on the remote
  daemon persist across disconnect (detached subprocesses); on
  reconnect, daemon replays buffered events.
- **F14.4** **Worktree path resolution.** Worktrees are created on
  the **remote** (`~/.baton/worktrees/<project>/<wt-name>`); local
  baton sees them via `fs.read`. The file tree / editor / diff
  panes operate on remote paths transparently. "Open in VS Code"
  (F6.6) uses VS Code Remote-SSH to attach to the same host.
- **F14.5** **Secrets.** SSH keys never leave the Mac. `claude` API
  key on the remote can be either the user's pre-existing
  `~/.claude/credentials` on the remote OR forwarded from the Mac
  via SSH environment (user choice in connection profile).
- **F14.6** **Performance budgets** (additive to NF1–NF3):
  - SSH round-trip latency on a typical SF→US-East server: target
    p50 ≤ 80 ms, p99 ≤ 250 ms.
  - `pty.data` throughput ≥ 5 MB/s sustained.
  - First-paint of remote session: ≤ 6 s (vs. ≤ 3 s local).
- **F14.7** **Graceful local fallback.** If remote daemon refuses
  to install (no `~/.baton` write access, no `node` on remote,
  hardened-shell-only login), baton surfaces a clear error in the
  onboarding flow and reverts to Local-only for this connection
  profile.
- **F14.8** **Disconnect UX.** When SSH drops mid-session: chip
  enters a new `disconnected` substate (still shown on the radar,
  greyed). User can `Reconnect now`, `Switch to demo mode`, or
  `Kill session`.

### Settings (cross-cutting)

- **F12.1** Settings split explicitly: **per-project** (setup script,
  caps, summarizer cadence) vs **global** (notifications, theme,
  model, agent backends, keyboard).
- **F12.2** Per-project settings surface as a drawer from the project
  context menu. Global settings live in a full-pane modal.
- **F12.3** Settings storage: **SQLite owns** everything mutable
  (per-project caps, telemetry opt-in, summarizer toggles).
  `~/.baton/config.json` holds **only bootstrap values** needed
  before SQLite opens (theme, last-window-bounds). Two stores,
  clear boundary.
- **F12.4** **Telemetry inspector** (`Settings → Privacy → View what
  we send`): scrollable list of the last 100 outgoing telemetry
  events with timestamp, event name, properties. Copy-to-clipboard
  for support. Mandated by NF5; devs will inspect, so we surface it.
  *(Source: metrics-plan.md §7.)*
- **F12.5** **Claude plan configuration UI** (`Settings → Account →
  Plan`): user picks `Pro / Max / API` and enters the 5h and 7d
  rate-limit values (auto-fills with Anthropic-documented defaults;
  re-detectable from rate-limit response headers if present).
  Powers F11.3.

---

## 6. Non-functional requirements

- **NF1.** Cold start to interactive: < 3 s on M-series Mac.
- **NF2.** ≥ 10 concurrent agent sessions on a 16 GB Mac without
  perceptible UI lag (working set ≈ 2.5 GB at 10 agents, validated by
  Architect).
- **NF3.** Summarizer LLM cost **≤ $0.05/hour/active-agent at default
  cadence** (30 s + hook-driven + ≤20-line input). **Ceiling
  $0.20/hour, alarmable above.** *(Re-derived after Architect found
  the original 5 s cadence implied ~$0.54/hr — 10× overrun.)*
- **NF4.** Crash recovery: session state restored on relaunch via the
  temp-model-then-commit pattern (F2.4).
- **NF5.** **No telemetry without explicit opt-in** (default off).
  Never collect: code, diff, prompt, summary text, command strings,
  branch names, file paths (paths hashed; branches bucketed).
- **NF6.** Renderer hardening: `contextIsolation: true`,
  `nodeIntegration: false`, `sandbox: true`. CSP `connect-src 'self'`.
- **NF7. Accessibility.** WCAG 2.1 AA contrast on all chrome
  (`--text-faint:#7a8088` over `--bg-1` passes); `:focus-visible`
  outline on every interactive element; `prefers-reduced-motion`
  respected (no pulsing dots, no transitions); ARIA roles on chips
  (`role="button"`), status badges (`role="img" aria-label="status: …"`)
  and tabs; **status is never communicated by color alone** — every
  state has an icon glyph (▶ ⚠ ✓ ✕ ⏸). Light theme is v1.1.
- **NF8. Error handling philosophy.** **Fail-open** for any hook,
  notification, or sidecar service (summarizer, isogit reader,
  chokidar) — failures degrade quietly, never block the user or
  freeze the agent. **Fail-closed** for write-side git ops and IPC
  schema violations — surface to the user explicitly. Every IPC verb
  is Zod-validated; schema failures throw at the boundary, never
  inside business logic. No unhandled promise rejections in the
  renderer or main process. Errors surface to a user-readable
  notification + the in-app log viewer (`Help → Logs`).
- **NF9. Logging.** App logs at `~/.baton/logs/` (rotated daily,
  kept 7 days). Levels: `error / warn / info / debug`. User-facing
  log viewer (`Help → Logs`) with copy-to-clipboard for bug reports.
  Secret-redaction (`KEY|TOKEN|SECRET|PASSWORD=...` lines) applied
  before any log write or telemetry emit.
- **NF10. Update mechanism.** Sparkle (`electron-updater`) auto-update
  to a signed + notarized release. User can defer; no force-install.

---

## 7. Acceptance criteria (per F-section)

Each criterion is testable.

### Project management (F1.x)
- Add persists across launches (stable sort).
- Remove preserves files; worktrees cleaned only on user confirm.
- `setup.json` validated on add; invalid JSON path shown inline.
- F1.4 setup runtime: <60 s normal, "still running" badge >60 s,
  hard-killed >10 min.
- F1.5 hash change → re-prompt within the next agent spawn flow.
- F1.6 `--dry-run` lists every command and copy operation without
  side effects.

### Agent session (F2.x)
- Concurrent spawns succeed without lock contention (F7.2 `withLock`).
- F2.2 falls back to `wt-<short-uuid>` on Haiku failure or >30 chars
  generated.
- F2.3 ops serialized per session: rapid `pause; resume; pause; kill`
  execute in order; no orphan pty.
- F2.4 restore observable via `baton restore --dry-run`. What gets
  restored: project list, session metadata (worktree path, branch,
  status enum), prompt log, last summary, intent label, open file
  tabs. **Not** restored: in-flight HITL requests (cancelled to
  `agent_died`), live pty output buffer (replays from F8.8 scrollback
  file), editor cursor positions.
- F2.6 a no-op `MockAgentBackend` runs chip lifecycle without Claude
  Code installed.
- F2.7 every hook returns ≤250 ms, preserves `$?`; hung IPC →
  timeout + fail-open.
- F2.8 Demo mode covers radar + summary + HITL with zero real
  credentials.

### Status surfacing (F3.x)
- Status enum exhaustive in renderer `match`.
- F3.3 chip renders project, branch, badge, tool-name line, summary
  line, time-in-status, spend, **and** Claude-plan 5h-window usage %
  when F12.5 is configured.
- F3.4 deep link `baton://session/<uuid>` survives relaunch;
  `baton://` protocol handler registered with macOS Launch Services
  on first run.
- F3.5 notification from main process (architectural lint); click
  focuses app + correct chip.
- F3.6 nested subprocess routes to correct session.
- F3.7 sidebar metadata updates while a *different* project is
  focused.
- F3.8 inbox shows every `needs-input` + `errored` session sorted by
  age; opens on `Cmd+Shift+I`.
- F3.9 intent label persists across restarts; edit-in-place via
  double-click on chip label; ≤32 chars.
- F3.10 transitions modal opens ≤200 ms after right-click; shows all
  state changes for the session with timestamp + trigger.

### HITL (F3.11–F3.14)
- Card visible ≤500 ms after hook fires.
- Approve/deny round-trip ≤200 ms on local IPC.
- Timeout at 120 s ±2 s.
- Every decision (approve/deny/reason/timeout/crash) → one
  append-only line in `workstream.jsonl`; never partial under
  concurrent writes.
- F3.13 keyboard row works without mouse.

### Summarizer (F4.x)
- Cadence: ≤1 call / 5 s and ≥1 call / 30 s while active.
- Summary ≤120 chars, single line, no markdown.
- No LLM call if no new pty data and no new hook event since the last
  summary.
- F4.6 chip remains functional with summary disabled (tool-name line
  stands alone).

### Project view (F5.x)
- Lazy expansion: 50k-file dir doesn't block UI >200 ms.
- `.gitignore` respected per dir with override toggle.
- "New agent on this folder" pre-fills the dialog.

### Editor / viewer (F6.x)
- Monaco ≤1.5 s first open; instant after.
- F6.2 viewers content-sniff by extension + magic bytes.
- F6.5 preview vs sticky behaves: single-click `a`, single-click `b` →
  only `b` open; double-click `b`, single-click `c` → both.
- F6.6 opens *current file*, not project root.

### Git (F7.x)
- F7.1 read-only path makes 0 `git` subprocess calls in steady state.
- F7.2 concurrent spawns yield N distinct worktrees, no errors.
- F7.3 diff renders ≤500 ms on a 200-file changeset.
- F7.5 100 `gitStatus:<repo>` calls in one tick → 1 actual read.
- F7.6 orphaned worktree count surfaces in project context menu.

### Terminal (F8.x)
- 10 k scrollback.
- OSC 9 (notification w/ message), OSC 99 (notification w/ structured
  payload), OSC 777 (notify+title) each fire policy evaluation per
  F9.5.
- F8.5 zero direct writes from `node-pty.onData` to xterm
  (architectural lint).
- F8.6 100 MB / 10 s burst keeps UI thread blocked < 50 ms per frame;
  dropped frames shown as "+N lines dropped" banner. Queue-depth
  threshold N = 8 frames (default; configurable in settings under
  *Performance*).
- F8.8 Quit app with full scrollback → relaunch → focus session →
  last 10 k lines restored within 200 ms.

### Notifications (F9.x)
- F9.1 main process only (architectural lint).
- F9.2 dock badge = count of `needs-input` + `errored`.
- F9.5 muting desktop still records in-app.

### IPC / event stream (F10.x)
- Single IPC channel (architectural lint).
- F10.1 every verb has a Zod schema; CI snapshot diff blocks merge.
- F10.2 `pty.data` on its own channel; control verb latency unaffected
  by terminal burst.
- F10.3 replay survives sleep/wake; mismatched `boot_id` → `RESET`.
- F10.4 zero per-component listeners on the bus (architectural lint).

### Cost / budget (F11.x)
- Per-session spend updates on chip ≤1 s after token-usage hook.
- F11.3 5h + 7d usage % updates within 60 s of any token-usage hook;
  amber at ≥80%, red at ≥95%.
- F11.4 idle timer correctly transitions to `paused` after
  `idleTimeoutMin` minutes with no pty/hook activity; `SIGSTOP`
  delivered to pty group.
- F11.5 daily cap blocks the *next spawn*; does not kill in-flight
  agents. User can override per-spawn with explicit confirm.

### Settings (F12.x)
- F12.1 per-project drawer keys persist independently of global
  prefs.
- F12.3 corrupted `config.json` → safe-default boot; SQLite never
  touched outside the running app process.
- F12.4 inspector lists every event sent in the last 100 emits with
  full property payload; opt-in toggle visible inline.
- F12.5 plan picker pre-fills 5h / 7d limits from Anthropic
  documented defaults; manual override allowed.

### Onboarding (F13.x)
- F13.1 first-launch detection via SQLite flag; resumes mid-step
  after quit.
- F13.2 Test Connection on Remote runs `ssh -o BatchMode=yes -o
  ConnectTimeout=5` and reports `success`, `auth_failed`,
  `unreachable`, or `timeout` within 5 s.
- F13.3 tool detection runs the bare `--version` command in a clean
  shell; ≤2 s per tool. **Re-detect** invalidates the cached result.
- F13.4 git clone progress emitted as `clone.progress { received,
  total }` events ≥1 Hz; failure surfaces stderr verbatim.
- F13.5 Demo session is tagged `is_demo:true`; removed automatically
  on first real `session.spawn`.
- F13.6 re-running onboarding does not delete existing projects or
  sessions; on completion, returns user to last-focused project.
- F13.7 onboarding funnel telemetry powers an Activation funnel
  dashboard (metrics-plan §8).

---

## 8. User stories (selected)

Selected Given/When/Then stories that pin behaviour not obvious from
the F-statements. **Full set (18 stories spanning every F-section) in
`pm-additions.md` §2.**

**US-1.4a** *Given* a new worktree and a project with `setup.sh`,
*when* the agent is about to spawn, *then* the script runs with
stdout/stderr streamed into the agent's terminal; agent spawn is
gated on the script's exit code 0.

**US-2.5b** *Given* a session has both a `ClaudeCodeBackend` agent
panel and a `MockAgentBackend` demo panel attached, *when* one panel's
status changes, *then* only that panel updates; the session's chip
badge is worst-status-wins. *(Codex backend is v2 — `AgentBackend`
trait is satisfied in v1 by `ClaudeCodeBackend` and `MockAgentBackend`
only.)*

**US-3.11a** *Given* a HITL request and the user approves within 120 s,
*when* approve fires, *then* the hook unblocks with
`{"decision":"allow"}` and `workstream.jsonl` records
`{request_id, sessionId, decision, latency_ms, user_action_ts}`.

**US-3.11b** *Given* a HITL request pending ≥120 s, *when* timeout
fires, *then* the hook receives `{}`, the agent's native prompt takes
over, chip → `running`, log `decision:"timeout"`.

**US-4.6a** *Given* the user has disabled the LLM summarizer in
settings, *when* an agent transitions states, *then* the chip shows
the tool-name line only and the layout does not break.

**US-6.4a** *Given* split mode and the user is reading the editor,
*when* the agent emits a new message, *then* the conversation region
scrolls to keep the latest visible without stealing keyboard focus.

**US-10.3a** *Given* the renderer has been disconnected for ≤4096
events, *when* it reconnects with last `seq`, *then* it receives the
missed events in order before live resume.

**US-10.3b** *Given* mismatched `boot_id` on reconnect, *when* the
client connects, *then* server emits `RESET` and the client clears
its in-memory state before applying the snapshot.

**US-11.3a** *Given* a Claude Pro plan with the 5h-window limit
configured, *when* the user crosses 80% of the rolling 5h window,
*then* the title bar usage % indicator turns amber.

**US-11.5a** *Given* the daily aggregate budget is set to $20 and
total spend has reached $19.85, *when* the user attempts to spawn a
new agent, *then* the spawn dialog shows "Daily cap reached: $19.85
of $20. Spawn anyway?" with explicit confirm.

**US-1.5a** *Given* a project's `setup.sh` was previously trusted
(SHA256 stored), *when* the file's contents change before the next
agent spawn, *then* baton re-prompts with a diff preview and
refuses to spawn until the user re-trusts.

**US-7.3a** *Given* the user clicks a chip whose agent has touched
12 files, *when* the diff view opens, *then* Monaco `DiffEditor`
renders the first file ≤500 ms; remaining files are virtualized
and rendered lazily as the user scrolls.

**US-9.1a** *Given* an agent transitions to `needs-input` while the
app is unfocused, *when* the transition fires, *then* a native
macOS notification (from the **main process**, not the renderer)
appears with the project + branch + reason, and the dock badge
increments by one.

**US-12.5a** *Given* a user on Claude Pro who configures their plan
in Settings, *when* token-usage hooks fire, *then* the 5h-window
indicator updates within 60 s; when it crosses 80%, the indicator
turns amber and the title bar shows `5h: 82%`.

---

## 9. Success metrics

### North star

**Weekly Active Agent-Hours per WAU (WAAH/WAU).**

Definition: `sum(active_agent_seconds_in_week) / count(WAU) / 3600`,
where active = seconds in `running` or `needs-input`. `idle` /
`paused` / `done` / `errored` excluded.

Why: the wedge is *"the agents work, you supervise"* — value scales
with how many agent-hours of useful work accumulate per week.

Targets: dogfood (n=1) ≥60 WAAH/wk by week 4; beta (n≈20) median 25;
public (n≈1k) median 15, p75 ≥40.

### Co-primary: Summary trust score

Because G3 (the LLM summary) is a hypothesis, we measure it as a
co-primary, not subordinate to WAAH:

- **Proxy A (behavioural):** `1 − (terminal_focus_within_5s_of_summary_update / summary_updates)`. Target ≥0.7.
- **Proxy B (explicit, 1/50 sampled thumbs):** `thumbs_up / (thumbs_up + thumbs_down)`. Target ≥0.8.

If both miss after Week 3 dogfood, F4 is removed from the chip
default per F4.7.

### Guardrails (GR1–GR7)

Optimizing the north star must not regress any of these for ≥2
consecutive weeks. *(Numbered `GR` to avoid namespace collision with
goals G1–G6 in §2.)*

| # | Metric | Definition | Target |
|---|---|---|---|
| GR1 | p95 main-process CPU at 5 agents | 30 s sample | ≤25% on M-series |
| GR2 | p95 RSS at 5 agents | renderer + main | ≤1.2 GB |
| GR3 | p99 status-transition latency | hook fire → chip paint | ≤500 ms |
| GR4 | Summarizer $/active-agent-hour | tokens × price / active hours | ≤$0.05 (NF3) |
| GR5 | False-positive needs-input rate | needs-input transitions reverted ≤30 s with no user action | ≤5% |
| GR6 | App crashes per 100 session-hours | `app.crash` events | ≤0.5 |
| GR7 | HITL timeout rate | `hitl.timed_out / hitl.created` | ≤10% |

### Activation, engagement, retention

**Activation (24 h):** `project.added ≥ 2 ∧ session.spawn ≥ 2 ∧
notification.fired ≥ 1 ∧ notification.clicked ≥ 1`. Target 35% at
N100, 45% at N1k.

**Engagement:** DAU/WAU ≥0.5; agents spawned/WAU/week median ≥10;
concurrent-peak/WAU/week median ≥3.

**Retention (D1 / D7 / D28):** ≥60% / ≥40% / ≥30%.

**TTN (time-to-notice needs-input):** median ≤30 s, p90 ≤120 s.

**Polling rate (radar chip clicks with no follow-up):** ≤0.5/hour
after week 2.

---

## 10. Telemetry & metrics (privacy-first)

### Strict opt-in (NF5)

First launch: modal, default **OFF**. Settings ships a "View what we
send" inspector showing the last 100 outgoing events.

### Never collected

Code, diff, prompt, summary text, terminal output, command strings,
file paths (hashed), branch names (bucketed), email/identity.

### Event spec (17 events)

| # | Event | When | Key properties |
|---|---|---|---|
| 1 | `app.start` | main ready | `cold_start_ms, restored_session_count` |
| 2 | `app.crash` | renderer crash / main uncaught | `reason_class, last_event_seq` |
| 3 | `project.added` | "add project" flow completes | `project_id (sha256 path), had_setup_script` |
| 4 | `project.removed` | | `project_id` |
| 5 | `project.opened` (1/5 sample) | project focused | `project_id` |
| 6 | `session.spawn` | spawn resolves | `session_id, project_id, backend_id, worktree_was_new, setup_script_ran, setup_script_failed` |
| 7 | `session.status_changed` | hook transition | `session_id, from, to, latency_from_hook_ms` |
| 8 | `session.summarized` | summarizer produced | `session_id, model_id, in_tok, out_tok, latency_ms, cache_hit` — **no summary text** |
| 9 | `session.kill / resume / exit` | | `session_id, reason` |
| 10 | `notification.fired` | main `new Notification` | `session_id, trigger, surface` |
| 11 | `notification.clicked` | OS callback | `session_id, ms_since_fired` |
| 12 | `notification.dismissed / ignored` | | `session_id, ms_since_fired` |
| 13 | `hitl.created / approved / denied / timed_out` | Feed lifecycle | `request_id, session_id, tool_class, wait_ms` — **tool class only, never command body** |
| 14 | `ui.engagement` | (250 ms coalesce) | `kind, session_id?, ms_since_last` |
| 15 | `perf.sample` (30 s) | | `cpu_main, cpu_renderer, rss_main, rss_renderer, xterm_queue_depth_p95, ipc_rtt_p95_ms` |
| 16 | `summarizer.error` | | `error_class, retry_count` |
| 17 | `git.commits_authored_by_agent` | commit completes on agent-owned worktree | `count_only` — outcome metric for "shipped" |

### CLI hook: `tfa feedback`

Devs run `tfa feedback "summary was wrong on session xyz"` from the
terminal. Better signal-to-noise than in-product UI; zero render
cost. Stored locally + sent on opt-in.

---

## 11. Architecture sketch

```
┌────────────────────────────────────────────────────────────────────────┐
│  Electron main process (Node) — local OR remote-proxied                │
│  ┌────────────┐  ┌────────────┐  ┌────────────┐  ┌──────────────────┐  │
│  │ Session    │  │ Worktree   │  │ Git reader │  │ Notification     │  │
│  │ Manager    │  │ Manager    │  │ (isogit +  │  │ Center (main-    │  │
│  │ (per-sess  │  │ (withLock, │  │  simple-   │  │  process Native, │  │
│  │  queues)   │  │ LLM-named) │  │  git)      │  │  dock badge)     │  │
│  └─────┬──────┘  └─────┬──────┘  └─────┬──────┘  └─────────┬────────┘  │
│        │               │               │                   │            │
│  ┌─────┴──────┐  ┌─────┴──────┐  ┌─────┴──────┐  ┌────────┴─────────┐  │
│  │ AgentBack  │  │ pty / node │  │ FS watcher │  │ Event bus +      │  │
│  │ ends:      │  │ -pty       │  │ (chokidar) │  │ JSONL replay log │  │
│  │ Claude /   │  │ + xterm    │  │ + dedup    │  │ ~/.baton/       │  │
│  │ MockAgent  │  │ writer     │  │ job queue  │  │   events.jsonl   │  │
│  └────────────┘  └────────────┘  └────────────┘  └──────────────────┘  │
│                                                                        │
│        Local mode: pty/git/fs run in-process.                          │
│        Remote mode: same modules talk to RemoteTransport over          │
│        a multiplexed SSH ControlMaster connection ↓                    │
│                                                                        │
│  ┌────────────────────────────────┐                                    │
│  │ Summarizer (worker_thread in   │  subscribes to pty bus inside      │
│  │ main; off main thread):        │  main; emits session.summarized    │
│  │ - 30 s + hook-driven cadence   │  events back through the bus to    │
│  │ - Haiku 4.5; ≤20 lines input   │  the renderer.                     │
│  └────────────────────────────────┘                                    │
└─────────────────────────────────▲──────────────────────────────────────┘
                                  │ IPC: control verbs (single bus, Zod)
                                  │      + pty.data on its own channel
┌─────────────────────────────────┴──────────────────────────────────────┐
│  Renderer (React + Zustand + Monaco)                                   │
│  - Radar (chips: tool-name + summary + spend + plan-usage)             │
│  - 3-col layout (projects | editor+conv split | files+git)             │
│  - HITL approval cards (semaphore-backed) · Agent inbox                │
│  - Demo mode · Settings (per-project drawer + global modal)            │
│  - NO direct file I/O, NO process spawn — IPC only                     │
└────────────────────────────────────────────────────────────────────────┘

REMOTE MODE (F14 — v1, post-v0):
┌─────────────────────────────────────────┐    ┌────────────────────────┐
│ Local Mac (Electron main)               │    │ Remote host (Linux/Mac)│
│  ┌─────────────────────────────────┐    │    │ ┌────────────────────┐ │
│  │ RemoteTransport                  │   ssh ─┼─┤ @baton/           │ │
│  │ - SSH ControlMaster              │  ◄────►│ │ remote-daemon      │ │
│  │ - length-prefixed framed wire    │    │    │ │ - node-pty         │ │
│  │ - pty.data + control verbs       │    │    │ │ - chokidar         │ │
│  │ - reconnect w/ seq + boot_id     │    │    │ │ - git ops          │ │
│  └─────────────────────────────────┘    │    │ └────────────────────┘ │
└─────────────────────────────────────────┘    └────────────────────────┘
```

**Stack:** Electron + Node + React + Zustand + Monaco + xterm.js (webgl)
\+ node-pty + isomorphic-git + simple-git + chokidar + better-sqlite3.

**Why Electron over Tauri:** `node-pty`, `xterm.js`, `simple-git`,
`chokidar` all run natively in Node; Crystal is a working precedent.

**Why CLI under the hood:** users already configured CLI auth, hooks,
and MCPs. The `AgentBackend` trait (F2.6) lets us add Codex / others
identically.

**Why panels are first-class:** Crystal had to refactor session=agent
into session-has-many-panels in v0.3.4 and it was painful. We do it
from MVP.

**Why a single event bus:** cmux + Crystal both shipped multi-GB
memory leaks from per-component listeners. One typed bus + Zustand
selectors.

---

## 12. v0 milestone plan (4 weeks)

> *4-week plan assumes engineer has Electron + Node experience. If
> not, add 2 weeks to W1.*

**Ship in v0:**
- F1.1, F1.2, F1.3 (no disk-usage indicator yet)
- F2.1, F2.3 (no pause), F2.4, F2.6 (trait + `ClaudeCodeBackend` +
  `MockAgentBackend`), F2.8 (Demo mode lands W2)
- F3.1, F3.2, F3.3 (chip without plan-usage), F3.4, F3.5, F3.6, F3.7
- F4.1–F4.6 (summary line gated on Week-3 dogfood per F4.7)
- F8.1–F8.3, F8.5, F8.6
- F10.1 internal only, F10.4
- NF1, NF2, NF3, NF4, NF5, NF6, NF7 (architectural lints only), NF8

**Stubbed (model the data; defer the UI):**
- F1.4 setup script (manual `npm install` in v0; UI W4)
- F1.5, F1.6 (trust + dry-run land with F1.4 in v1, not v0)
- F2.2 worktrees (project-root first, worktrees W3)
- F2.5 panels (single terminal panel — model the data structure)
- F2.7 + F3.11–F3.14 HITL semaphore (W3)
- F3.8 Agent inbox (v1, not v0)
- F3.9 Per-agent intent label (v1)
- F3.10 Transitions log (v1)
- F5.x project view (W4 file tree, search cut)
- F6.x Monaco (W4 flag-gated, single file)
- F7.x git (read-only W4, diff post-v0)
- F8.7, F8.8 scrollback persistence (W4)
- F9.x notifications (W3)
- F11.1, F11.2 per-chip + titlebar spend (W4)
- F12.x settings (W4 minimal)

**Killed for v0 (spec only, implement v1):** F11.3 (Claude plan
usage), F11.4 (idle-timeout auto-pause), F11.5 (daily aggregate cap),
F12.4 (telemetry inspector), **F13.2 Remote SSH path + F14 entire
remote-execution stack** (v0 ships Local-only; Remote daemon is a
separate 2–3 week build that lands in v1 W5–W7 after the v0
foundation is solid).

**Week-by-week:**

- **W1.** Electron + React + Zustand skeleton. IPC bus + Zod
  schemas. SQLite + migrations. node-pty + xterm + adaptive debounce.
  **Goal:** type, see output, scrollback persists.
- **W2.** `AgentBackend` + `ClaudeCodeBackend`. Hooks
  (`SessionStart`, `Stop`, `Notification`) drive status. Chip with
  status + Haiku summary. **First demoable:** "I started Claude,
  closed the app, reopened, still there."
- **W3.** Worktree-per-agent + LLM-named worktrees. Per-session
  lifecycle queue. HITL semaphore with fail-open. Main-process
  notifications + dock badge. **Second demoable:** "Three agents on
  three branches, notifications fire."
- **W4.** File tree. Monaco single-file open. isogit read path.
  Per-chip cost. Crash-recovery pass. **v0 ship.**

Demo mode (F2.8) lands in W2 (mock backend covers the radar +
summary + HITL paths without Claude credentials).

---

## 13. Architectural risks (ranked)

| # | Risk | Mitigation | Decide by |
|---|---|---|---|
| 1 | IPC bus design ossifies before we know the right shape | Ship bus + Zod schemas W1; only extend until v1 | end of W1 |
| 2 | Summarizer cost overruns NF3 | 30 s cadence + hook-driven + ≤20-line input + low-budget mode (F4.5) | W2 before users see costs |
| 3 | Hook contract drift between Claude Code versions | Pin minimum CLI version; version-detect on spawn; nightly integration test | W2 |
| 4 | node-pty + Electron upgrade hell | Pin Electron + electron-rebuild; `portable-pty` napi escape hatch researched (not built) | W4 |
| 5 | `setup.sh` running malicious user code | First-run trust + hash (F1.5); `--dry-run` (F1.6); log-redact | W3 before F1.4 ships |
| 6 | Remote-daemon attack surface (F14) — baton ships binary to user's server | Signed binary, SHA256 verified after SCP, bootstrap script visible to user, no root required, daemon runs as the SSH user only | end of v1 W5 |
| 7 | SSH stream backpressure on noisy agents (1 MB/s × N agents over a 100 Mbps link) | Per-session pty.data rate cap; coalesce frames into 16 ms windows on the daemon side; "Remote bandwidth saturated" banner | v1 W6 |

---

## 14. Open questions

Items that affect v0/v1 scope and need a call before W3. Everything
already decided lives in §3 (Non-goals), §15 (Parked), or the
v1.1-deferral footers in §5.

- **Daily aggregate cap default.** F11.5 specs the mechanism; what's
  the shipped default value? Options: `$0` (off / opt-in), `$20`
  (conservative), `$50` (most users won't hit). Suggest `off` so we
  don't gate spawns before users see their own spend.
- **Telemetry inspector in v0?** F12.4 is a v1 requirement, but
  Researcher and DS argue the opt-in conversion rate depends on
  visible trust. Worth shipping a minimal version in W4? Cost ~1
  day; payoff is the first opt-in user.
- **Secrets-redaction scope.** NF9 says redact `KEY|TOKEN|SECRET|
  PASSWORD=...`. Are we redacting only logs + telemetry, or also
  scrollback persistence (F8.8)? If scrollback, the agent can't
  see its own past output of, say, `echo $STRIPE_KEY` — usually
  desirable but breaks some workflows.
- **`baton://` protocol handler.** Registered in v0 (Architect open
  Q #6) — W3 demoable requires it for "click notification → focus
  chip" flow. Confirm it's on the W3 schedule.
- **W3 dogfood scope.** F4.7 gate happens after W4 ship — but if
  the dogfood reveals existential summary failure, do we still ship
  v1 (with summary off by default) or hold? Suggest ship anyway —
  tool-name line stands alone.

*(Already-decided items moved to §15 Parked: command palette, CRDT
collab editing, snapshot-before-destructive, baseline-week mode,
worktree-per-agent.)*

---

## 15. Out of scope, parked

**Deferred to v1.1:**
- Tabbed middle-pane layout (we ship split-only in v1).
- Inline diff comments → structured agent context (PRD-old F7.4).
- Combined multi-file diff view (PRD-old F7.5).
- External Unix socket for third-party tooling (PRD-old F10.2 external).
- Per-session cost cap (PRD-old F11.4).
- Light theme.
- Command palette (Cmd+K) — spec'd later, not v1.
- Snapshot-before-destructive HITL approval (`git stash create`-backed
  one-click undo).
- "Baseline week" mode for measuring pre-baton alt-tab cadence.
- Worktree-per-agent vs shared-worktree toggle — v1 default per-agent
  with opt-out only; full toggle is v1.1.

**v2 or later:**
- Codex / Gemini / OpenCode agent backends (trait exists in v1).
- CRDT-collaborative editing with the agent.
- Cross-platform (Windows / Linux).
- Remote / SSH workspaces.

**Out of scope indefinitely:**
- Plugin / extension API.
- Cloud sync of project list across machines.
- Mobile companion app for notifications.
- Integrated PR review UI.
- Team / enterprise SKU.

---

## Appendix A — file map

Repo root holds **`PRD.md`** (this file), `README.md`, and `.gitignore`.
Everything else is under `docs/` or `design/`.

**`docs/`** — supporting docs.
- `docs/pain-points.md` — origin pain & motivation.
- `docs/prior-art.md` — synthesized research (cmux, Conductor, Crystal,
  Zed).
- `docs/team-synthesis.md` — round-1 synthesis with decisions table.

**`docs/team/`** — frozen specialist outputs that informed this PRD.
- `docs/team/pm-additions.md` — 7 use cases, 18 user stories,
  acceptance + edge cases per F-section.
- `docs/team/positioning.md` — PMM positioning (ICP, category,
  narrative, naming).
- `docs/team/design-review.md` — mockup critique + IA + accessibility.
- `docs/team/research-brief.md` — assumption audit + 4-week research
  plan + ICP interview script.
- `docs/team/metrics-plan.md` — north-star + guardrails + telemetry +
  experiments.
- `docs/team/architecture-review.md` — feasibility audit + v0 plan +
  risk ranking.

**`design/`** — visual mockups (open in a browser).
- `design/mockup.md` — ASCII wireframes.
- `design/mockup.html` — main 3-column interactive prototype.
- `design/mockup-split.html` — split middle pane (the v1 layout).
- `design/mockup-onboarding.html` — 3-step onboarding flow.
- `design/mockup-new-agent.html` — new-agent dialog.
- `design/mockup-command-palette.html` — Cmd+K (v1.1 surface).
- `design/mockup-collapsed-sessions.html` — F3.8 Agent Inbox + dense
  radar at 15+ sessions.

---

## Appendix B — Glossary

For a first engineer joining cold.

- **Agent / agent session** — a single Claude Code (or future
  Codex / Gemini) process spawned by baton in a worktree, attached
  to one project. Lives until killed or the session ends.
- **Agent Backend (`AgentBackend`)** — the TS interface every agent
  CLI plugs into. v1 ships `ClaudeCodeBackend` and `MockAgentBackend`
  (for demo / tests). Codex is v2.
- **Chip** — a single radar entry. One chip per session. Shows
  project, branch, status badge + glyph, tool-name line, LLM summary
  line, time-in-status, spend, optional Claude plan usage %.
- **Demo mode** — first-launch mode (F2.8) that spawns a
  `MockAgentBackend` with a scripted transcript. Exercises the full
  loop without Claude credentials.
- **Hook (Claude Code hook)** — script Claude Code invokes at
  lifecycle moments (`SessionStart`, `PreToolUse`, `Notification`,
  `Stop`, `SessionEnd`). baton installs hooks that emit IPC events
  to drive status (F3.2) and HITL approvals (F3.11).
- **Hybrid intent line** — the chip's per-session text. Shows the
  tool name from the last `PreToolUse` hook (always-accurate fallback)
  PLUS an LLM-generated summary line (Haiku, gated on Week-3
  dogfood per F4.7).
- **HITL (Human-in-the-loop)** — the approval flow for risky agent
  actions. Hook blocks on a semaphore for ≤120 s; UI surfaces a card;
  user approves / denies / reasons. Time-out → empty response → agent
  TUI takes over. *(Source: cmux Feed pattern.)*
- **Panel** — a child of a session. v1 panel kinds: `agent`
  (Claude Code / Mock), `editor` (one open file), `diff`, `terminal`.
  Multiple agents can share a worktree via panels. *(F2.5.)*
- **Radar** — the top status bar showing every chip. The
  product's defining surface.
- **Semaphore (HITL)** — the blocking primitive backing F3.11. Hook
  process blocks on a `request_id`; UI resolution wakes it.
- **Summarizer** — the worker process that turns the last 20 lines
  of pty output + 3 hook events into the chip's summary line. Haiku
  4.5; default 30 s cadence + hook-driven; ≤120-char output.
- **Worktree-per-agent** — every agent gets its own `git worktree`
  checkout (not "one worktree per branch"). Avoids file-edit races
  between parallel agents on the same branch. Default in v1;
  opt-out via onboarding (F2.2).
- **WAAH/WAU** — Weekly Active Agent-Hours per Weekly Active User.
  The north-star metric (§9).
