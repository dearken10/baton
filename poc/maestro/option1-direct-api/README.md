# Maestro PoC — Option 1: direct Messages API

Standalone, **propose-only** proof of concept for the F15 autonomous
orchestrator spec'd in `PRD.md`. Reads live baton state, calls Haiku
4.5 with a single Messages API request, and prints the actions it
would have taken — **never executes them.** Zero npm install required.

> Looking for the umbrella that explains both options? See
> `poc/maestro/README.md`. Option 2 (Claude Code skill) lives at
> `poc/maestro/option2-claude-skill/` and `.claude/skills/maestro-tick/`.

## What this PoC proves (and doesn't)

| Aspect | PoC state |
|---|---|
| Heartbeat loop | manual (`node dry-run.mjs`); cron/timer is a v0.2 concern |
| Inventory from real `~/.baton/baton.db` | ✅ |
| Per-session conversation tail | ✅ — structured JSONL from `~/.claude/projects/<sanitized-cwd>/<id>.jsonl` for `claude-code` sessions; falls back to ANSI-stripped scrollback (`~/.baton/scrollback/<id>.bin`) for shells / codex / pre-hook sessions |
| Per-project `.baton/backlog.md` reading | ✅ |
| 5h / 7d usage % | from env (`USAGE_5H`, `USAGE_7D`); OAuth lives in baton main |
| Planner LLM call (Haiku 4.5, prompt caching) | ✅ |
| Action execution | **❌ on purpose** — propose-only |
| Checkpoint primitive (git tag + stash) | ✅ via `checkpoint-rehearsal.sh` |
| Revert primitive | ✅ via `checkpoint-rehearsal.sh revert` |
| IPC into running baton process | ❌ (v0.2 — needs the F10 channel) |

## Files

```
poc/maestro/
├── README.md                    you are here
├── prompts/
│   └── planner.system.md        Maestro's system prompt (versionable)
├── inventory.mjs                read sqlite + scrollback + backlog → JSON
├── planner.mjs                  POST inventory to Anthropic, return plan
├── dry-run.mjs                  end-to-end orchestrator + report
└── checkpoint-rehearsal.sh      F15.6 reversibility primitive in isolation
```

## Running it

```bash
# 1. Inventory only (always safe, zero external calls)
node poc/maestro/inventory.mjs --pretty | head -40

# 2. Show the planner prompt without calling the API
USAGE_5H=0.06 USAGE_7D=0.06 node poc/maestro/dry-run.mjs
# (this will stop at inventory and tell you the next command)

# 3. Full tick — calls Haiku 4.5
ANTHROPIC_API_KEY=sk-... USAGE_5H=0.06 USAGE_7D=0.06 \
  node poc/maestro/dry-run.mjs

# 4. Rehearse the reversibility primitive on a worktree
poc/maestro/checkpoint-rehearsal.sh checkpoint /path/to/some/worktree
poc/maestro/checkpoint-rehearsal.sh list
poc/maestro/checkpoint-rehearsal.sh revert <action-id>
```

After step 3, `last-inventory.json` and `last-plan.json` are written
next to the scripts so you can diff successive ticks.

## Action catalogue (PoC v0)

The planner is allowed to propose only these three kinds. Anything
else is a spec change.

### `resume`
**Pre-condition:** target session is `paused`, `idle`, or `needs-input`
**and** transcript_tail contains no HITL markers (`permission to`,
`Approve`, `Deny`, `[y/N]`).

**Sub-shapes the planner tends to produce on real data:**
- `resume.answer` — session is `needs-input` on a clear yes/no or
  enum question; the planner writes the answer.
- `resume.continue` — session is `paused` mid-task with an obvious
  next step in the transcript (`Next: …`, `TODO: …`, open task list).
- `resume.nudge` — session is `idle` and the last summary suggests
  it's waiting for the human to type something trivial.

**Reversibility:** `git tag baton/maestro/<id>/pre` + `git stash create`
on the session's worktree **before** the prompt is written. Revert =
kill agent + `git reset --hard <tag>` + `git stash apply <stash>` +
rewind the session's prompt log tail.

