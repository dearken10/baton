#!/usr/bin/env bash
#
# poc/maestro/option3-master-session/maestrod.sh
#
# The Maestro daemon: sleep `MAESTRO_TICK_INTERVAL_MIN` minutes,
# call bootstrap-or-tick.sh, repeat. Exits cleanly on SIGINT/SIGTERM
# so it can be foreground'd in a shell, backgrounded with `&`, run
# under launchd/systemd, or piped through `nohup`.
#
#   Foreground:
#     ./maestrod.sh
#
#   Background, logging to disk:
#     nohup ./maestrod.sh > ~/.baton/maestro/daemon.log 2>&1 &
#     echo $! > ~/.baton/maestro/daemon.pid
#
#   Custom interval (env or CLI):
#     MAESTRO_TICK_INTERVAL_MIN=5 ./maestrod.sh
#     ./maestrod.sh --interval 5
#
#   Stop:
#     kill $(cat ~/.baton/maestro/daemon.pid)
#     # or just Ctrl-C if foreground
#
# Configurable knobs (env, with sensible defaults):
#   MAESTRO_TICK_INTERVAL_MIN   minutes between ticks                 (15)
#   MAESTRO_COMPACT_EVERY       compact every N ticks                  (25)
#   MAESTRO_TICK_JITTER_SEC     ± random jitter on each sleep         (30)
#                               (helps prompt-cache hit unreliability
#                               when interval == 5 min and TTL == 5 min)
#   USAGE_5H / USAGE_7D         5h/7d plan usage hints (0..1)       (.06)
#
# State is per-machine in ~/.baton/maestro/. The pinned session-id
# lives in option3-master-session/state/ (next to this script).

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOG_DIR="$HOME/.baton/maestro"
mkdir -p "$LOG_DIR"

# ------------------------------------------------------------------
# CLI parsing: only --interval is special; everything else hands off
# to bootstrap-or-tick.sh on each call.
# ------------------------------------------------------------------
while [[ $# -gt 0 ]]; do
  case "$1" in
    --interval) MAESTRO_TICK_INTERVAL_MIN="$2"; shift 2 ;;
    --help|-h)
      sed -n '2,29p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *) echo "unknown flag: $1" >&2; exit 64 ;;
  esac
done

INTERVAL_MIN="${MAESTRO_TICK_INTERVAL_MIN:-15}"
JITTER_SEC="${MAESTRO_TICK_JITTER_SEC:-30}"

# Validate
if ! [[ "$INTERVAL_MIN" =~ ^[0-9]+$ ]] || (( INTERVAL_MIN < 1 )); then
  echo "MAESTRO_TICK_INTERVAL_MIN must be a positive integer (got: $INTERVAL_MIN)" >&2
  exit 64
fi
if ! [[ "$JITTER_SEC" =~ ^[0-9]+$ ]]; then
  echo "MAESTRO_TICK_JITTER_SEC must be a non-negative integer (got: $JITTER_SEC)" >&2
  exit 64
fi

# ------------------------------------------------------------------
# Lifecycle
# ------------------------------------------------------------------
SHUTDOWN=0
shutdown() {
  SHUTDOWN=1
  echo "$(date -Iseconds) shutdown requested; finishing current tick before exit"
}
trap shutdown SIGINT SIGTERM

echo "$(date -Iseconds) maestrod up  interval=${INTERVAL_MIN}m  jitter=±${JITTER_SEC}s  pid=$$"

while (( SHUTDOWN == 0 )); do
  # Tick. bootstrap-or-tick.sh handles its own lockfile, so overlapping
  # daemon instances are safe (the later one will just skip).
  set +e
  "$HERE/bootstrap-or-tick.sh"
  rc=$?
  set -e
  if (( rc != 0 )); then
    echo "$(date -Iseconds) tick returned non-zero ($rc); sleeping anyway"
  fi

  if (( SHUTDOWN != 0 )); then break; fi

  # Sleep with jitter. The jitter is the only protection against
  # synchronized cache misses across many machines (and against
  # accidentally hitting Anthropic's 5-min cache TTL right on the dot).
  SLEEP_SEC=$(( INTERVAL_MIN * 60 ))
  if (( JITTER_SEC > 0 )); then
    JITTER=$(( (RANDOM % (JITTER_SEC * 2 + 1)) - JITTER_SEC ))
    SLEEP_SEC=$(( SLEEP_SEC + JITTER ))
  fi
  echo "$(date -Iseconds) sleeping ${SLEEP_SEC}s until next tick"

  # Interruptible sleep: poll SHUTDOWN every 5 s.
  while (( SLEEP_SEC > 0 && SHUTDOWN == 0 )); do
    CHUNK=$(( SLEEP_SEC > 5 ? 5 : SLEEP_SEC ))
    sleep "$CHUNK"
    SLEEP_SEC=$(( SLEEP_SEC - CHUNK ))
  done
done

echo "$(date -Iseconds) maestrod down"
