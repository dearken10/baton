# Pain Points: Managing Multiple Parallel Claude Code Sessions

## Context

I run multiple Claude Code sessions in parallel, each opened inside a separate
VS Code window for a different project. Throughout the day I bounce between
them as they work on long-running tasks.

## Pain Points

### 1. No global view of what every session is doing

There is no single place that shows "here are all my active Claude Code
sessions and what each one is currently working on." Each session's state is
trapped inside its own terminal pane, inside its own VS Code window.

### 2. Cannot monitor status without physically visiting each session

To find out whether a session is:
- still thinking / running a tool,
- waiting on a permission prompt,
- blocked on a question,
- finished and idle, or
- crashed / errored out,

…I have to alt-tab to that specific VS Code window, click into the right
terminal tab, and read the screen. There is no ambient indicator.

### 3. Lost track of which session is doing which job

When I have 4–6 sessions going, I forget which window corresponds to which
task. The VS Code window title shows the project, not the prompt I gave
Claude. I end up opening windows just to remember "oh right, this one is
refactoring the auth module."

### 4. Round-robin polling is the only workflow

My current loop is literally: cycle through every VS Code window → click the
terminal → read → move on. This scales badly. With 5 sessions and a 30s check
cadence, I spend a meaningful fraction of my time just *checking*.

### 5. Permission prompts can sit unanswered for a long time

Because I'm not watching, a session that hits a permission prompt (e.g. "allow
this Bash command?") can stall for many minutes before I notice. The session
is doing nothing, but I don't know that until I rotate back to it.

### 6. No notification when a session needs me or finishes

There's no push signal — no sound, no system notification, no badge — when a
session:
- completes its task,
- needs input,
- errors out.

Everything is pull-based, and I am the one doing the polling.

### 7. Terminal output is ephemeral and hard to skim

Even when I do visit a session, the terminal scrollback is a wall of text.
There's no "current status" line I can glance at — I have to read the last
several messages to reconstruct what's happening *right now*.

## What I want (rough shape, not a spec)

A single surface — a dashboard, a menubar app, *something* — that:

- lists every active Claude Code session across all my VS Code windows,
- shows each session's current status at a glance (running / waiting on
  permission / waiting on input / idle / errored),
- shows what task each session is working on (the last user prompt, or a
  short summary),
- notifies me when a session needs attention or finishes,
- lets me jump directly to the relevant VS Code window/terminal from there.

## Prior art tried

### cmux (https://github.com/manaflow-ai/cmux)

Tried it. Covers the **monitoring** half of the problem well:

- Sidebar lists every pane with git branch / PR status / working dir / ports.
- Blue notification ring on panes needing attention.
- `cmux notify` + Claude Code hooks → native macOS notifications.
- Cmd+Shift+U jumps to most recent unread.

What it does **not** cover (and what I still need):

- **No project/file view.** It's a terminal multiplexer, not an IDE. I can't
  browse the repo's file tree from inside cmux.
- **No diff / "what changed" view.** When a session edits files, I want to
  see the diff inline without dropping into another tool.
- **Git UI beyond branch/PR status.** I want stage / commit / log / blame —
  the things VS Code's source control panel gives me — next to the agent
  pane.

## Updated requirements

On top of the monitoring dashboard (which cmux mostly nails), I also need,
side-by-side with each agent session:

- a **file tree** rooted at that session's project,
- a **live diff view** of uncommitted changes the agent is making,
- **basic git operations** (stage, commit, view log, switch branch).

In other words: cmux's multi-agent sidebar + a lightweight IDE-ish project
pane per session. Either as one integrated tool, or cmux + a sibling tool
that opens to the same working directory.
