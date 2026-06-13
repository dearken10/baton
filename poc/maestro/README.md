# Maestro PoC — two parallel options

Spec lives in `PRD.md` §5 (F15.x). The PoC is intentionally split into
two independent implementations of the same planner. Same inventory
input, same `last-plan.json` output shape — different "how it
decides."

```
poc/maestro/
├── option1-direct-api/        Messages API call, one shot
│   ├── inventory.mjs            (sqlite + JSONL + scrollback + backlog → JSON)
│   ├── planner.mjs              (POST inventory + system prompt → Haiku 4.5)
│   ├── dry-run.mjs              (orchestrator: inventory → planner → report)
│   ├── checkpoint-rehearsal.sh  (F15.6 tag + stash + revert primitive)
│   ├── prompts/planner.system.md
│   └── last-plan.json           ← snapshot of option 1's output
└── option2-claude-skill/      Claude Code skill driving the agent itself
    ├── README.md                (how to invoke; what the skill does)
    └── last-plan.json           ← will be written here when /maestro-tick runs

.claude/skills/maestro-tick/SKILL.md   ← the skill file Claude Code discovers
```

## Why two options

| | Option 1 — direct API | Option 2 — Claude Code skill |
|---|---|---|
| Caller | A Node script | Claude Code CLI session |
| Planner | Single Messages API call, Haiku 4.5 | Whatever model is driving Claude Code (Opus/Sonnet/Haiku — your choice) |
| Inventory | Pre-bundled by `inventory.mjs`, every byte fixed before the call | Skill can read what it wants (sqlite, scrollback, JSONL, even `git log`) using its own tools |
| Latency | One round-trip, ~3 s | Multiple tool calls, ~30–60 s but more context per decision |
| Cost | ~$0.015 / tick (Haiku) | Scales with the driving model + how much it explores |
| Iteration | Edit `planner.system.md`, rerun | Edit `SKILL.md`, run `/maestro-tick` in a Claude Code session |
| Best for | Hot path: scheduled tick on a 5-min cron | Cold path: ad-hoc "Maestro, look at my workspace" |

Both write `last-plan.json` to their own directory. Comparing the two
on the same machine state is the cheapest A/B test we have.

## Quickstart

**Option 1:**
```bash
USAGE_5H=0.06 USAGE_7D=0.06 \
  node poc/maestro/option1-direct-api/dry-run.mjs
# → poc/maestro/option1-direct-api/last-plan.json
```

**Option 2** (from a fresh Claude Code session at the repo root):
```
/maestro-tick
# → poc/maestro/option2-claude-skill/last-plan.json
```
