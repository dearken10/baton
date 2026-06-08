# Design Mockup: baton

ASCII wireframes for the main views. Targets a 1440×900 macOS window.

## 1. Default three-pane layout

```
┌───────────────────────────────────────────────────────────────────────────────────────────────────┐
│ baton                                                          ⌘K  ⚙  ☰ 3 unread       │
├───────────────────────────────────────────────────────────────────────────────────────────────────┤
│ AGENT RADAR                                                                                       │
│ ┌───────────────────────────┐ ┌───────────────────────────┐ ┌───────────────────────────┐         │
│ │ ⏵ llm-docker · tts-fix    │ │ ⚠ web-app  · feat/auth    │ │ ✓ infra     · main        │ ┌─────┐ │
│ │ Editing TTS service to    │ │ Waiting: allow `rm -rf    │ │ Done. 3 files changed,    │ │ +   │ │
│ │ handle 429 retries…       │ │ node_modules`?            │ │ ready for review.         │ │ new │ │
│ │ 00:02:14   $0.18          │ │ 00:00:31                  │ │ 00:08:42   $0.42          │ └─────┘ │
│ └───────────────────────────┘ └───────────────────────────┘ └───────────────────────────┘         │
│ ┌───────────────────────────┐ ┌───────────────────────────┐                                       │
│ │ 🔴 mobile   · ios/onboard │ │ ⏸ docs     · main         │                                       │
│ │ Errored: xcodebuild exit  │ │ Paused                    │                                       │
│ │ 65. Last output 02:11 ago │ │                           │                                       │
│ │ 00:14:02   $1.04          │ │ 00:00:00                  │                                       │
│ └───────────────────────────┘ └───────────────────────────┘                                       │
├──────────────┬──────────────────────────────────────────────┬─────────────────────────────────────┤
│ PROJECTS     │ EDITOR                                       │ AGENT SESSION                       │
│              │                                              │                                     │
│ ▾ llm-docker │ ╭──────────────────────────────────────────╮ │ ▾ tts-fix (selected)                │
│   ▾ src      │ │ text-to-speech-response.service.ts × │ Δ │ │   branch: tts/fix-retries           │
│     │└ svc.ts│ ├──────────────────────────────────────────┤ │   worktree: ~/.../wt/tts-fix        │
│     │  svc…te│ │  42  async generateAudio(text: string){  │ │   status: ⏵ running   $0.18         │
│   ▸ tests    │ │  43    try {                             │ │   summary: Editing TTS service to   │
│   ▸ node_mod │ │  44      return await this.synth(text)  │ │   handle 429 retries.               │
│   package.js │ │  45    } catch (e) {                     │ │ ─────────────────────────────────── │
│              │ │  46+     if (e.status === 429) {         │ │ > /edit src/text-to-speech...       │
│ ▾ web-app    │ │  47+       await backoff(1_000);         │ │                                     │
│   ▸ src      │ │  48+       return this.synth(text);     │ │   ⏺ I'll add a retry with exp.      │
│   ▸ public   │ │  49+     }                               │ │     backoff for 429 responses.      │
│              │ │  50      throw e;                        │ │                                     │
│ ▾ infra      │ │  51    }                                 │ │   ● Edit(src/.../svc.ts)            │
│   ▸ terra    │ │  52  }                                   │ │     +12 -3                          │
│              │ ╰──────────────────────────────────────────╯ │                                     │
│ ▾ mobile     │ Files · Editor · Diff                        │ ──────── input ───────────────────  │
│   ▸ ios      │                                              │ >                                   │
│              │                                              │                                     │
│ + Add proj…  │                                              │ Tabs:  tts-fix · +new agent         │
└──────────────┴──────────────────────────────────────────────┴─────────────────────────────────────┘
```

Status icon legend:
- `⏵` running  ·  `⚠` needs input  ·  `✓` done idle  ·  `🔴` errored  ·  `⏸` paused

Each radar chip shows: status icon, project, branch, one-line LLM
summary, elapsed-in-status, accumulated token spend. Clicking a chip
selects that agent in the right pane and opens its worktree in the
center pane.

## 2. Status chip — anatomy

