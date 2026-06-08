# Prior art for baton

Synthesized from source-code research of four projects in the multi-agent
coding-supervisor space. Citations point to files I verified — copy them
directly when implementing the equivalent piece.

## Quick reference

| Project | Stack | Status | Why it matters to us |
|---|---|---|---|
| **cmux** (`manaflow-ai/cmux`) | Swift/AppKit + libghostty, native Mac | Active, 21k★ | Most mature notification & hook architecture |
| **Crystal** (`stravu/crystal`) | Electron + React 19 + Zustand + better-sqlite3 | Deprecated Feb 2026 | **Almost exactly our MVP shape; code we can lift** |
| **Nimbalyst** (`Nimbalyst/nimbalyst`) | Electron, same team as Crystal | Active | Their pivot: terminal-supervisor was too thin a wedge |
| **Conductor** (`conductor.build`) | Tauri 2.6 + Rust + Bun + WKWebView + SQLite | Active, closed source | Best UX patterns we can observe from outside |
| **Zed** (`zed-industries/zed`) | Rust + custom GPUI | Active, OSS | Best architecture for editor + terminal + git + agent in one process |

---

## Patterns to adopt (in priority order)

### A. Worktree-per-agent with LLM-generated names

All three agent-supervisors (cmux, Crystal, Conductor) use one git
worktree per agent session. **Crystal's `worktreeManager.ts` is the
cleanest implementation** and we should mirror it line-for-line for the
MVP:

- `withLock('worktree-create-...')` serializes concurrent creates.
  (`main/src/services/worktreeManager.ts:72`)
- Captures base commit when creating, so we can show "diff against base".
- Falls back to `git init` + initial commit for empty repos.
- `removeWorktree` tolerates "not a working tree" errors.
- `git worktree list --porcelain` for state. (`:211`)
- LLM-generates worktree names via **Haiku** with a tight prompt
  (2–4 words, ≤30 chars) and a deterministic fallback.
  (`worktreeNameGenerator.ts`)

**For us:** drop `wt-a / wt-b` from our earlier sketch — use intent-named
worktrees from session prompt (e.g. `auth-passkeys-flow`,
`tts-retry-fix`). Same generator can produce the radar's session name.

### B. Conversation as a Panel, not a tab (Zed)

Zed's `crates/workspace/src/dock.rs:38` distinguishes **Panels** (always
present, dockable surfaces) from **Panes** (the tab tree). Conversation
is a Panel; file editors live in a `PaneGroup`.

**For us:** this confirms our split-mode design and explains why the
tabbed-mode Conversation tab feels different from file tabs — it's
structurally a Panel, not a sibling tab. Worth noting in the PRD
architecture section.

### C. Pluggable agent backend trait

Both cmux (40+ agents wired via the `AgentVault`) and Zed
(`crates/agent_servers/src/agent_servers.rs:48` `AgentServer::connect`)
have one trait that any agent CLI plugs into.

**For us:** define `AgentBackend` from day 1:
```ts
interface AgentBackend {
  id: string;                    // 'claude-code', 'codex', ...
  spawn(opts: SpawnOpts): Promise<AgentHandle>;
  resume(sessionId: string, opts: ResumeOpts): Promise<AgentHandle>;
  buildHookEnv(session: Session): Record<string, string>;
}
```
Even if MVP only ships Claude Code, the interface costs nothing and
prevents painful refactors when we add Codex.

Crystal validates this — their `AbstractCliManager`
(`main/src/services/panels/cli/AbstractCliManager.ts`) lets Claude and
Codex share one pty/lifecycle codepath.

### D. Per-agent hook contract written to disk (cmux)

