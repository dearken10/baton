# baton — Electron app

The v0 implementation of the PRD. Foundation + radar + summary loop are
dogfoodable; HITL, Codex, Onboarding, Remote SSH are still pending.

## Dev

```bash
cd app
npm install
npm run rebuild   # builds better-sqlite3 + node-pty against Electron's Node
npm run dev
```

Native modules (`better-sqlite3`, `node-pty`) need an Electron-aware
rebuild. The `postinstall` script attempts it; if it fails on your
machine, run `npm run rebuild` explicitly.

## Typecheck and tests

```bash
npm run typecheck
npm test
```

## Layout

```
src/
├── main/                            # Electron main process
│   ├── index.ts                     # window + lifecycle
│   ├── ipc/
│   │   └── bus.ts                   # control-channel handlers
│   ├── database/
│   │   └── index.ts                 # better-sqlite3 init + schema
│   └── services/
│       ├── sessionManager.ts        # spawn/respawn/kill, status machine
│       ├── claudeCodeBackend.ts     # ClaudeCodeBackend (--settings + hooks)
│       ├── shellBackend.ts          # plain login-shell sessions
│       ├── worktreeManager.ts       # git worktree create / list / remove
│       ├── projectStore.ts          # add / rename / snooze / reorder
│       ├── hookServer.ts            # unix-socket hook receiver (per-pid)
│       ├── hookForwarderSource.ts   # the small Node script Claude execs
│       ├── eventBus.ts              # emit() + IPC fan-out + JSONL log
│       ├── intentSummarizer.ts      # claude -p haiku one-shot summarizer
│       ├── statusTrace.ts           # ~/.baton/logs/status-trace.log
│       └── …
├── preload/
│   └── index.ts                     # contextBridge surface
├── renderer/
│   ├── index.html
│   └── src/
│       ├── main.tsx
│       ├── App.tsx
│       ├── store.ts                 # Zustand (selectors only, no leaks)
│       ├── components/
│       │   ├── LeftColumn.tsx       # project + session list + menus
│       │   ├── MiddleColumn.tsx     # editor + terminal pane
│       │   ├── NewWorktreeDialog.tsx
│       │   ├── WorktreeTerminalDialog.tsx
│       │   ├── …
│       └── styles/global.css
└── shared/
    └── ipc.ts                       # the IPC contract — source of truth
                                     # for verbs, schemas, channel names,
                                     # event types. Imported by both sides.
```

## What's intentionally NOT here yet

Tracked in [`PRD.md`](../PRD.md):

- HITL semaphore (F3.11–14) — Claude's inline permission prompts in the
  embedded pty are what users see today
- CodexBackend (F2.6) — only `ClaudeCodeBackend` + shell are wired
- Agent inbox `Cmd+Shift+I` (F3.8)
- In-app transitions-log modal (F3.10) — diagnostic data is in
  `~/.baton/logs/status-trace.log`; the UI on top of it is the gap
- Onboarding (F13)
- Remote SSH transport (F14, v1 post-v0)

## Diagnostics

When the chip "feels wrong," start here:

```bash
tail -f ~/.baton/logs/status-trace.log               # live state machine
grep "sid=<8chars>" ~/.baton/logs/status-trace.log   # one session's history
```

Categories: `HOOK_RECV`, `HOOK_DISPATCH`, `HOOK_NO_LIVE`, `HOOK_NOOP`,
`SET_STATUS`, `EMIT_STATUS`, `EMIT_SUMMARY`, `EMIT_REFRESHED`,
`SPAWN`, `EXIT`, `IDLE_SWEEP`, `SUMM_*`. The renderer mirrors
status / summary / refresh events into the DevTools console as
`[status-trace] RENDERER_*` lines so you can correlate main → renderer.