```
┌─────────────────────────────────────────┐
│ ⚠  web-app  · feat/auth                 │  ← project · branch
│                                         │
│ Waiting: allow `rm -rf node_modules`?   │  ← LLM summary (1 line, ellipsized)
│                                         │
│ 00:00:31           $0.42                │  ← time-in-status · spend
└─────────────────────────────────────────┘
   │                                  │
   border color encodes status        click → focus this session
```

Colors (light theme):
- running → blue
- needs-input → amber (also pulses)
- done → green
- errored → red
- paused → gray

## 3. Diff view (center pane mode)

```
┌──────────────────────────────────────────────────────────────────┐
│ Diff: tts-fix worktree vs. origin/main                           │
│ Files · Editor · Diff (selected)                                 │
├─────────────────────────┬────────────────────────────────────────┤
│ Changed files (3)       │ src/.../svc.ts                         │
│ ─────────────────────── │                                        │
│ ● src/.../svc.ts +12 -3 │ ─── before ─────  ─── after ────       │
│   src/.../svc.test  +8  │  43  try {        43  try {            │
│   CHANGELOG.md      +2  │  44    return…    44    return…        │
│                         │  45  } catch (e){ 45  } catch (e){     │
│                         │                   46+   if (e.status…  │
│                         │                   47+     await back…  │
│                         │  46    throw e    50    throw e        │
│                         │                                        │
│ [Stage all] [Commit…]   │  [Stage hunk]  [Discard hunk]          │
└─────────────────────────┴────────────────────────────────────────┘
```

## 4. New agent dialog

```
┌─ New agent on llm-docker ──────────────────────────────┐
│                                                        │
│  Branch                                                │
│  ( ) Existing:  [ main ▾ ]                             │
│  (●) New:       tts/fix-retries-v2                     │
│                                                        │
│  Worktree                                              │
│  Auto-create at ~/.baton/worktrees/llm-docker/tts-fix-v2 │
│                                                        │
│  Initial prompt (optional)                             │
│  ┌──────────────────────────────────────────────────┐  │
│  │ Add exponential backoff to the TTS retry path.   │  │
│  │                                                  │  │
│  └──────────────────────────────────────────────────┘  │
│                                                        │
│             [Cancel]            [Start agent →]        │
└────────────────────────────────────────────────────────┘
```

## 5. Notification (macOS)

```
┌──────────────────────────────────────────┐
│ baton                          │
│ web-app · feat/auth needs your input     │
│                                          │
│ "Allow `rm -rf node_modules`?"           │
│                                          │
│                       [Dismiss] [Focus]  │
└──────────────────────────────────────────┘
```

## 6. Empty state (first launch)

```
┌────────────────────────────────────────────────────────────────┐
│                                                                │
│                   Welcome to baton                   │
│                                                                │
│           One window. Every project. Every agent.              │
│                                                                │
│                                                                │
│                  ┌────────────────────────┐                    │
│                  │   + Add your first      │                   │
│                  │      project folder      │                  │
│                  └────────────────────────┘                    │
│                                                                │
│            or drag a folder onto this window                   │
│                                                                │
└────────────────────────────────────────────────────────────────┘
```

## 7. Interaction notes

- **Pane resizing:** three vertical splitters between Projects / Editor /
  Agent. Status Bar is a fixed height (~140px) but collapsible to a
  one-line strip when many agents are running.
- **Many agents:** Status Bar wraps to multiple rows, then becomes
  horizontally scrollable past ~10 chips.
- **Keyboard:**
  - `Cmd+K` — command palette (jump to project, agent, file).
  - `Cmd+1…9` — focus the Nth agent chip.
  - `Cmd+Shift+U` — jump to next unread (needs-input or errored).
  - `Cmd+S` — save current editor tab.
  - `Cmd+Enter` — submit input to focused agent terminal.
- **Drag:** drag a chip onto the editor pane → opens that agent's
  worktree as the editor root.

## 8. Visual tone

- Dense but breathable — closer to Linear than to VS Code.
- Monospace for terminal + summaries, sans-serif (Inter) for chrome.
- Dark mode default. Status colors keep meaning in both themes.
- No skeuomorphism. Subtle shadows on chips; no gradients.