cmux's hooks write `{sessionId, workspaceId, surfaceId, cwd, pid,
lifecycle, sanitizedLaunchCmd}` to
`~/.cmuxterm/<agent>-hook-sessions.json`. On relaunch the app runs
`claude --resume <id>` / `codex resume <id>` / etc. The launch-command
**sanitizer drops prompts/credentials/old session selectors** but keeps
model/sandbox/config/cwd flags. (`docs/agent-hooks.md`)

**For us:** this is both our resume mechanism *and* the radar's "what is
each agent doing right now" data source. The hooks emit:
- `SessionStart` → register session in disk map
- `PreToolUse` → emit status "running tool X"
- `Notification` → "needs input" + the prompt text
- `Stop` → "done", clear status
- `SessionEnd` → tear down disk entry

This replaces our earlier sketch of "tail pty output and infer status."
The hooks give us structured signals; we don't have to guess.

### E. Single IPC contract (cmux)

cmux: one Unix domain socket (`~/.config/cmux/cmux.sock`) with JSON-RPC-
style verbs (`feed.push`, `events.stream`, `notification.create`,
`pty.*`, `browser.*`). CLI, agent hooks, iOS companion, and tests all
speak the same socket.

**For us (Electron):** one IPC channel (Node `ipcMain` + a Unix socket
for the external CLI). Verbs like:
- `session.create | resume | pause | kill`
- `agent.status` (push)
- `feed.push` (HITL requests, see §G)
- `events.stream` (reconnectable, see §F)
- `notification.create`
- `pty.*` (when external tooling needs to attach)

### F. Reconnectable event stream with replay (cmux)

cmux exposes `cmux events --cursor-file` — a JSONL stream with
`seq` / `boot_id` / 16 KiB frame cap / 4096-event in-memory replay /
1024-event slow-consumer threshold. JSONL audit log at
`~/.cmuxterm/events.jsonl`. (`docs/events.md`)

**For us:** the LLM-summary radar should consume an event stream, not
poll. If our app process restarts, the renderer reconnects with its last
`seq` and replays missed events. Same shape for any external tooling
(menu bar app, mobile companion).

### G. Soft-wait semaphore for HITL approvals (cmux Feed)

cmux's "Feed" is the **right model for our "needs input" cards**: agent
hook blocks on a `request_id` semaphore for ≤120 s; UI wakes it via
socket reply; on timeout the hook emits `{}` so the agent's native TUI
takes over. Append-only JSONL audit at `~/.cmuxterm/workstream.jsonl`.
(`Sources/Feed/FeedCoordinator.swift`)

**For us:** the agent hook (PreToolUse, Notification) makes a blocking
socket call to the app. The app surfaces a card in the Conversation
pane. User approves/denies → hook unblocks. **Time-out → fall back to
agent's own prompt**, never freeze.

### H. Native notifications + dock badge (Crystal's mistake)

Crystal used the **renderer's** Web Notification API, which on macOS
loses focus/click affordance and badge support. Crystal hook:
`frontend/src/hooks/useNotifications.ts`.

**For us:** post notifications from the **main process** via Electron's
`new Notification(...)` and call `app.dock.setBadgeCount(unread)`. Wire
click → `BrowserWindow.focus()` + dispatch to the right session.

### I. Caller-aware notification routing (cmux)

cmux's `TerminalNotificationCallerResolver` resolves `(preferredWorkspaceId,
preferredSurfaceId, callerTTY)` to the right pane, so a stray script in
a pane notifies the *right* pane.

**For us:** every hook invocation passes `{sessionId, ppid, tty}` so the
notification surfaces in the right session card on the radar — even
when fired from a nested subprocess.

### J. Per-project setup script (Conductor)

Conductor: each project has a configurable setup script that runs on
worktree creation (`pnpm install`, copy `.env`, etc.). This solves the
real-world worktree gap: `node_modules`, `.env`, and untracked files
don't carry across worktrees and break agents immediately. **The most
consistently raised complaint across HN threads, blog posts, and
Conductor's changelog is "agents broken because the worktree was
missing `.env`/`node_modules`."** (Originally I cited this as
"Conductor's founder said #1" — that specific ranking couldn't be
independently verified.)

**For us:** ship as a first-class feature, not a polish item. Per-
project `setup.sh` (or `setup.json` with copy-files + run-commands).
Runs after `git worktree add`, before agent spawn. Output streamed to
the agent's terminal so the user sees what happened.

### K. Job queue with dedup keys for FS/git (Zed)

`crates/project/src/git_store.rs:489` `GitJobKey::{WriteIndex,
RefreshStatuses, ReloadBufferDiffBases, ReloadGitState}`. Identical
pending jobs collapse so FS bursts don't N-times-spawn `git status`.

**For us:**
```ts
type JobKey = `gitStatus:${string}` | `gitDiff:${string}` | `treeRefresh:${string}`;
const pending = new Map<JobKey, Promise<unknown>>();
```
Coalesce. Crystal claimed 40% CPU reduction from doing this for git
polling.

### L. Pure-JS git reader (cmux's CmuxGit)

cmux does **not** spawn `git` for metadata. `GitMetadataService` walks
to `.git`, parses `HEAD/index/config` directly, and exposes
`watchedPaths(for:)` so an FSEvents/chokidar watcher knows exactly when
to invalidate. (`Packages/CmuxGit/Sources/CmuxGit/GitMetadataService.swift`)

**For us:** use `isomorphic-git` for read-only branch/dirty/upstream
metadata in the renderer; reserve `simple-git`/shelling-out for write
ops (commit, push, worktree). Cuts polling cost dramatically and lets
the file tree's modified-dots update on the same tick as chokidar.

### M. Inline diff comments → agent as structured context (Conductor)

Conductor: clicking a line in the diff and adding a comment routes that
comment to the agent as **targeted context with file+line metadata**,
not as a chat message. (`docs.conductor.build/reference/diff-viewer`)

**For us:** when the user comments on a diff hunk, send to the agent as:
```
<review-comment file="src/auth/session.ts" line="42" hunk="...">
  this should use the new cookie helper, not `req.cookies` directly
