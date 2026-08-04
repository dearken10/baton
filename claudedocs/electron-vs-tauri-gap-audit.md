# Electron → Tauri Port — Deep Discrepancy Audit

**Scope:** Exhaustive comparison of `app/` (Electron, reference) vs `app-tauri/` (Tauri port).
Covers backend services, IPC/command surface, event model, and renderer UI/UX.

**Method:** Direct source reads of both trees (not inference). File:line references included.
Electron paths under `app/src/...`; Tauri paths under `app-tauri/src{,-tauri}/...`.

**Severity:** 🔴 broken/missing · 🟡 partial/degraded · 🟢 parity · ⭐ Tauri-only improvement

---

## A. Control verbs (IPC surface)

Source of truth: Electron `src/shared/ipc.ts` `ControlVerbs` (≈60 verbs) vs Tauri
`src-tauri/src/commands/control.rs` `dispatch()`.

### A1. Verbs missing entirely (fall through to `not-implemented`)
| Verb | Sev | Notes |
|---|---|---|
| `session.setPermissionMode` | 🔴 | Tauri exposes the **old `session.toggleYolo`** instead. No graduated permission model on the backend. |
| `editor.openIn` | 🔴 | No "Open in VS Code / Cursor / Zed". |
| `shell.openTerminal` | 🔴 | No "open OS terminal at path". |
| `project.pickFolder` | 🟢* | Not a real gap — folder picking done client-side via Tauri dialog plugin (`AddProjectDialog.chooseExistingPath`). |

### A2. Verbs present but degraded
- 🟡 `session.spawn` (`control.rs:202`): request struct reads `skip_permissions` + `model` only.
  **Ignores `permissionMode`** (Electron `ipc.ts:393`) and **`parentSessionId`** (Electron `ipc.ts:401`).
  → graduated permissions + companion-shell terminals can't be requested.
- 🟡 `file.read|write|readBinary|readGitDiff|copy|rename|move|create|delete` (`control.rs:522-635`):
  none accept `sessionId`, so they **always use the local FS**. Electron routes these through the
  session's `Fs` (Local vs Remote) via `sessionId` (`ipc.ts:583,610` etc.).
- 🟡 `worktree.fileTree|readDir|gitStatus|search` + `git.*`: resolve a plain local `PathBuf`
  (`control.rs:resolve_worktree_root`, 982) → remote worktrees never read over SSH.
- 🟡 `project.create`: local only; remote create deferred (`control.rs:118`).

### A3. Tauri-only verbs (not in Electron)
- `session.toggleYolo` (legacy binary YOLO; superseded in Electron by `setPermissionMode`).
- `worktree.create` (Electron creates worktrees only via `session.spawn` `newWorktreeBranch`).

---

## B. Event model

Electron emits **19 granular events** (`ipc.ts` `AppEvent`); Tauri emits **~15 coarser** ones
(`types.rs` `AppEvent`, `event_bus.rs`). Tauri's Rust + shim (`shim/types.ts`) + store
(`store.ts`) all agree on the coarser names, so it's internally consistent — but lossy.

| Capability | Electron | Tauri | Sev |
|---|---|---|---|
| Status transition | `session.status_changed {from,to}` | `session.statusChanged {whole session}` | 🟡 loses from/to |
| Token updates | `session.tokens_updated` | folded into statusChanged | 🟡 see D2 (never fires) |
| Summary | `session.summarized` | `session.summaryChanged` | 🟢 |
| Generic refresh | `session.refreshed` | — | 🟡 |
| Optimistic start | `session.starting` (+ `session.list.startingIds`) | — (`startingIds:[]`, `control.rs:200`) | 🟡 no boot "Starting…" |
| New prompt | `session.prompt_submitted` | — | 🟡 TurnsPane can't refresh on prompt |
| Rename | `session.renamed` | reuses statusChanged | 🟢 |
| Worktree FS change | — (3s renderer poll) | `worktree.changed` (real watcher) | ⭐ Tauri better |
| Exit | `session.exited {exitCode}` | `session.ended {exitCode}` | see D3 |

---

