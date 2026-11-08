#!/usr/bin/env bash
# product-kit gate.sh v1 — from umbo 0f95e4fa
#
# The loop's only verification entry point. The steps are data, not code: one per line of
# `.product/gate-steps`, as `name<TAB>command` (blank lines and `#` lines are skipped), so this
# file is identical in every repo and never forks.
#
# Each step's output goes to gate-logs/<step>.log; the first failure skips the rest; a summary
# line prints last. The exit code is set explicitly from that summary, never inherited from a
# pipe, so `bash scripts/gate.sh | cat` still reports the real result through `$?`. A gate-steps
# file that parses to zero steps FAILS: a gate with nothing to check reads as coverage and is none.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

STEPS_FILE=".product/gate-steps"
if [ ! -f "$STEPS_FILE" ]; then
  echo "gate: no $STEPS_FILE — run /product init, or write one step per line as name<TAB>command."
  echo "gate: FAIL"
  exit 1
fi

# Optional: export an env file into every step (config § Kit `gate_env`, e.g. `.env.local`).
GATE_ENV="$(node scripts/kit-config.mjs get gate_env 2>/dev/null || true)"
if [ -n "$GATE_ENV" ] && [ -f "$GATE_ENV" ]; then
  set -a
  # shellcheck disable=SC1090
  source "$GATE_ENV"
  set +a
fi

# Load every step before running any: a command that reads stdin (npm does) inside a
# `while read` loop would swallow the remaining lines and the gate would pass after one step.
NAMES=()
CMDS=()
while IFS= read -r line || [ -n "$line" ]; do
  case "$line" in
    "" | "#"*) continue ;;
  esac
  name="${line%%	*}"
  cmd="${line#*	}"
  if [ "$name" = "$line" ] || [ -z "$name" ] || [ -z "$cmd" ]; then
    echo "gate: malformed line in $STEPS_FILE (expected name<TAB>command): $line"
    echo "gate: FAIL"
    exit 1
  fi
  NAMES+=("$name")
  CMDS+=("$cmd")
done <"$STEPS_FILE"

if [ "${#NAMES[@]}" -eq 0 ]; then
  echo "gate: $STEPS_FILE has no steps; a gate that checks nothing is not a pass."
  echo "gate: FAIL"
  exit 1
fi

# One gate at a time across every worktree (scripts/with-gate-lock.sh says why and how).
# gate.sh takes the lock itself, so it must not be run inside that wrapper.
# shellcheck disable=SC1091
source "$ROOT/scripts/with-gate-lock.sh"
gate_lock_acquire

LOG_DIR="gate-logs"
mkdir -p "$LOG_DIR"

# Drop any earlier pass stamp and record the starting fingerprint; a PASS writes a fresh one.
node scripts/gate-stamp.mjs begin

STEP_NAMES=()
STEP_RESULTS=()
STEP_SECONDS=()
FAILED=0

# macOS ships bash 3.2 (no EPOCHREALTIME); perl's Time::HiRes is the portable source.
now() {
  perl -MTime::HiRes=time -e 'printf "%.3f\n", time' 2>/dev/null || date +%s
}
GATE_STARTED="$(now)"

run_step() {
  local name="$1" cmd="$2"
  local log="$LOG_DIR/$name.log"

  if [ "$FAILED" -ne 0 ]; then
    STEP_NAMES+=("$name")
    STEP_RESULTS+=("SKIPPED")
    STEP_SECONDS+=("-")
    return
  fi

  echo "==> $name"
  local started
  started="$(now)"
  bash -c "$cmd" >"$log" 2>&1 </dev/null
  local code=$?
  STEP_SECONDS+=("$(awk -v a="$started" -v b="$(now)" 'BEGIN { printf "%.1fs", b - a }')")

  STEP_NAMES+=("$name")
  if [ "$code" -eq 0 ]; then
    STEP_RESULTS+=("PASS")
  else
    STEP_RESULTS+=("FAIL (exit $code)")
    FAILED=1
    echo "    $name FAILED — last 40 lines of $log:"
    tail -n 40 "$log"
  fi
}

i=0
while [ "$i" -lt "${#NAMES[@]}" ]; do
  run_step "${NAMES[$i]}" "${CMDS[$i]}"
  i=$((i + 1))
done

echo ""
echo "==================== gate summary ===================="
i=0
while [ "$i" -lt "${#STEP_NAMES[@]}" ]; do
  printf '  %-22s %-14s %s\n' "${STEP_NAMES[$i]}" "${STEP_RESULTS[$i]}" "(${STEP_SECONDS[$i]})"
  i=$((i + 1))
done
echo "  total (lock wait excluded): $(awk -v a="$GATE_STARTED" -v b="$(now)" 'BEGIN { printf "%.1fs", b - a }')"

if [ "$FAILED" -eq 0 ]; then
  node scripts/gate-stamp.mjs pass
  echo "gate: PASS"
  exit 0
else
  echo "gate: FAIL"
  exit 1
fi
