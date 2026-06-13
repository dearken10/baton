# Maestro PoC — Option 3: continuous master-mind session

A single long-lived Claude Code session that wakes up each tick,
reads its own prior turns as memory, and runs the `maestro-tick`
skill. The session's conversation history IS the memory mechanic —
no sidecar file needed.

> See `../README.md` for the umbrella + 3-way comparison.
> Same skill as option 2 (`.claude/skills/maestro-tick/SKILL.md`);
> only the invocation wrapper differs.

## How it works

```
First ever run:
  bootstrap-or-tick.sh
   └─ generates UUID, runs `claude --session-id <uuid> -p /maestro-tick`
   └─ persists UUID to state/session-id
   └─ tags the baton row session_kind='maestro' so F15.1 gate exempts it

Subsequent runs:
  bootstrap-or-tick.sh
   └─ runs `claude --resume <uuid> -p /maestro-tick`
   └─ Claude Code sees all prior ticks in its conversation
   └─ writes new last-plan.json (overwrites)
```

The Claude Code conversation log at
`~/.claude/projects/<encoded-cwd>/<uuid>.jsonl` grows by ~12 KB per
tick (one user message, one Bash tool_use for inventory, one
tool_result, one assistant text + Write tool_use). After ~50 ticks
you'll want to issue `/compact` — that's `compact-if-needed.sh`
territory (not built yet).

## Files

```
poc/maestro/option3-master-session/
├── README.md                you are here
├── bootstrap-or-tick.sh     entry point: bootstrap OR resume + (compact +) tick
├── maestrod.sh              daemon loop; ticks every MAESTRO_TICK_INTERVAL_MIN
├── migrations/
│   └── 001-add-session-kind.sql      session_kind column for the F15.1 exemption
├── baseline-plan.json       committed snapshot from tick 2 (memory-mechanic proof)
├── state/                   gitignored
│   ├── session-id             pinned UUID; survives reboots
│   ├── tick-count             monotonic int
│   ├── last-tick.log          stdout/stderr of the most recent tick
│   ├── tick.lock              mkdir lock (portable; no flock on macOS)
│   └── plans/
│       └── tick-NNNN.json       one snapshot per successful tick
└── last-plan.json           overwritten each successful tick (gitignored)
```

## Usage

### One-shot

```bash
# One tick (default). Bootstraps on first call.
./poc/maestro/option3-master-session/bootstrap-or-tick.sh

# See where things stand.
./poc/maestro/option3-master-session/bootstrap-or-tick.sh --status

# Pause / resume. File-based flag at ~/.baton/maestro/paused.
# Same flag the chip's UI toggle writes to via maestro.setPaused IPC.
# Paused tick exits in <10 ms — zero tokens spent.
./poc/maestro/option3-master-session/bootstrap-or-tick.sh --pause
./poc/maestro/option3-master-session/bootstrap-or-tick.sh --resume

# Drop the pinned session-id (next tick will bootstrap fresh).
./poc/maestro/option3-master-session/bootstrap-or-tick.sh --reset
```

### Daemon (`maestrod.sh`)

```bash
# Foreground (Ctrl-C to stop). Default 15-minute interval.
./poc/maestro/option3-master-session/maestrod.sh

# Background, logging to disk.
nohup ./poc/maestro/option3-master-session/maestrod.sh \
  > ~/.baton/maestro/daemon.log 2>&1 &
echo $! > ~/.baton/maestro/daemon.pid

# Custom interval (any of these work).
MAESTRO_TICK_INTERVAL_MIN=5 ./maestrod.sh
./maestrod.sh --interval 5

# Stop the backgrounded daemon (clean shutdown).
kill $(cat ~/.baton/maestro/daemon.pid)
```

### Cron alternative (no daemon)

```cron
# Tick every 15 minutes. bootstrap-or-tick.sh's lock handles overlap.
*/15 * * * * cd /path/to/baton && \
  poc/maestro/option3-master-session/bootstrap-or-tick.sh \
  >> ~/.baton/maestro/tick.log 2>&1
```