## C. Session manager — `session_manager.rs` (1163) vs `sessionManager.ts` (1898)

Tauri implements spawn/resume/respawn/clone/kill/delete/rename/reorder/snooze/setModel/
toggleYolo/auto-resume/reconcile/hook-state-machine. Gaps:

### C1. 🔴 Token accounting never updates (D2 detail)
`transcript_reader.rs:36 read_transcript_usage()` exists but **has zero callers**
(grep: only def site). Electron recomputes tokens on every `Stop` hook
(`sessionManager.ts:1398-1449 recomputeTokensFromTranscript` → `UPDATE sessions SET tokens_in/out`
→ emit `session.tokens_updated`). In Tauri, `tokens_in/out` are written only as `0` at INSERT and
never updated → **sidebar token counts are always 0**.

### C2. 🔴 `last_active_at` does not exist in Tauri
No DB column, no `Session` field, never selected (`session_manager.rs:90-116 session_row`).
Electron maintains it (`bumpActivity`) and the **Timeline view sorts by it**
(`LeftColumn.tsx` `b.lastActiveAt - a.lastActiveAt`). Tauri's shim type has optional
`lastActiveAt?` (`shim/types.ts:51`) but the backend never sends it → timeline ordering is
undefined/unstable.

### C3. 🔴 `errored` status never surfaced on exit
Both the pty-exit closures (`session_manager.rs:333,393,443`) and the store's `session.ended`
handler (`store.ts:198` → hardcodes `status:'done'`) ignore the exit code. Electron sets
`done` vs `errored` from exit code (`store.ts` exited: `exitCode===0?'done':'errored'`).
→ failed/crashed sessions render as a clean "done".

### C4. 🟡 `clone_session` is not a true fork
`session_manager.rs:663` copies the row but **reuses the same `claude_session_id`**, so both the
original and the clone `--resume` the **same** transcript (code comment admits this). Electron
copies the on-disk transcript under a fresh agent id so the trunk is untouched
(`ipc.ts:437` SessionClone contract). → cloning can cross-contaminate the original conversation.

### C5. 🟡 Hook state machine is simplified
`handle_hook_event` (`session_manager.rs:1031`) maps SessionStart/UserPromptSubmit/PreToolUse→running,
Notification→needs-input, Stop→idle, SessionEnd→done. Electron's machine
(`sessionManager.ts:1770-1860`) additionally: tracks per-tool pending state, suppresses stale
`needs-input`, handles pure-text responses, recomputes tokens on Stop. No `PostToolUse`/
`SubagentStop`/`PreCompact` handling either side, but Electron's transitions are richer.

### C6. 🟡 No pause/resume → no `paused` status
Electron's pty handle supports `pause()`/`resume()` via SIGSTOP/SIGCONT
(`claudeCodeBackend.ts:363-374`); the `paused` status depends on it. Tauri `PtyHandle`
(`claude_code_backend.rs:45`) has only write/resize/kill.

### C7. 🟡 No `disconnected` status for remote
Remote pty exit closure (`session_manager.rs:225`) sets `done`. Electron tracks a
`disconnected` state from SSH master health (`ipc.ts:33`, surfaced in RightColumn banner).

---

## D. Agent backends

### D1. Claude — `claude_code_backend.rs` (279) vs `claudeCodeBackend.ts` (393)
- 🟢 Hook settings file, `--settings`, `--resume`, `--model`, BATON_SESSION_ID/HOOK_SOCK env,
  trust pre-seed, full env inheritance — all faithful.
- 🔴 **No `--permission-mode`**: only `skip_permissions → --dangerously-skip-permissions`
  (`claude_code_backend.rs:132`). plan/acceptEdits/auto unreachable.
- 🟡 **No `isInstalled()` probe** (Electron `claudeCodeBackend.ts:58`): missing `claude` yields a
  raw spawn error, no friendly message.
- 🟡 No pause/resume (see C6).

### D2/D3 covered above (tokens, errored).

*(Codex / shell / hook server / remote backend audited in section H — appended below.)*

---

## E. Renderer — Middle column 🔴 (largest UI gap)

