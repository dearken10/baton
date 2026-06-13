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
mkdir -p "$STATE_DIR"

# ------------------------------------------------------------------
# CLI
# ------------------------------------------------------------------
MODE="tick"
case "${1:-}" in
  --reset)  MODE="reset"  ;;
  --status) MODE="status" ;;
  "")       ;;
  *)
    echo "Usage: $0 [--reset|--status]" >&2
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
  if [[ -n "$sid" ]]; then
    row="$(sqlite3 "$HOME/.baton/baton.db" \
      "SELECT id, backend_id, status, session_kind FROM sessions WHERE claude_session_id='$sid';")"
    echo "baton row  : ${row:-(not yet seen by baton — first tick still pending?)}"
  fi
  exit 0
fi

# ------------------------------------------------------------------
# tick (default)
# ------------------------------------------------------------------
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

# Run from the repo root so the project-level skill is in scope.
# `--dangerously-skip-permissions` is required for unattended runs;
# the skill is propose-only (reads inventory, writes one JSON file).
cd "$REPO_ROOT"
set +e
claude "${CLAUDE_ARGS[@]}" \
  -p "/maestro-tick" \
  --dangerously-skip-permissions \
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

echo "$(date -Iseconds) tick ok  session=$SID  count=$(current_tick_count)"
echo "--- plan summary ---"
tail -20 "$LAST_TICK_LOG"
