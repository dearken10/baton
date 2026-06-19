# Maestro · Option 4 · Per-session JSONL clone

Per-session orchestration: instead of one continuous master-mind session
reasoning over a truncated inventory of every candidate, **clone each
candidate's own JSONL transcript and ask that clone what it would do
next**. Aggregated proposals become the plan.

## Why

The continuous-master approach (option 3) has to fit every candidate's
recent history into one inventory. We capped at 4–6 turns × 600 chars,
which produced the now-infamous "finish your truncated text" failure
mode — the master was reading inventory truncation as real agent
truncation.

Each agent already has its *full* conversation in its JSONL. A clone of
that JSONL, prompted to step back and propose its own next move, gets
the same context the agent itself was reasoning from. No tail cap, no
guesswork.

## Architecture

```
       ┌──────────────────────┐
       │ per-session-tick.mjs │
       └──────────┬───────────┘
                  │  read baton DB, F15.1 gate
                  ▼
       candidate sessions ────────────────┐
                  │ (parallel, capped concurrency)
                  ▼
   ┌────────────────────────────────────┐
   │ propose-for-session.mjs (× N)      │
   │   1. clone JSONL → new UUID         │
   │   2. claude --resume <clone>        │
   │      -p <prompts/next-action.md>    │
   │   3. parse JSON proposal            │
   │   4. delete clone                   │
   └────────────────┬───────────────────┘
                    ▼
     aggregate → last-plan.json
                  + state/plans/tick-NNNN.json
```

The Maestro prompt (`prompts/next-action.md`) keeps the agent in its
own persona — no roleplay flip — and asks for a single JSON object
with action, prompt, assumption, reversibility, confidence.

## Files

- `prompts/next-action.md` — the reflection prompt sent to each clone.
- `propose-for-session.mjs` — single-session helper (clone → claude →
  parse). Standalone-runnable for debugging.
- `per-session-tick.mjs` — orchestrator; runs `proposeFor` in parallel
  over the candidate set, aggregates, writes `last-plan.json`.

## Usage

```bash
# Single session — clone + propose + print one proposal
node poc/maestro/option4-per-session-clone/propose-for-session.mjs <baton-session-id>

# Same, but keep the clone JSONL for inspection
node poc/maestro/option4-per-session-clone/propose-for-session.mjs <id> --keep-clone

# Same, dry run (no claude call; just clone + print path)
node poc/maestro/option4-per-session-clone/propose-for-session.mjs <id> --dry-run

# Full tick — all candidates, parallel, writes last-plan.json
USAGE_5H=0.06 USAGE_7D=0.06 \
node poc/maestro/option4-per-session-clone/per-session-tick.mjs

# Tune parallelism / per-session timeout
MAESTRO_OPT4_CONCURRENCY=8 \
MAESTRO_OPT4_TIMEOUT_MS=300000 \
node poc/maestro/option4-per-session-clone/per-session-tick.mjs
```

## State

- `last-plan.json` — most recent tick's aggregated plan. Same shape as
  option3's last-plan.json so the baton UI renders either source.
- `state/plans/tick-NNNN.json` — historical snapshots.
- `state/tick-count` — monotonic counter for plan numbering.

## Limitations

- **JSONL surgery is fragile.** We rewrite `sessionId` fields per row.
  Any future Claude Code release that adds new id-bearing fields is a
  potential breakage.
- **Cost scales linearly** with candidate count: N candidates ⇒ N
  `claude --print` calls per tick, each loading the full agent
  context. Prompt caching softens this within a 5-min window.
- **No grounded tool use.** The Maestro prompt explicitly forbids
  tools. The clone proposes from conversation context only, not from
  fresh `git status` / file reads. Future: relax to read-only tools.
- **No memory across ticks** (yet). Option 3's master accumulates
  calibration over many ticks; option 4 is currently stateless.