`MiddleColumn.tsx` Tauri **113 lines** vs Electron **625**. Missing vs Electron:
- 🔴 **Permission-mode chip** (entire dropdown absent; no `permissionMode` reference anywhere in
  Tauri `src/`).
- 🔴 **Model-selection chip** (Sonnet/Opus/Haiku + pinned versions).
- 🔴 **Companion terminal tabs** (＋ add / × close / reopen shells in the agent worktree).
- 🔴 **Session-info (ⓘ) dialog trigger** (component exists, never opened here).
- 🔴 **Header label** `project · branch`.
- 🟡 **"Session ended" panel**: Electron offers *Resume conversation* / *Start fresh* + status/
  ended-at; Tauri shows static text. Also only checks `status==='done'`, not `errored`
  (`MiddleColumn.tsx:35`).
- 🟡 **Editor tabs are global** (`store.editorTabs`) not **per-session** (`editorBySession` in
  Electron) → switching sessions doesn't switch tab sets.

---

## F. Renderer — Editor 🟡 (different engine)

Tauri EditorPane is **CodeMirror 6** (`@codemirror/lang-*`), Electron is **Monaco**
(457 vs 1084 lines).
- 🔴 **No side-by-side diff**: `diff` tabs render read-only working copy + state badge
  (`EditorPane.tsx:247`), no HEAD-vs-working two-pane, no dirty-diff gutter.
- 🔴 **No rendered Markdown preview** (no `marked`; only `@codemirror/lang-markdown` highlighting;
  no Source⇄Preview toggle).
- 🔴 **No external-editor handoff** (ties to missing `editor.openIn`).
- 🟢 Image/binary viewer + in-app browser/weburl `<iframe>` tabs present.

---

## G. Renderer — Remote/SSH 🟡 (backend ahead of UI)

- 🟢 Backend connection CRUD/test/testPath/reconnect/listDir + ControlMaster pool + remote
  Claude spawn all implemented (`control.rs:849-957`).
- 🔴 **No UI to create/manage connections**: `NewConnectionDialog.tsx` exists but is **mounted
  nowhere**; `AddProjectDialog.tsx` is local-only (no "Run on" connection picker, no
  `RemoteFolderPicker`, no path "Validate"/`testPath`, no `listDir`).
- 🔴 **`RemoteFolderPicker.tsx` not ported** (Electron-only).
- 🟡 Net: remote project unaddable via UI; even if seeded, right-column inspector reads local FS
  (see A2). The faithfully-ported RightColumn disconnect banner is effectively unreachable.

---

## H. Notifications & misc (renderer)
- 🟢 Native notification + dock badge on needs-input/errored (`notifier.rs`).
- 🔴 **Notification-click → focus session is a no-op** (`shim/baton.ts:69 onSelectSession`
  returns `() => {}`; no `select-session` channel).
- 🟢 Parity: LeftColumn (timeline/project views, drag-reorder, snooze, codex/worktree spawn menu,
  OrphansBadge), RightColumn tabs, Files/Git/Search panels, UsageBars (Claude+Codex), scrollback,
  worktree list/orphans, git stage/unstage/commit/push/pull.

---

## I. Intent summarizer — `intent_summarizer.rs` (121) vs `intentSummarizer.ts` (287)
- 🟢 Agent-prompt summary via `claude -p --model haiku`, prev-summary continuity — faithful.
- 🟡 **No `summarizeTerminal`**: Electron gives **shell** sessions an LLM intent chip from terminal
  output (`intentSummarizer.ts:252`); Tauri only summarizes agent prompts → shell sessions get no
  intent label.
- 🟡 Triggers on UserPromptSubmit only; Electron also re-summarizes on Stop from the transcript.

---

## J. Codex / shell / hook / remote backends
- 🟢 **Codex** (`codex_backend.rs` 228 vs `codexBackend.ts` 205): faithful — per-session profile
  TOML, `--profile`, `--dangerously-bypass-hook-trust`, `--cd`, `resume` subcommand, YOLO →
  `--dangerously-bypass-approvals-and-sandbox`, no SessionEnd hook (pty exit drives EoL). Parity.