</review-comment>
```
Much better than "please look at line 42, this should use…".

### N. PTY listener → channel → UI, never direct (Zed)

`crates/terminal/src/alacritty.rs:200` shows the pattern: pty events
→ mpsc channel → UI consumer → `cx.notify()`. Never write to the
terminal grid from the pty data callback.

**For us:** `node-pty.onData` → `EventEmitter`-or-bus → React/xterm
write. Lets us add the LLM summarizer as a second consumer of the same
stream without entangling write paths.

### O. Adaptive debouncing on xterm.write

Crystal explicitly noted "2800ms+ frame drops during terminal output
processing" in v0.3.1 release notes. xterm.js throughput on noisy
agents is real.

**For us:** plan from day 1:
- Coalesce pty `data` events into ~16 ms windows.
- Drop frames if `xterm.write` queue >N (the agent doesn't care if we
  render every keystroke).
- Make the summarizer consume the raw stream, not the rate-limited one.

### P. Panel = first-class, agents AND editors are panels (Crystal v0.3.4)

Crystal had to refactor "session = agent" into "session has many
panels" because users wanted Claude + Codex side by side. We should
model this from MVP:

```ts
interface Session {
  id: string;
  worktree: string;
  branch: string;
  panels: Panel[];
}
type Panel =
  | { kind: 'agent';   agentId: string; status: AgentStatus; ... }
  | { kind: 'editor';  filePath: string; ... }
  | { kind: 'diff';    against: string; ... }
  | { kind: 'terminal'; cmd?: string; ... };
