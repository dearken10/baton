# Maestro · Option 5 · PM-as-outsider

A different orchestration model from option 4. Instead of cloning the
target agent's JSONL and asking it to reflect on itself, we spin up a
**fresh Claude Code session with no prior context**, give it a
**Product Manager** persona (via `prompts/goal.md`), hand it (a) the
user-supplied goal for the session and (b) a plain-text summary of the
target agent's recent turns, and ask: given this goal and this
progress, what should the engineer be told to do next?

The reply is the same JSON shape option 4 emits — `action`, `prompt`,
`rationale`, `assumption`, `if_wrong`, `reversibility_cost`,
`confidence` — so downstream consumers (Maestro variant-A card,
executor, etc.) don't need to know which architecture produced it.

## Why

- **Fresh perspective**: the PM has never argued with the codebase or
  the plan; it can't fall into "commit the loose ends" bias the way a
  self-reflecting clone can.
- **Goal-first, not turn-first**: the primary input is a stable user
  goal; the transcript is just evidence. In option 4, everything runs
  through the tail of the transcript itself.
- **Cheaper transcript**: we send a compact plain-text summary (last
  N turns, caps applied), not the whole JSONL. That's meaningful on
  long-running sessions where the option-4 clone pays for the full
  history every call.
- **Cheap wait/defer**: a fresh session with no stake in the
  conversation is quicker to say "the human should call this shot".

The tradeoff: the PM can't see engineering details buried deeper in
the transcript, so it may miss "this test is failing because of X
we talked about 40 turns ago". Fine for high-level next-steps;
questionable for deep debugging.

## Files

- `prompts/goal.md` — the PM persona + instruction template with two
  placeholders the script substitutes:
  - `{{GOAL}}` — the free-form goal text passed as `--goal "<text>"`
  - `{{CONVERSATION}}` — the formatted last-N turns from the target's
    JSONL
- `pm-propose.mjs` — the standalone script. Node, no dependencies.
- `README.md` — this file.

## Usage

Standalone (from the repo root):

```bash
node poc/maestro/option5-product-manager/pm-propose.mjs \
  09fd320c-c2d7-4bb2-b0dc-55eff1609af3 \
  --goal "Ship the F15.2 auto-executor. Wire the option4 backend, test on baton1."
```

Flags:

- `--goal "<text>"`        — required; the free-form goal the PM is optimizing for.
- `--turns N`              — number of tail turns to include (default 8).
- `--jsonl-path <path>`    — explicit JSONL path, skips the `~/.claude/projects/` search.
- `--dry-run`              — print the composed prompt to stdout, skip the claude call.
- `--prompt <path>`        — use a different template file instead of `prompts/goal.md`.

The `<claude-session-id>` is the UUID Claude Code assigned to the
target agent (visible in baton's session info dialog and as the JSONL
filename). The script searches `~/.claude/projects/*/<uuid>.jsonl`
for it unless `--jsonl-path` is passed.

## Output

Progress lines go to **stderr** (`[pm] jsonl: …`, `[pm] read N turn(s)…`,
`[pm] calling claude…`). The proposal goes to **stdout** as one JSON
object:

```jsonc
{
  "claude_session_id": "09fd320c-…",
  "jsonl_path": "/Users/…/09fd320c-….jsonl",
  "goal": "Ship the F15.2 auto-executor …",
  "turn_count_used": 8,
  "proposal": {
    "action": "resume",
    "prompt": "commit the current diff on feat/imbee-8433 with a message referencing the -90 +30 loader swap",
    "rationale": "…",
    "assumption": "…",
    "if_wrong": "…",
    "reversibility_cost": "trivial",
    "confidence": "high"
  }
}
```

Pipe stdout through `jq '.proposal.prompt'` to grab just the
suggested next message.

## Not wired anywhere yet

By design. Test the script + iterate on `goal.md` first. Once the
prompt reliably produces useful suggestions, we'll wire it into
`maestroSuggestion.ts` alongside (or in place of) the option-4
proposer path — probably behind a per-session or global toggle so
both architectures can run for comparison.
