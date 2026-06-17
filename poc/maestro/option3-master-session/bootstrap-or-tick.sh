#!/usr/bin/env bash
#
# poc/maestro/option3-master-session/bootstrap-or-tick.sh
#
# Continuous master-mind Claude Code session for Maestro. On first
# run, bootstraps a fresh `claude` session with a pinned UUID and
# tags it `session_kind='maestro'` in baton.db. On every subsequent
# run, resumes that exact session and sends `/maestro-tick`.
#
#   Usage:
#     ./bootstrap-or-tick.sh                # one tick
#     ./bootstrap-or-tick.sh --reset        # drop the persisted session
#                                           # id; next call bootstraps fresh
#     ./bootstrap-or-tick.sh --status       # show current state, no tick
#
# State lives in poc/maestro/option3-master-session/state/:
#   - session-id            pinned UUID for the master-mind session
#   - tick-count            incremented each successful tick
#   - last-tick.log         stdout of the most recent tick (for debug)
#
# Concurrency: `flock` on tick.lock. Overlapping ticks are skipped
# with an explicit log line.

set -euo pipefail

# ------------------------------------------------------------------
# Paths
# ------------------------------------------------------------------
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$HERE/../../.." && pwd)"
STATE_DIR="$HERE/state"
SESSION_ID_FILE="$STATE_DIR/session-id"
TICK_COUNT_FILE="$STATE_DIR/tick-count"
LAST_TICK_LOG="$STATE_DIR/last-tick.log"
LOCK_FILE="$STATE_DIR/tick.lock"
# Paused flag is shared with the UI (the MaestroChip toggle writes here
# via the maestro.setPaused IPC). File presence == paused.
PAUSED_FLAG="$HOME/.baton/maestro/paused"
# Mode file shared with the UI (maestro.setMode IPC). Contents are
# the literal "propose-first" or "act-first". Absent → propose-first.
# Cosmetic at PoC stage; execution gating is v1.x.
MODE_FILE="$HOME/.baton/maestro/mode"
# Heartbeat written by the renderer on every mousemove/click/keydown
# (throttled). The idle gate below treats `now - mtime(...)` as the
# user's idle time. Missing file = treat as "idle forever" (i.e. the
# UI is not running; tick is allowed).
LAST_ACTIVITY_FILE="$HOME/.baton/maestro/last-activity"
mkdir -p "$STATE_DIR" "$HOME/.baton/maestro"

current_mode() {
  if [[ -s "$MODE_FILE" ]]; then
    head -1 "$MODE_FILE" | tr -d '[:space:]'
  else
    echo "propose-first"
  fi
}

# ------------------------------------------------------------------
# CLI
# ------------------------------------------------------------------
MODE="tick"
MODE_ARG=""
FORCE=0
case "${1:-}" in
  --reset)  MODE="reset"  ;;
  --status) MODE="status" ;;
  --pause)  MODE="pause"  ;;
  --resume) MODE="resume" ;;
  --mode)   MODE="set-mode"; MODE_ARG="${2:-}"; shift 2 2>/dev/null || true ;;
  --force)  FORCE=1 ;;       # tick now, bypass idle gate (used by "Run now")
  "")       ;;
  *)
    echo "Usage: $0 [--reset|--status|--pause|--resume|--force|--mode suggest|run]" >&2
    exit 64
    ;;
esac

current_session_id() {
  [[ -s "$SESSION_ID_FILE" ]] && cat "$SESSION_ID_FILE" || echo ""
}

current_tick_count() {
  [[ -s "$TICK_COUNT_FILE" ]] && cat "$TICK_COUNT_FILE" || echo 0
}

# ------------------------------------------------------------------
# --reset
# ------------------------------------------------------------------
if [[ "$MODE" == "reset" ]]; then
  sid="$(current_session_id)"
  if [[ -n "$sid" ]]; then
    echo "Dropping pinned session $sid (file only; the Claude Code"
    echo "conversation log on disk is untouched)."
    rm -f "$SESSION_ID_FILE" "$TICK_COUNT_FILE"
    # Best-effort: untag the row in baton.db so it stops being
    # excluded from candidate sets. The session itself stays.
    sqlite3 "$HOME/.baton/baton.db" \
      "UPDATE sessions SET session_kind='agent' WHERE claude_session_id='$sid';" \
      >/dev/null 2>&1 || true
  else
    echo "No pinned session; nothing to reset."
  fi
  exit 0
fi