### `initiate`
**Pre-condition:** target project has a `.baton/backlog.md`
with at least one `- [ ] …` item under a `## TODO` heading, and no
other Maestro `initiate` action is currently in-flight against this
project.

**Reversibility:** trivial — the action *is* the worktree creation, so
revert = kill agent + `git worktree remove --force <new-wt>`. The
user's main checkout and existing worktrees are untouched by
construction.

### `defer`
**Pre-condition:** none. Used whenever:
- confidence is below 0.7
- a session is HITL-blocked (transcript markers above)
- a session is snoozed
- the planner sees something worth surfacing but can't act safely

**Side effects:** none. The defer writes one Inbox row and a
`maestro.confidence_below_floor` (or similar) telemetry event.

### Not proposed in PoC (yet)
- `resume.parallelize` — spawn a sibling worktree to attack the same
  problem from a different angle. Powerful, abuse-prone; deferred per
  the §14 open question on resume aggressiveness.
- `initiate.from-issue` — backlog source = GitHub issues. Phase 2 of
  Maestro rollout per F15.5.

## Sample backlog file

To unlock `initiate` candidates, drop a file like this at
`<project-root>/.baton/backlog.md`:

```markdown
## TODO
- [ ] add a `tfa feedback` CLI that appends to ~/.baton/feedback.jsonl
- [ ] split intentSummarizer.ts into queue + render
- [ ] write integration test for hookForwarderSource pid recycling

## DOING
- [x] master-mind — running in worktree wt-master-mind
```

The planner reads only the `## TODO` section and only `[ ]`
(unchecked) items.

## What the planner actually saw on this machine

At the moment of writing (`USAGE_5H=0.06`, 12 active sessions, 0
backlogs), the inventory included:

- 2 `needs-input` sessions (real `resume.answer` candidates — both
  with structured JSONL turn data)
- 5 `paused` sessions (mix of `resume.continue` and `defer`
  candidates depending on conversation freshness)
- 4 `running` shells (excluded — shells are never valid targets)
- 1 `running` claude-code on the active branch (excluded — the user
  is here)

That's a realistic working set. Example: the `baton/main`
`needs-input` session's JSONL tail ends with the assistant asking
*"stash pop, follow-up issues, production gaps, or the snooze
mockups. Which do you want next?"* — a textbook 4-way pick that the
planner can answer with high confidence. Compare to the same
session's scrollback tail, which would have been mostly TUI
box-drawing characters plus a partial typed prompt — much weaker
signal.

## Kill switch

There isn't one in the PoC because the PoC never executes anything.
For v0.2 (when actions wire up), the kill switch is:

```bash
# Pause all ticks
echo paused > ~/.baton/maestro.state

# Stop everything in flight + revert
poc/maestro/checkpoint-rehearsal.sh list | \
  awk 'NR>1 {print $1}' | \
  xargs -n1 poc/maestro/checkpoint-rehearsal.sh revert
```

## Next steps (v0.2 wishlist)

1. Wire `USAGE_5H` / `USAGE_7D` to the running baton's OAuth path via
   a small IPC tap (the F10 channel exists; just need a read verb).
2. Schedule the tick (`node dry-run.mjs` every 5 min) behind an
   on/off switch in `~/.baton/maestro.state`.
3. Add a Zod validator for the planner's JSON output (per F15.3
   acceptance) and drop malformed plans with telemetry, not crashes.
4. Wire the *execution* side action by action, gated by a `--apply`
   flag and the checkpoint rehearsal logic. Start with `defer` (no
   side effects), then `initiate` (cleanest revert), then `resume`
   (highest risk, do last).
5. Build the Maestro Inbox UI in the renderer to surface what the
   PoC currently dumps to stdout.

## Known limitations of the PoC

- **No de-duplication across ticks.** Run twice in 60 seconds and
  you'll get two action lists for the same situation. The cache
  (F15.3) is a v0.2 concern.
- **No tick gating on user-active.** The "is the user typing" check
  (F15.1) isn't here.
- **Planner output is trusted blindly.** Zod schema gate is v0.2.
- **No budget enforcement.** Daily action cap is v0.2.
- **Reads `~/.baton/baton.db` while the live app holds a WAL** — fine
  for reads, but the PoC opens read-only just in case.
