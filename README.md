# baton

A desktop supervisor for many parallel AI coding agents (Claude Code,
Codex) across multiple projects. macOS, Electron. Pre-build — this repo
currently holds the spec and design only.

**Read first:** [`PRD.md`](PRD.md) — canonical product spec.

## Layout

```
PRD.md                          canonical spec (always start here)
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

W1 scaffold landed in [`app/`](app/) — Electron + React + Zustand +
typed IPC bus + SQLite + 3-column split layout. No agents yet. See
[`app/README.md`](app/README.md) for the dev path and what's
intentionally not there yet.

v0 plan in [`PRD.md` §12](PRD.md). 4-week solo build producing the
demoable radar + summary loop.

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