# ------------------------------------------------------------------
# --status
# ------------------------------------------------------------------
if [[ "$MODE" == "status" ]]; then
  sid="$(current_session_id)"
  tc="$(current_tick_count)"
  echo "session-id : ${sid:-(unset; next tick will bootstrap)}"
  echo "tick-count : $tc"
  echo "paused     : $([[ -e "$PAUSED_FLAG" ]] && echo "yes ($PAUSED_FLAG)" || echo "no")"
  echo "mode       : $(current_mode)  (cosmetic at PoC; execution wiring is v1.x)"
  echo "idle-thresh: ${MAESTRO_IDLE_MIN_MIN:-15}m"
  if [[ -e "$LAST_ACTIVITY_FILE" ]]; then
    la_sec="$(stat -f %m "$LAST_ACTIVITY_FILE" 2>/dev/null || stat -c %Y "$LAST_ACTIVITY_FILE")"
    echo "last-active: $(( $(date +%s) - la_sec ))s ago"
  else
    echo "last-active: (no heartbeat yet)"
  fi
  if [[ -n "$sid" ]]; then
    row="$(sqlite3 "$HOME/.baton/baton.db" \
      "SELECT id, backend_id, status, session_kind FROM sessions WHERE claude_session_id='$sid';")"
    echo "baton row  : ${row:-(not yet seen by baton — first tick still pending?)}"
  fi
  exit 0
fi

# ------------------------------------------------------------------
# --pause / --resume
# ------------------------------------------------------------------
if [[ "$MODE" == "pause" ]]; then
  date -Iseconds > "$PAUSED_FLAG"
  echo "Maestro paused. Ticks will be skipped until --resume (or the UI toggle)."
  exit 0
fi
if [[ "$MODE" == "resume" ]]; then
  rm -f "$PAUSED_FLAG"
  echo "Maestro resumed."
  exit 0
fi

# Map CLI shorthand to the canonical strings the UI reads/writes.
if [[ "$MODE" == "set-mode" ]]; then
  case "$MODE_ARG" in
    suggest|propose|propose-first) echo "propose-first" > "$MODE_FILE" ;;
    run|act|act-first)             echo "act-first"     > "$MODE_FILE" ;;
    "")
      echo "current mode: $(current_mode)"
      echo "usage: $0 --mode suggest|run"
      exit 0
      ;;
    *) echo "unknown mode: $MODE_ARG (try: suggest, run)" >&2; exit 64 ;;
  esac
  echo "Maestro mode set to: $(current_mode)"
  exit 0
fi

# ------------------------------------------------------------------
# tick (default)
# ------------------------------------------------------------------
# Paused gate: bail before doing ANY work so a paused Maestro costs
# zero tokens. The daemon loops calls this script repeatedly; each
# call hits this check first and skips fast.
if [[ -e "$PAUSED_FLAG" ]]; then
  echo "$(date -Iseconds) skip: paused (flag at $PAUSED_FLAG)"
  exit 0
fi

# Idle gate: only tick when the user has been idle (no mousemove,
# click, or keypress in baton) for at least MAESTRO_IDLE_MIN_MIN
# minutes. The renderer writes a heartbeat to LAST_ACTIVITY_FILE on
# every input event (throttled). --force bypasses (used by the
# "Run now" button so the user can fire a tick on demand).
#
# Rate-limit: never tick again within IDLE_MIN_MIN of the previous
# successful tick. Otherwise a long idle session would fire on every
# poll. The user must come back, interact, and go idle again — or
# wait IDLE_MIN_MIN past last-tick — for a fresh tick.
IDLE_MIN_MIN="${MAESTRO_IDLE_MIN_MIN:-15}"
if ! [[ "$IDLE_MIN_MIN" =~ ^[0-9]+$ ]]; then IDLE_MIN_MIN=15; fi
IDLE_MIN_SEC=$(( IDLE_MIN_MIN * 60 ))

now_sec="$(date +%s)"

# stat -f %m (BSD/macOS) or stat -c %Y (GNU). Both shell out; either
# is fine for one mtime per tick.
mtime_of() {
  local p="$1"
  if [[ ! -e "$p" ]]; then echo ""; return; fi
  stat -f %m "$p" 2>/dev/null || stat -c %Y "$p" 2>/dev/null || echo ""
}

if (( FORCE == 0 )); then
  last_act_sec="$(mtime_of "$LAST_ACTIVITY_FILE")"
  if [[ -n "$last_act_sec" ]]; then
    since_act=$(( now_sec - last_act_sec ))
    if (( since_act < IDLE_MIN_SEC )); then
      remaining=$(( IDLE_MIN_SEC - since_act ))
      echo "$(date -Iseconds) skip: not idle yet (active ${since_act}s ago; need ${IDLE_MIN_SEC}s; ${remaining}s remaining)"
      exit 0
    fi
  fi
  # Otherwise: no heartbeat file → UI never reported activity → treat
  # as idle and proceed.

  # Rate-limit by previous tick mtime. last-tick.log is written on
  # every (attempted) tick — but we want to gate by SUCCESSFUL ticks
  # only. Persist a separate marker on success so failed/aborted runs
  # don't extend the cooldown unfairly.
  last_tick_sec="$(mtime_of "$STATE_DIR/last-tick-success")"
  if [[ -n "$last_tick_sec" ]]; then
    since_tick=$(( now_sec - last_tick_sec ))
    if (( since_tick < IDLE_MIN_SEC )); then
      remaining=$(( IDLE_MIN_SEC - since_tick ))
      echo "$(date -Iseconds) skip: ran ${since_tick}s ago; rate-limited (${remaining}s remaining)"
      exit 0
    fi
  fi
fi

