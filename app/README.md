# baton — Electron app

W1 scaffold of the v0 plan (PRD §12). Foundation only — no agents,
no terminal, no Monaco yet. Ships:

- Electron main process + sandboxed renderer (NF6).
- Single typed IPC bus with Zod schemas (F10.1) + a placeholder for
  the separate `pty.data` channel (F10.2).
- SQLite database (better-sqlite3, WAL) at `~/.baton/baton.db`.
- React + Zustand renderer with the 3-column split layout from
  `design/mockup-split.html`.

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

## Typecheck

```bash
npm run typecheck
```

## Layout

```
src/
├── main/           # Electron main process
│   ├── index.ts            # window + lifecycle
│   ├── ipc/
│   │   └── bus.ts          # control-channel handlers
│   ├── database/
│   │   └── index.ts        # better-sqlite3 init + schema
│   └── services/           # session manager, worktree, pty (W2-W3)
├── preload/
│   └── index.ts            # contextBridge surface — the only API
│                           # the renderer can see
├── renderer/
│   ├── index.html
│   └── src/
│       ├── main.tsx
│       ├── App.tsx
│       ├── store.ts        # Zustand (selectors only, no leaks)
│       ├── components/
│       └── styles/global.css
└── shared/
    └── ipc.ts              # the IPC contract — source of truth
                            # for verbs, schemas, channel names,
                            # event types. Imported by both sides.
```

## What's intentionally NOT here yet

W2–W4 territory:
- AgentBackend + ClaudeCodeBackend + CodexBackend.
- node-pty wiring + xterm renderer + adaptive debounce.
- Summarizer worker thread.
- Worktree manager.
- HITL semaphore.
- Native notifications + dock badge.
- Monaco editor.
- isomorphic-git read path + simple-git write path.
- Onboarding (F13).
- Remote SSH transport (F14, v1 post-v0).
