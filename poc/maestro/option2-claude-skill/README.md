# Maestro PoC — Option 2: Claude Code skill

Instead of a one-shot Messages API call (option 1), this option drives
the planner from **inside a Claude Code session** via the skill at
`.claude/skills/maestro-tick/SKILL.md`. Same `last-plan.json` shape;
different "how it decides."

> Looking for option 1 (single API call, Haiku 4.5)? See
> `../option1-direct-api/`. Looking for the umbrella that compares
> both? See `../README.md`.

## How to run it

Open a **fresh Claude Code session** at the repo root and type:

```
/maestro-tick
```

That's it. The skill discovers and the agent:
1. Calls `node poc/maestro/option1-direct-api/inventory.mjs` to get
   the inventory JSON (cheap path; the skill explains the expensive
   alternative if you want richer signal).
2. Applies the F15.1 runtime gate (drops `running` claude-code/codex
   sessions and shells).
3. Detects HITL-blocked sessions (Step 3 in the skill).
4. Decides one action per remaining session.
5. Writes the plan to `poc/maestro/option2-claude-skill/last-plan.json`.
6. Prints a short summary.

## Why this option is interesting

| | Option 1 (Messages API) | Option 2 (Claude Code skill) |
|---|---|---|
| Caller | Node script via cron / IPC | Claude Code session, interactive |
| Driver model | Haiku 4.5 (fixed) | Whatever model you're running Claude Code with (Opus / Sonnet / Haiku) |
| Inventory | Pre-bundled by `inventory.mjs` | Skill can also choose to read sqlite, scrollback, JSONL, `git log`, dirty-files directly — agent decides depth |
| Round-trips | One | Several (Bash, Read, Write) |
| Latency | ~3 s | ~30–60 s |
| Cost / tick | ~$0.015 (Haiku) | scales with driver model + exploration |
| Iteration | Edit prompt MD, rerun script | Edit skill MD, rerun `/maestro-tick` |
| Best for | Hot path: scheduled 5-min tick | Cold path: "Maestro, look at my workspace right now" |

## What's in `last-plan.json` after a run

Same schema as option 1 — see `../option1-direct-api/last-plan.json`
for a worked example. The discriminator we care about across the
two options:

- Does option 2's higher-context driver produce *better* prompts (more
  specific, matching the user's voice)?
- Does it catch nuance option 1's pre-bundled inventory misses (e.g.,
  "this branch is already merged into main per `git log`, so the
  paused session is stale — recommend kill rather than resume")?
- Does the cost premium justify the quality difference?

## Comparing the two

After running both:

```bash
diff <(jq . poc/maestro/option1-direct-api/last-plan.json) \
     <(jq . poc/maestro/option2-claude-skill/last-plan.json)
```

For a quick semantic compare (count + kinds):

```bash
jq '.actions | map(.kind) | sort' \
  poc/maestro/option{1-direct-api,2-claude-skill}/last-plan.json
```

## Limitations of this option

- **Not for unattended runs.** Option 2 needs a Claude Code session
  driving it. For "wake up at 3am, scan workspace, propose actions,"
  use option 1 wired to a scheduler.
- **Whichever Claude Code session you invoke `/maestro-tick` in
  counts as a `running` claude-code session in the inventory.** The
  skill's F15.1 gate (Step 2) will correctly drop it from its own
  candidate set, but the *human* needs to be aware they're driving
  Maestro from inside the workspace it's auditing.
- **No checkpoint actually written.** The skill is propose-only by
  construction. To wire execution + revert, see option 1's
  `checkpoint-rehearsal.sh` — that primitive is option-agnostic.
