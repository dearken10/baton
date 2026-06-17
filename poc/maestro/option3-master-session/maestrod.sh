#!/usr/bin/env bash
#
# poc/maestro/option3-master-session/maestrod.sh
#
# The Maestro daemon: poll every `MAESTRO_POLL_INTERVAL_SEC`,
# call bootstrap-or-tick.sh, repeat. The tick script enforces an
# idle gate (no input from the user for MAESTRO_IDLE_MIN_MIN minutes)
# and rate-limits itself, so the daemon's only job is to wake up
# often enough that the gate fires shortly after the user goes idle.
# Exits cleanly on SIGINT/SIGTERM so it can be foreground'd in a
# shell, backgrounded with `&`, run under launchd/systemd, or piped
# through `nohup`.
#
#   Foreground:
#     ./maestrod.sh
#
#   Background, logging to disk:
#     nohup ./maestrod.sh > ~/.baton/maestro/daemon.log 2>&1 &
#     echo $! > ~/.baton/maestro/daemon.pid
#
#   Custom cadence (env or CLI):
#     MAESTRO_POLL_INTERVAL_SEC=30 ./maestrod.sh
#     ./maestrod.sh --poll 30
#
#   Stop:
#     kill $(cat ~/.baton/maestro/daemon.pid)
#     # or just Ctrl-C if foreground
#
# Configurable knobs (env, with sensible defaults):
#   MAESTRO_POLL_INTERVAL_SEC   seconds between gate checks            (60)
#   MAESTRO_IDLE_MIN_MIN        idle threshold before a tick fires    (15)
#   MAESTRO_TICK_JITTER_SEC     ± random jitter on each sleep         (10)
#   USAGE_5H / USAGE_7D         5h/7d plan usage hints (0..1)       (.06)
#
# State is per-machine in ~/.baton/maestro/. The pinned session-id
# lives in option3-master-session/state/ (next to this script).

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOG_DIR="$HOME/.baton/maestro"
mkdir -p "$LOG_DIR"

# ------------------------------------------------------------------
# CLI parsing: only --poll is special; everything else hands off
# to bootstrap-or-tick.sh on each call.
# ------------------------------------------------------------------
while [[ $# -gt 0 ]]; do
  case "$1" in
    --poll) MAESTRO_POLL_INTERVAL_SEC="$2"; shift 2 ;;
    --help|-h)
      sed -n '2,31p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *) echo "unknown flag: $1" >&2; exit 64 ;;
  esac
done

POLL_SEC="${MAESTRO_POLL_INTERVAL_SEC:-60}"
JITTER_SEC="${MAESTRO_TICK_JITTER_SEC:-10}"
IDLE_MIN_MIN="${MAESTRO_IDLE_MIN_MIN:-15}"
# Re-export so bootstrap-or-tick.sh sees the same value.
export MAESTRO_IDLE_MIN_MIN="$IDLE_MIN_MIN"

# Validate
if ! [[ "$POLL_SEC" =~ ^[0-9]+$ ]] || (( POLL_SEC < 5 )); then
  echo "MAESTRO_POLL_INTERVAL_SEC must be ≥ 5 (got: $POLL_SEC)" >&2
  exit 64
fi
if ! [[ "$JITTER_SEC" =~ ^[0-9]+$ ]]; then
  echo "MAESTRO_TICK_JITTER_SEC must be a non-negative integer (got: $JITTER_SEC)" >&2
  exit 64
fi
if ! [[ "$IDLE_MIN_MIN" =~ ^[0-9]+$ ]] || (( IDLE_MIN_MIN < 1 )); then
  echo "MAESTRO_IDLE_MIN_MIN must be a positive integer (got: $IDLE_MIN_MIN)" >&2
  exit 64
fi

# ------------------------------------------------------------------
# Lifecycle
# ------------------------------------------------------------------
# Pid file shared with the UI chip (maestro.getState reads it). The
# chip's on/off toggle (maestro.setPaused) starts/stops this daemon
# by spawn + kill on this pid.
PID_FILE="$LOG_DIR/daemon.pid"

# If another daemon already owns the pid file, bail. Skip the self
# case: if the file contains our own pid we ARE the legitimate one
# (the parent that spawned us may have pre-written; previously a
# bug, now defensive). Without this guard a parent pre-write makes
# us mis-detect ourselves and suicide on startup.
if [[ -s "$PID_FILE" ]]; then
  existing="$(cat "$PID_FILE" 2>/dev/null || echo "")"
  if [[ -n "$existing" ]] && [[ "$existing" != "$$" ]] && kill -0 "$existing" 2>/dev/null; then
    echo "$(date -Iseconds) refusing to start: daemon already running pid=$existing" >&2
    exit 0
  fi
  rm -f "$PID_FILE"   # stale OR our own pre-write
fi

echo "$$" > "$PID_FILE"

SHUTDOWN=0
shutdown() {
  SHUTDOWN=1
  echo "$(date -Iseconds) shutdown requested; finishing current tick before exit"
}
cleanup() {
  # Only remove the pid file if it still points at us. Defense against
  # a race where another daemon already replaced it.
  if [[ -s "$PID_FILE" ]] && [[ "$(cat "$PID_FILE")" == "$$" ]]; then
    rm -f "$PID_FILE"
  fi
  echo "$(date -Iseconds) maestrod down"
}
trap shutdown SIGINT SIGTERM
trap cleanup  EXIT

echo "$(date -Iseconds) maestrod up  poll=${POLL_SEC}s  idle-threshold=${IDLE_MIN_MIN}m  jitter=±${JITTER_SEC}s  pid=$$"

while (( SHUTDOWN == 0 )); do
  # Tick gate. bootstrap-or-tick.sh decides whether to actually fire
  # based on the idle-since-last-input check + rate limit; cheap when
  # the user is active (just two stat() calls + exit 0).
  set +e
  "$HERE/bootstrap-or-tick.sh"
  rc=$?
  set -e
  if (( rc != 0 )); then
    echo "$(date -Iseconds) tick returned non-zero ($rc); sleeping anyway"
  fi

  if (( SHUTDOWN != 0 )); then break; fi

  # Short poll cadence with a little jitter to spread out repeated
  # gate checks across daemons / machines.
  SLEEP_SEC=$POLL_SEC
  if (( JITTER_SEC > 0 )); then
    JITTER=$(( (RANDOM % (JITTER_SEC * 2 + 1)) - JITTER_SEC ))
    SLEEP_SEC=$(( SLEEP_SEC + JITTER ))
    if (( SLEEP_SEC < 5 )); then SLEEP_SEC=5; fi
  fi

  # Interruptible sleep: poll SHUTDOWN every 5 s.
  while (( SLEEP_SEC > 0 && SHUTDOWN == 0 )); do
    CHUNK=$(( SLEEP_SEC > 5 ? 5 : SLEEP_SEC ))
    sleep "$CHUNK"
    SLEEP_SEC=$(( SLEEP_SEC - CHUNK ))
  done
done

# `cleanup` trap above logs "maestrod down" and removes the pid file.
