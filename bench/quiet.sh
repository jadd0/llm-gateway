#!/usr/bin/env bash
# Wait until the machine is quiet enough to benchmark, then record its state.
#
# Usage: bash bench/quiet.sh <results-dir> [max-load] [settle-minutes]
#   Blocks until the 1-minute load average stays below max-load (default 2.0) for settle-minutes
#   (default 2) and the Mac is on mains power, then writes <results-dir>/conditions.txt.
#   Run it immediately before a benchmark, never during a build: other work on the machine
#   (test suites, Docker VMs, other projects) inflates latency and flattens ceilings.
set -euo pipefail
# No "| head" or "grep -q" in a pipeline here: they close the pipe early, the writer dies of SIGPIPE (141)
# and pipefail turns that into an exit.
OUT="${1:?Usage: bench/quiet.sh <results-dir> [max-load] [settle-minutes]}"
MAX="${2:-2.0}"
SETTLE="${3:-2}"
mkdir -p "$OUT"

load1() { sysctl -n vm.loadavg | awk '{print $2}'; }
on_mains() { pmset -g batt | grep "AC Power" >/dev/null; }

quiet_for=0
while [ "$quiet_for" -lt "$SETTLE" ]; do
  l="$(load1)"
  if on_mains && awk -v l="$l" -v m="$MAX" 'BEGIN{exit !(l < m)}'; then
    quiet_for=$((quiet_for + 1))
  else
    quiet_for=0
    echo "bench/quiet: load $l (max $MAX), $(on_mains && echo mains || echo battery); waiting" >&2
  fi
  [ "$quiet_for" -lt "$SETTLE" ] && sleep 60
done

{
  echo "recorded_at: $(date -u +%FT%TZ)"
  echo "loadavg: $(sysctl -n vm.loadavg)"
  echo "power: $(pmset -g batt | sed -n 1p)"
  echo "top_cpu:"
  ps -Ao %cpu,comm -r | sed -n '1,6s/^/  /p'
} >"$OUT/conditions.txt"
echo "bench/quiet: quiet (load $(load1)); conditions in $OUT/conditions.txt"