- 🟢 **Shell** (`shell_backend.rs` 140 vs 130): parity; emits `SessionEnded` on exit.
- 🟢 **Hook server** (`hook_server.rs` 297 vs `hookServer.ts` 182): Unix + TCP listeners, forwarder
  script write, fail-open 1500 ms, newline-JSON protocol. ⭐ Adds stale-socket sweep. Parity+.
- 🟢 **Hook forwarder** (`hook_forwarder.rs` vs `hookForwarderSource.ts`): same script. Parity.
- 🟢 **Remote Claude** (`remote_claude_backend.rs`): SSH probe, remote settings + forwarder write,
  remote trust pre-seed, reverse-forward hook bridge — faithful to `claudeCodeBackend.spawnRemote`.
  (Reachability blocked by the missing connection UI — see G.)

## K. FS / git / worktree / search
- 🟢 `git_ops.rs`: stage/unstage/commit/push/pull all present. Parity.
- 🟢 `worktree_manager.rs` (286 vs 275): create/list/remove/rename + setup-script on create. Parity.
  ⭐ Setup-script (`setup_script.rs`, PRD F1.4) is wired via `worktree_manager.rs:113`.
- 🟢 `worktree_reader.rs` (426 vs 435): file tree (depth cap) + git status. Parity.
- 🟢 `search.rs` (267): `git grep` with case/word/regex/glob/maxMatches. Parity.
- 🟡 `file_ops.rs` (478): read/write/binary/diff/copy/rename/move/create/delete/reveal/openPath all
  present **but local-only** (no `sessionId`/Fs routing — see A2). Trash-on-delete parity to verify.

## L. Transcript / turns / usage
- 🟢 `session_turns.rs` (393 vs 303): structured per-prompt turns (user/progress/recap). Parity+.
- 🟢 `transcript_reader.rs` / `codex_transcript_reader.rs`: parity readers — **but
  `read_transcript_usage` is never called** (see C1: token totals never updated).
- 🟢 `claude_usage_api.rs` (215) / `codex_usage_api.rs` (201): OAuth usage endpoint, 5-min cache,
  `force` bypass. Parity. ⭐

## M. Stores / DB / trust / setup / event bus / Electron-only services
- 🔴 **DB schema** (`db.rs` 152 vs `database/index.ts` 237): Tauri `sessions` table **lacks
  `permission_mode`, `last_active_at`, `parent_session_id`** columns (Electron adds all three:
  `database/index.ts:163,178,201`). Root cause of E (perm chip / companion tabs) and C2 (timeline).