### Configurable knobs

All env vars; the daemon respects them, and any `bootstrap-or-tick.sh`
invocation respects the ones that apply to a single tick.

| env var | default | meaning |
|---|---|---|
| `MAESTRO_TICK_INTERVAL_MIN` | `15` | Minutes between ticks (daemon only). |
| `MAESTRO_COMPACT_EVERY`    | `25` | **Threshold, not action.** Every N ticks the script writes `state/bloat-warning` and logs a WARN line. Honest compaction via `/compact` doesn't work in `claude -p` (slash commands are interactive-only; in print mode they ship as literal text). The escape hatch is `--reset`, which drops the pinned session and bootstraps fresh on the next tick — clean window, loses memory. Proper self-summarize-then-reset is a v1.x feature; PoC accepts the gap. |
| `MAESTRO_TICK_JITTER_SEC`  | `30` | ± random jitter on each daemon sleep. Helps prompt-cache hit reliability when the interval flirts with the 5-minute TTL boundary. |
| `USAGE_5H` / `USAGE_7D`    | `0.06` | 5h/7d plan usage hints (0..1). The skill uses these to decide whether the tick is allowed to act. |

## What option 3 buys over option 2

| | Option 2 ephemeral | Option 3 continuous |
|---|---|---|
| Session lifetime | one per tick | one forever (until --reset) |
| Memory of past ticks | none (or external sidecar) | own conversation history |
| Calibration over time | nope | yes — sees its own outcomes |
| Cron friendliness | fine | fine |
| Recovery on crash | natural (fresh next tick) | needs explicit fallback (built in) |
| Visible in baton UI | session appears/disappears | one persistent chip with `session_kind='maestro'` |
| Context blowup risk | none | grows ~12 KB/tick — needs periodic /compact |

## The memory test

The real question is: does memory actually change behavior? To check:

```bash
# Run two ticks 60 s apart.
./bootstrap-or-tick.sh
sleep 60
./bootstrap-or-tick.sh

# Read the second plan's reasoning.
jq -r '.reasoning' last-plan.json

# Verify the conversation log shows both ticks.
SID=$(cat state/session-id)
JSONL=~/.claude/projects/-Users-kenchu-Developments-tmp-terminal-for-ai--baton-worktrees-master-mind/${SID}.jsonl
grep -c '"role":"user"' "$JSONL"     # should be ≥2 after two ticks
```

If the second plan's `reasoning` field cites the first tick — "Last
tick I proposed X for 0479daa7, the session is now Y, so this tick I
will Z" — memory is live and the architecture is validated.

If the second plan's reasoning is just as fresh as the first
(treats every tick as the first tick), the memory mechanic isn't
landing. Likely fixes: tighten the prompt instruction in
`.claude/skills/maestro-tick/SKILL.md`, or add explicit "what changed
since last tick" deltas to the inventory.

## Lifecycle management still to build

- **`compact-if-needed.sh`** — after every N ticks (default 25), the
  next tick gets `/compact\n/maestro-tick` instead of bare
  `/maestro-tick` so Claude Code summarizes prior turns.
- **Crash recovery beyond resume failure** — if `claude --resume`
  succeeds but the response is malformed (no `last-plan.json` written,
  no JSON in stdout), retry with a fresh session. Not yet built.
- **Multi-machine coordination** — if you run baton on a laptop and a
  Mac mini, both might try to tick the same Maestro session.
  out-of-scope for v0; v1 needs a leader election or per-host
  Maestro.
- **Snooze of Maestro itself** — `bootstrap-or-tick.sh --pause` to
  disable ticking globally without losing the session.

## Risks

- **Drift sticks.** If Maestro builds a wrong prior, it compounds
  across ticks. `--reset` is the escape hatch — kills the pinned
  session and starts fresh.
- **Conversation log grows.** Without compaction, the log file at
  `~/.claude/projects/<encoded>/<uuid>.jsonl` reaches MB range after
  a few hundred ticks. Disk is cheap but context window isn't.