# Atomic lock via mkdir (portable; no flock on macOS by default).
# mkdir fails-loudly if the dir already exists, so we get a clean
# non-zero return without a race window.
if ! mkdir "$LOCK_FILE" 2>/dev/null; then
  # Stale lock? If the dir is older than 10 min, assume the prior
  # tick crashed and reclaim. Maestro ticks should never take that
  # long; if one does it's already broken.
  if [[ -d "$LOCK_FILE" ]]; then
    age_sec=$(( $(date +%s) - $(stat -f %m "$LOCK_FILE" 2>/dev/null || stat -c %Y "$LOCK_FILE") ))
    if (( age_sec > 600 )); then
      echo "$(date -Iseconds) stale lock (${age_sec}s); reclaiming" >&2
      rmdir "$LOCK_FILE" 2>/dev/null || rm -rf "$LOCK_FILE"
      mkdir "$LOCK_FILE"
    else
      echo "$(date -Iseconds) skip: previous tick still running (lock age ${age_sec}s)" >&2
      exit 0
    fi
  fi
fi
trap 'rmdir "$LOCK_FILE" 2>/dev/null || true' EXIT

# Decide bootstrap vs resume
SID="$(current_session_id)"
RESUME_FAILED=0
if [[ -z "$SID" ]]; then
  SID="$(uuidgen | tr '[:upper:]' '[:lower:]')"
  echo "$(date -Iseconds) bootstrap: new session-id=$SID"
  CLAUDE_ARGS=(--session-id "$SID")
else
  echo "$(date -Iseconds) resume: session-id=$SID  tick=$(($(current_tick_count) + 1))"
  CLAUDE_ARGS=(--resume "$SID")
fi

# Plan-usage hints from env. The skill will use these directly.
export USAGE_5H="${USAGE_5H:-0.06}"
export USAGE_7D="${USAGE_7D:-0.06}"

# Stale bloat marker cleanup. Earlier iterations of this script wrote
# a marker file at every Nth tick (MAESTRO_COMPACT_EVERY) and the chip
# surfaced an alert. That was a leaky abstraction — the threshold was
# calendar-based, not actual-size-based, and the only "action" was
# `--reset`, which throws away the master-mind's accumulated memory.
# Now: silently sweep any stale marker on each successful tick. The
# real compaction story (self-summarize + reset, or rolling window)
# is v1.x; until then the chip just doesn't bother the user.
rm -f "$STATE_DIR/bloat-warning"

# Run from the repo root so the project-level skill is in scope.
# `--dangerously-skip-permissions` is required for unattended runs;
# the skill is propose-only (reads inventory, writes one JSON file).
# `</dev/null` prevents claude's "no stdin received" warning when
# nothing is piped to us.
cd "$REPO_ROOT"
set +e
claude "${CLAUDE_ARGS[@]}" \
  -p "/maestro-tick" \
  --dangerously-skip-permissions \
  </dev/null \
  > "$LAST_TICK_LOG" 2>&1
EXIT=$?
set -e

if [[ $EXIT -ne 0 ]]; then
  # If resume failed (session corrupted / pruned), fall back to bootstrap.
  if [[ -n "${SID:-}" ]] && grep -qiE 'no such session|session not found|cannot resume' "$LAST_TICK_LOG"; then
    echo "$(date -Iseconds) resume failed; bootstrapping fresh" >&2
    rm -f "$SESSION_ID_FILE"
    exec "$0"   # re-enter; will bootstrap on next run
  fi
  echo "$(date -Iseconds) tick FAILED exit=$EXIT" >&2
  cat "$LAST_TICK_LOG" >&2
  exit "$EXIT"
fi

# Persist session-id on first successful bootstrap.
if [[ ! -s "$SESSION_ID_FILE" ]]; then
  echo -n "$SID" > "$SESSION_ID_FILE"
fi

# The skill writes to option 2's path by spec. Snapshot it next to
# option 3 so the comparison + history live here too. (Numbered by
# tick count so the trace stays.)
SHARED_PLAN="$REPO_ROOT/poc/maestro/option2-claude-skill/last-plan.json"
if [[ -f "$SHARED_PLAN" ]]; then
  cp "$SHARED_PLAN" "$HERE/last-plan.json"
  tc_next="$(($(current_tick_count) + 1))"
  mkdir -p "$STATE_DIR/plans"
  cp "$SHARED_PLAN" "$STATE_DIR/plans/tick-$(printf '%04d' "$tc_next").json"
fi

# Tag the baton row so dry-run's F15.1 gate exempts it next tick.
sqlite3 "$HOME/.baton/baton.db" \
  "UPDATE sessions SET session_kind='maestro' WHERE claude_session_id='$SID';" \
  >/dev/null 2>&1 || true

# Bump tick counter.
echo -n "$(($(current_tick_count) + 1))" > "$TICK_COUNT_FILE"

# Drop a fresh mtime on the success marker — the idle gate above uses
# this to rate-limit the next tick. Empty file; mtime is the signal.
: > "$STATE_DIR/last-tick-success"

echo "$(date -Iseconds) tick ok  session=$SID  count=$(current_tick_count)"
echo "--- plan summary ---"
tail -20 "$LAST_TICK_LOG"