- 🔴 **`lifecycleQueue.ts` not ported**: Electron serializes per-session spawn/pause/resume/kill
  (`sessionManager.ts:216`) to prevent pty-spawn-vs-free races (cmux #5458). Tauri mutates the
  `live` map directly — logical races on rapid spawn/kill/respawn are possible.
- 🔴 **`app.setSelectedSession` never called by the renderer** (Tauri `App.tsx` boot only).
  Backend verb + `notifier.set_selected_session` exist but are dead → notifications are **not**
  suppressed for the focused session, and unread badge isn't cleared on focus. Electron wires it
  (`App.tsx:106`).
- 🔴 **Notifier click → focus session** deferred (`notifier.rs:13` "see #27"); Electron focuses
  window + sends `select-session` (`notifier.ts:88,105`). Pairs with the no-op shim (H).
- 🟡 **Event envelope dropped**: Electron events carry `{seq, bootId, ts}` for ordering + cross-boot
  dedup (`ipc.ts EventEnvelope`); Tauri `AppEvent` (`types.rs`) has none → no seq ordering / boot
  dedup. Low severity.
- 🟡 **`project_store.rs`** (197 vs 274): missing `defaultProjectsParent()` (suggested parent for
  "Create new") and remote `createProject`. Otherwise parity.
- 🟢 `notifier.rs`, `claude_trust.rs`, `codex_trust.rs`, `setup_script.rs`, `connection_store.rs`,
  `remote_fs.rs`, `ssh_connection.rs`, `fs_registry.rs`, `event_bus.rs` (2-channel fan-out): parity.
- ⚪ `statusTrace.ts` (Electron debug tracing) → Tauri uses the `tracing` crate. `agentBackend.ts`
  (the AgentBackend interface/registry) → inlined in Rust. Both are non-gaps.

## N. Remaining renderer (components / store / libs)
- 🟢 **TerminalPane** (240 vs 325): WebGL + context-loss fallback, WebLinks→in-app browser,
  SerializeAddon scrollback, theme subscribe — near-parity. Neither app has terminal search.
- 🟡 **Scrollback retention**: Tauri live ring is **256 KB** (`scrollback.rs:21 RING_BYTES`); Electron
  caps the serialized buffer at **5 MB** (`bus.ts:719`). Tauri replays much less history.
- 🟡 **Editor state model**: Tauri store uses a **global** `editorTabs[]` + `activeTabId`
  (`store.ts:38`) and does **not** persist tabs to localStorage; Electron uses **per-session**
  `editorBySession` persisted across restart (`store.ts:39,LS_KEY`).
- 🟢 **FilesPanel / GitPanel / SearchPanel / TurnsPane**: verb-for-verb parity with Electron
  (file.* / git.* / worktree.search / session.turns).
- 🟢 Dialogs present: NewWorktreeDialog, NewTerminalDialog, PromptDialog, SessionInfoDialog,
  OrphansBadge, FileContextMenu, JsonTreeView, ThemeToggle, Titlebar — parity.
- 🔴 Dialogs missing/dead: **RemoteFolderPicker** (not ported); **NewConnectionDialog** (exists,
  mounted nowhere) — see G.

---

## Consolidated priority matrix

| # | Severity | Area | Discrepancy | Key refs |
|---|---|---|---|---|
| 1 | 🔴 P0 | Permissions | No graduated permission model — verb (`setPermissionMode`), spawn arg, `--permission-mode` flag, DB column, and UI chip all absent; only binary YOLO | control.rs, claude_code_backend.rs:132, db.rs, MiddleColumn |
| 2 | 🔴 P0 | Sessions | Companion shell terminals non-functional — `parentSessionId` dropped at spawn, no DB column, no tab UI | control.rs:202, db.rs, MiddleColumn |
| 3 | 🔴 P0 | Remote | Unusable from UI — no NewConnectionDialog mount, no connection picker / RemoteFolderPicker in AddProjectDialog; file ops local-only | G, A2 |
| 4 | 🔴 P0 | Tokens | Token totals never update (`read_transcript_usage` unwired) → sidebar always 0 | C1 |
| 5 | 🔴 P1 | Status | `errored` never surfaced (exit always → done); no `paused`/`disconnected` | C3,C6,C7 |
| 6 | 🔴 P1 | Timeline | `last_active_at` absent → timeline ordering undefined | C2 |
| 7 | 🔴 P1 | Editor | No side-by-side diff, no markdown preview, no external-editor open | F |
| 8 | 🟡 P1 | Middle col | No model chip / session-info / rich ended-session panel; global (not per-session) editor tabs | E |
| 9 | 🟡 P1 | Clone | `clone_session` shares transcript (not a true fork) — can corrupt trunk | C4 |
| 10 | 🟡 P2 | Notifs | Focused-session suppression + click-to-focus not wired | M, H |
| 11 | 🟡 P2 | Robustness | No LifecycleQueue (spawn/kill races); coarser hook state machine; no event seq/bootId | M, C5 |
| 12 | 🟡 P2 | Misc | Shell sessions get no intent summary; 256 KB vs 5 MB scrollback; editor tabs not persisted | I, N |
| — | ⭐ | Worktree | Real FS watcher (`worktree.changed`) vs Electron 3 s polling | B |

**Net:** the Tauri backend is a broadly faithful port of the *core* (spawn/pty/hooks/git/worktree/
search/usage/remote-spawn), but it tracks an **older feature generation** — pre-`permissionMode`,
pre-`parentSessionId`, pre-`last_active_at` — and the renderer is **substantially thinner**
(MiddleColumn, EditorPane, AddProjectDialog). The highest-leverage fixes are schema-first:
add the three missing columns, then wire the verbs + UI that depend on them.