```

### Q. Token cost visibility per session AND aggregate

Conductor's #1 complaint per the Medium article: 5 parallel agents = 5×
spend, and there's no pre-spawn estimate or cap. **Crystal showed
nothing here either.**

**For us:** real-time `$X.XX` per session chip on the radar (already in
mockup), plus:
- Total across all running agents in the title bar
- Daily/weekly aggregate in a small status footer
- Optional per-session cap with a soft-wait at the threshold

---

## Project-specific gems

### Conductor

- **City-name auto-named workspaces** (Raleigh, Yokohama…) — cute and
  scannable. Could pair with LLM-named worktrees: workspace gets a city,
  branch gets intent-name.
- **"Checks" tab** fusing git + CI + PR comments + todos into one
  merge-blocker view. Worth a v2 feature line.
- **Create workspace from existing PR** entry point — pick up review
  feedback flow.
- **`/resolve-merge-conflicts` slash command** — let the agent eat its
  own dogfood when streams collide. Cheap to ship, high WOW.
- **Background checkpointing off the request critical path** — auto
  git snapshots per turn for rollback, never blocks the agent.

### cmux

- **Workspace groups** (collapsible sidebar sections with anchor
  workspace, drag-to-group, per-group icon/color). Better than flat
  project list at scale.
- **Mention-completion in prompt composer** (12 files in
  `Sources/TextBoxMention*`). `@file`, `@symbol`, `@agent`.
- **Custom sidebars via a runtime Swift interpreter** — overkill for us,
  but the *idea* (user-customizable status rows per agent) is good.
  Ours: JSON config that maps hook output → sidebar row.
- **OpenTUI Feed** — a TUI mirror of the in-app Feed (`cmux feed tui`).
  Lets ops people approve prompts from a server. v2 candidate.
- **Built-in scriptable browser pane** with snapshot-a11y-tree refs —
  way out of scope, but worth noting as a direction.

### Crystal

- **Combined diff view** stacking all changed files —
  `frontend/src/components/panels/diff/CombinedDiffView.tsx`. Useful for
  "show me everything this agent touched" review mode.
- **Monaco diff editor with split/inline toggle and markdown preview
  swap for `.md` files** — `MonacoDiffViewer.tsx`. Mirror.
- **Progressive loading + 100 ms debounced batched updates +
  dashboard cache** for `ProjectDashboard.tsx`. Directly applicable to
  our radar at scale.
- **Per-session DB row + in-memory map with explicit
  `setMaxListeners(100)`** is a **warning sign, not a pattern**.
  We use Zustand selectors instead.

### Zed

- **`AcpThread` (`crates/acp_thread/src/acp_thread.rs:1213`)** is the
  cleanest abstraction I've seen for "agent turn state." Borrow the
  shape:
  - `ThreadStatus { Idle, Generating }`
  - `ToolCallStatus { Pending, WaitingForConfirmation, InProgress,
    Completed, Failed, Rejected, Canceled }`
  - Events: `NewEntry`, `EntryUpdated`, `ToolAuthorizationRequested`,
    `Retry`, `SubagentSpawned`, `Stopped`.
- **Subagent weak-refs** (`thread.rs:1175`) for cancellation
  propagation. "Kill all agents under this project" walks the tree.
- **MultiBuffer for "review N files in one editor"**
  (`crates/multi_buffer/src/multi_buffer.rs:73`). Even with Monaco, we
  can compose multiple models with synthesized headers — a *single*
  scrollable review of one agent's whole turn.
- **`StatusItemView` trait with `hide_setting`** — every status bar
  item declares how to hide itself. Right-click → hide. Great UX.
- **Engine emits granular events; UI subscribes once**
  (`thread.rs:833`). Build our renderer↔main IPC the same way:
  one `ThreadEvent` enum, exhaustive `match` on receive.

---

## Pitfalls to design around (from day 1)

| # | Pitfall | Source | Our mitigation |
|---|---|---|---|
| 1 | xterm.js write throughput collapses on noisy agents | Crystal v0.3.1 | Adaptive debounce; drop frames if queue > N |
| 2 | `git status` polling burns 40%+ CPU | Crystal v0.3.1 | Pure-JS git reader + chokidar-driven invalidation + dedup queue |
| 3 | EventEmitter/AsyncSequence/NotificationCenter leaks | cmux #5310/#5309, Crystal `setMaxListeners(100)` | Single bus + Zustand selectors; explicit cleanup; no per-component listeners |
| 4 | Renderer-side Web Notification has weak focus/click on macOS | Crystal | Main-process `new Notification` + dock badge |
| 5 | Hooks that don't fail-open break user's shell prompt | cmux #5389 (Starship) / Antigravity blocking #4768 | Hooks must be tiny, fail-open, preserve `$?` |
| 6 | Session restore destroys current state on error | cmux #4446 / #4982 / #4859 | Restore writes to a temp model first; commit only after success |
| 7 | Sidebar metadata gated on focus → stale | cmux TODO P0 | Refresh runs regardless of focused workspace |
| 8 | Deep links / IDs scoped to runtime, break on relaunch | cmux #5486 | UUID-based stable IDs from day 1 |
| 9 | Polling code is untestable without real clock | cmux `GitPollClock` | Inject `Clock` interface for every polling loop |
| 10 | Worktrees don't carry `node_modules` / `.env` → agent breaks | Conductor HN | Per-project setup script (item J above) |
| 11 | No pre-spawn cost estimate → user surprised | Conductor Medium | Daily/weekly cost in UI + optional per-session cap |
| 12 | Lifecycle signals differ per agent (Gemini doesn't emit Stop) | cmux #5501/#5502 | Each `AgentBackend` declares its own lifecycle mapping; don't assume |
| 13 | Single 420 KB god file becomes unmaintainable | cmux `TabManager.swift` | Split by feature from the start; budget per-file ≤500 lines |
| 14 | Off-main `pty_free` racing `pty_spawn` | cmux #5458 | Serialize lifecycle through a single queue per session |

---

## Big strategic note

**Crystal got deprecated.** The team behind it concluded that
"session-management-on-top-of-terminals was too thin a wedge" and
pivoted to Nimbalyst — a multi-editor workspace where AI edits land
inline across markdown, CSV, diagrams, mockups, etc.

Worth considering for our positioning:

- Our PRD says "supervisor app." That's the same wedge Crystal walked
  away from.
- Conductor's positioning is narrower (Mac dev tool, paid product) but
  they have a real distribution moat + Tauri stack.
- The space might really want either **(a) a free, fast, native
  supervisor that does one thing well** (cmux's path) or **(b) a wider
  workspace with AI throughout** (Nimbalyst's bet).

We don't have to resolve this now. But we should pick a side
deliberately rather than land in the middle.
