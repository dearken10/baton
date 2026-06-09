# baton

A desktop supervisor for many parallel AI coding agents (Claude Code,
Codex) across multiple projects. macOS, Electron.

**Read first:** [`PRD.md`](PRD.md) — canonical product spec.

## Layout

```
PRD.md                          canonical spec (always start here)
app/                            the Electron app — see app/README.md
docs/
  pain-points.md                origin doc — why we're building this
  prior-art.md                  research synthesis (cmux / Conductor /
                                Crystal / Zed) with patterns to adopt
                                and pitfalls to avoid
  team-synthesis.md             round-1 decision doc (split-only, hybrid
                                summary, ICP scope, etc.)
  team/                         frozen specialist outputs that informed
                                the PRD — historical, do not edit
    pm-additions.md
    positioning.md
    design-review.md
    research-brief.md
    metrics-plan.md
    architecture-review.md
design/
  mockup.md                     ASCII wireframes
  mockup.html                   main 3-column prototype (the canonical
                                visual reference)
  mockup-split.html             the v1 split layout
  mockup-onboarding.html        first-run flow
  mockup-new-agent.html         new-agent dialog
  mockup-command-palette.html   Cmd+K (v1.1)
  mockup-collapsed-sessions.html  dense radar at 15+ sessions
```

## Status

Working v0 in [`app/`](app/). The radar + summary loop is dogfoodable:

- Claude Code backend with per-session pty + xterm renderer
- Shell ("terminal") sessions in the project root or any existing worktree
- Worktree-per-agent with optional `setup.sh` run after `git worktree add`
- Hook-driven status state machine (`SessionStart` / `UserPromptSubmit` /
  `PreToolUse` / `Notification` / `Stop` / `SessionEnd`)
- Haiku-powered intent summaries on the chip
- Token + 5h-window plan usage
- Per-project and per-session snooze, with auto-unsnooze on next prompt
- Light / dark theme
- Monaco editor + file tree + git status panel
- Native macOS notifications

Not yet built (tracked in [`PRD.md`](PRD.md)):

- HITL approval cards (F3.11–14) — Claude's inline permission prompts are
  what you see today
- Codex backend (F2.6)
- Agent inbox `Cmd+Shift+I` (F3.8)
- In-app transitions-log modal (F3.10) — the file at
  `~/.baton/logs/status-trace.log` is the underlying data
- Onboarding flow (F13)
- Remote SSH (F14)

## Viewing the mockups

`open design/mockup.html` (etc.). All mockups are standalone HTML,
dark theme, no build step.

## Running the app

```bash
cd app
npm install
npm run dev
```

See [`app/README.md`](app/README.md) for the rebuild-native-modules
caveat.
