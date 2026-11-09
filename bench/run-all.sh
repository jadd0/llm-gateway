#!/usr/bin/env bash
# The final benchmark suite: every scenario of the plan, one script, one results folder, one summary.
#
# Usage:
#   bash bench/run-all.sh                  the full suite into bench/results/final/   (run overnight, nothing else running)
#   bash bench/run-all.sh --smoke          every scenario with tiny durations into a scratch folder; proves the wiring, its numbers mean nothing
#   bash bench/run-all.sh --only cluster,correctness     a subset (names below); --out <dir> picks the folder
# Needs: Postgres and Redis up (docker compose up -d --wait; the semantic scenarios also want ollama), `npm run db:migrate`
# applied, k6 and nginx on PATH (brew install k6 nginx), power connected, nothing else of ours running, the laptop left alone.
#
# ESTIMATED RUN TIME (full suite, a machine that stays quiet): about 2 h 45 min plus whatever bench/quiet.sh waits. Sum of:
#   overhead     20 min   3 repeats x (2 profiles x 3 runs x 60 s + startup)
#   cluster      44 min   ramp 1 and 3 instances 3 repeats x 4.2 min, steady 6 x 1.5 min, spike 6 x 1.7 min
#   correctness  20 min   10 runs x (rate-limit burst + budget flood + budget flood with a Redis restart)
#   cache        18 min   3 repeats x 6 min
#   semantic     38 min   latency run 8 min, threshold evaluation allowed 30 min (not measured on this machine yet)
#   chaos        10 min   3 repeats x 3.5 min
#   logging       9 min   run-logging.sh's own 3 repeats
#   profile       4 min   one ramp on one instance under --cpu-prof
#   dashboard     2 min   only where `npm run bench:dashboard` exists
# After the first full run, replace this estimate with the measured total (see elapsed.txt in the results folder).
#
# Scenarios (names for --only), numbered as in the plan:
#   overhead     1  direct-to-mock vs through one gateway, instant and realistic mock          bench/run-baseline.sh
#   frameworks   2  the PR 2 framework comparison                                              bench/frameworks/ (skipped where absent)
#   cluster      3,4,9  ramp (ceiling and breaking point), steady at 60% of the ceiling, spike; 1 and 3 instances behind nginx
#   correctness  5  rate limit, budget and budget-with-Redis-restart floods, 3 instances, N runs   bench/run-correctness.sh
#   cache        6  cold vs warm, stampede                                                     bench/run-cache.sh
#   semantic     6  semantic hit vs miss latency, then the threshold evaluation                bench/run-semantic.sh, npm run bench:semantic-eval
#   chaos        7  provider outage, fallback on and off, through nginx                        bench/run-chaos.sh
#   logging      8  inline vs stream request log                                               bench/run-logging.sh
#   profile      9  one ramp on one instance with node --cpu-prof, for naming the breaking point's cause
#   dashboard       the PR 11 dashboard benchmark, where `npm run bench:dashboard` exists
# Mock latency: the ramp, steady and overhead-instant runs use an instant mock so the gateway, nginx and k6 are what is measured
# (their ceilings are bound by this one machine, load generator included); spike and the other scenarios use the mock settings
# of their own script (realistic latency).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SMOKE=0; ONLY=""; FINAL=""
while [ $# -gt 0 ]; do
  case "$1" in
    --smoke) SMOKE=1 ;;
    --only) ONLY="${2:?--only needs a list}"; shift ;;
    --out) FINAL="${2:?--out needs a folder}"; shift ;;
    *) echo "usage: bash bench/run-all.sh [--smoke] [--only a,b] [--out dir]" >&2; exit 2 ;;
  esac
  shift
done
if [ -z "$FINAL" ]; then
  if [ "$SMOKE" = 1 ]; then FINAL="${TMPDIR:-/tmp}/llm-gateway-bench-smoke"; else FINAL="$ROOT/bench/results/final"; fi
fi
SCENARIOS="overhead frameworks cluster correctness cache semantic chaos logging dashboard profile"
want() { [ -z "$ONLY" ] || [[ ",$ONLY," == *",$1,"* ]]; }

# Parameters. Smoke shrinks every duration; the full values are the ones the estimate above is built on.
if [ "$SMOKE" = 1 ]; then
  REPEATS=1; CORR_RUNS=1; SECONDARY_REPEATS=1
  BASE_ENV=(WARMUP_S=2 DURATION_S=4 STEP_RATES= RATE_INSTANT=100 RATE_REALISTIC=50)
  RAMP_RATES="200,400"; STEP_S=6; STEP_WARMUP_S=2; STEADY_WARMUP_S=2; STEADY_S=4
  SPIKE_ENV=(BASE_RATE=40 SPIKE_FACTOR=3 WARMUP_S=2 BASE_S=3 SPIKE_S=3 RECOVER_WINDOWS=2 RECOVER_WINDOW_S=2)
  SPIKE_WINDOW_S=2
  CORR_ENV=(FLOOD_ROUNDS=3 FLOOD=20 BURST=100 FAILOVER_AT_S=1)
  CACHE_ENV=(RATE=20 DURATION_S=5 STAMPEDE=10 PROMPTS=100 POOL=20)
  SEM_ENV=(SEEDS=10 RATE=5 DURATION_S=5 SETTLE_S=5); EVAL_ARGS=(--qqp 40 --paws 40)
  CHAOS_ENV=(DURATION_S=16 KILL_AT_S=5 RESTART_AT_S=10 RATE_JSON=20 RATE_STREAM=5)
  LOG_ENV=(RATE=20 WARMUP_S=2 DURATION_S=5 REPEATS=1)
else
  REPEATS=3; CORR_RUNS=10; SECONDARY_REPEATS=3
  BASE_ENV=(WARMUP_S=15 DURATION_S=45 STEP_RATES=)
  RAMP_RATES="1000,2000,3000,4000,5000,6000,8000,10000,12000,14000,16000,20000"; STEP_S=20; STEP_WARMUP_S=5
  STEADY_WARMUP_S=15; STEADY_S=60
  SPIKE_ENV=(BASE_RATE=200 SPIKE_FACTOR=10 WARMUP_S=10 BASE_S=30 SPIKE_S=20 RECOVER_WINDOWS=6 RECOVER_WINDOW_S=5)
  SPIKE_WINDOW_S=5
  CORR_ENV=()
  CACHE_ENV=(); SEM_ENV=(); EVAL_ARGS=()
  CHAOS_ENV=(); LOG_ENV=()
fi
CORR_RUNS="${CORR_RUNS_OVERRIDE:-$CORR_RUNS}"
HIGH_LIMIT=999999999
HIGH_CAP_USD=999999999
FRONT_PORT=8080

mkdir -p "$FINAL/cluster" "$FINAL/conditions"
CL_PID=""; CL_DIR=""; SAMPLER_PID=""; KEY=""
cleanup() {
  trap - EXIT INT TERM
  cluster_down
  if [ -n "$KEY" ]; then npm --prefix "$ROOT" run --silent keys -- revoke-key "${KEY:0:12}" >/dev/null 2>&1 || true; fi
}
trap cleanup EXIT INT TERM
ulimit -n 65536 2>/dev/null || ulimit -n "$(ulimit -Hn)" 2>/dev/null || true

# ---- preflight: tools, dependencies, free ports -------------------------------------------------------------------
for tool in k6 nginx node docker curl lsof; do command -v "$tool" >/dev/null || { echo "run-all: $tool is not installed" >&2; exit 1; }; done
running="$(docker compose -f "$ROOT/docker-compose.yml" ps --status running --services 2>/dev/null || true)"
for svc in redis postgres; do grep -qx "$svc" <<<"$running" || { echo "run-all: docker compose service $svc is not running (docker compose up -d --wait)" >&2; exit 1; }; done
for port in $FRONT_PORT 3101 3102 3103 9000 9001; do
  [ -z "$(lsof -ti "tcp:$port" -sTCP:LISTEN 2>/dev/null)" ] || { echo "run-all: port $port is in use; stop that process first" >&2; exit 1; }
done

# ---- helpers ------------------------------------------------------------------------------------------------------
quiet_gate() { # scenario: wait for a quiet machine and record its state; smoke skips the wait
  [ "$SMOKE" = 1 ] && return 0
  bash "$ROOT/bench/quiet.sh" "$FINAL/conditions/$1" 2.0 1
}
log() { echo "[$(date +%H:%M:%S)] run-all: $*"; }

cluster_up() { # instances mock-latency-ms mock-token-delay-ms [completion-tokens]
  CL_DIR="$(mktemp -d)"
  env INSTANCES="$1" MOCK_LATENCY_MS="$2" MOCK_TOKEN_DELAY_MS="$3" MOCK_COMPLETION_TOKENS="${4:-20}" CLUSTER_DIR="$CL_DIR" \
    NGINX_PORT="$FRONT_PORT" BUDGET_ENABLED=true RATE_LIMIT_ENABLED=true \
    bash "$ROOT/bench/cluster.sh" up >"$CL_DIR/cluster.log" 2>&1 &
  CL_PID=$!
  for _ in $(seq 1 240); do
    [ -f "$CL_DIR/ready" ] && return 0
    kill -0 "$CL_PID" 2>/dev/null || { cat "$CL_DIR/cluster.log" >&2; echo "run-all: the cluster exited at start" >&2; exit 1; }
    sleep 0.5
  done
  echo "run-all: the cluster did not become ready" >&2; exit 1
}
cluster_down() {
  [ -n "$SAMPLER_PID" ] && kill "$SAMPLER_PID" 2>/dev/null || true
  SAMPLER_PID=""
  if [ -n "$CL_PID" ]; then
    kill "$CL_PID" 2>/dev/null || true
    wait "$CL_PID" 2>/dev/null || true
    CL_PID=""
  fi
}
sample_start() { # name: one line per process per second (t, role, %cpu, rss KB) while the cluster runs
  local file="$FINAL/cluster/cpu-$1.csv" start; start=$(date +%s)
  echo "t_s,role,cpu_pct,rss_kb" >"$file"
  ( while true; do
      for f in "$CL_DIR"/*.pid; do
        [ -f "$f" ] || continue
        role="$(basename "$f" .pid)"
        ps -o %cpu=,rss= -p "$(cat "$f")" 2>/dev/null | awk -v t=$(( $(date +%s) - start )) -v r="$role" 'NF==2{print t","r","$1","$2}' >>"$file" || true
      done
      sleep 1
    done ) &
  SAMPLER_PID=$!
}
k6run() { # out-json script KEY=VALUE...  (99 is k6's "a threshold failed" exit code; any other non-zero code is a real failure)
  local out="$1" script="$2" rc=0; shift 2
  rm -f "$out"
  env "$@" k6 run --quiet --summary-export "$out" "$ROOT/bench/k6/$script" >"${out%.json}.log" 2>&1 || rc=$?
  if [ "$rc" -ne 0 ] && [ "$rc" -ne 99 ]; then echo "run-all: k6 exited $rc for $out; see ${out%.json}.log" >&2; exit 1; fi
  [ -s "$out" ] || { echo "run-all: k6 did not write $out" >&2; exit 1; }
}
bench_key() { # one key with limits nothing reaches, on a tenant with a cap nothing reaches
  npm --prefix "$ROOT" run --silent keys -- create-tenant bench >/dev/null 2>&1 || true
  npm --prefix "$ROOT" run --silent keys -- set-budget bench --monthly-usd "$HIGH_CAP_USD" >/dev/null 2>&1 \
    || { echo "run-all: could not set the bench tenant's budget (is Postgres up and migrated?)" >&2; exit 1; }
  KEY="$(npm --prefix "$ROOT" run --silent keys -- create-key bench "run-all-$(date +%s)" --rpm "$HIGH_LIMIT" --tpm "$HIGH_LIMIT" 2>/dev/null)"
  case "$KEY" in gw_*) ;; *) echo "run-all: could not create a bench key" >&2; exit 1;; esac
}

# ---- what this run is ---------------------------------------------------------------------------------------------
START_S=$(date +%s)
{
  echo "commit: $(git -C "$ROOT" rev-parse --short HEAD)$(git -C "$ROOT" diff --quiet HEAD -- 2>/dev/null || echo ' (uncommitted changes)')"
  echo "cpu: $(sysctl -n machdep.cpu.brand_string)"
  echo "cores: $(sysctl -n hw.ncpu)"
  echo "memory_gb: $(( $(sysctl -n hw.memsize) / 1073741824 ))"
  echo "os: $(sw_vers -productName) $(sw_vers -productVersion)"
  echo "node: $(node --version)"
  echo "k6: $(k6 version | head -1)"
  echo "nginx: $(nginx -v 2>&1)"
  echo "mode: $([ "$SMOKE" = 1 ] && echo 'SMOKE (tiny durations, numbers are meaningless)' || echo full)"
} >"$FINAL/hardware.txt"
printf '{"rampMeasureS": %s, "spikeWindowS": %s}\n' "$((STEP_S - STEP_WARMUP_S))" "$SPIKE_WINDOW_S" >"$FINAL/params.json"
: >"$FINAL/skipped.txt"
[ "$SMOKE" = 1 ] || bash "$ROOT/bench/quiet.sh" "$FINAL" 2.0 2
[ -f "$FINAL/conditions.txt" ] || echo "recorded_at: $(date -u +%FT%TZ)  (smoke run: quiet check skipped)" >"$FINAL/conditions.txt"
bench_key

# ---- 1. overhead --------------------------------------------------------------------------------------------------
if want overhead; then
  for rep in $(seq 1 "$REPEATS"); do
    quiet_gate "overhead-$rep"; log "overhead repeat $rep"
    env OUT="$FINAL/overhead/rep-$rep" "${BASE_ENV[@]}" bash "$ROOT/bench/run-baseline.sh" >"$FINAL/overhead-$rep.log" 2>&1 \
      || { tail -5 "$FINAL/overhead-$rep.log" >&2; echo "run-all: overhead failed" >&2; exit 1; }
  done
fi

# ---- 2. framework comparison --------------------------------------------------------------------------------------
if want frameworks; then
  if compgen -G "$ROOT/bench/frameworks/run-*.sh" >/dev/null; then
    quiet_gate frameworks; log "frameworks"
    for f in "$ROOT"/bench/frameworks/run-*.sh; do OUT="$FINAL/frameworks" bash "$f" >"$FINAL/frameworks.log" 2>&1; done
  else
    echo "frameworks: bench/frameworks/ is not on this base (the PR 2 harness has not been merged); not run" >>"$FINAL/skipped.txt"
    log "frameworks skipped: bench/frameworks/ is not on this base"
  fi
fi

# ---- 3, 4, 9. ramp, steady, spike ---------------------------------------------------------------------------------
if want cluster; then
  for inst in 1 3; do
    for rep in $(seq 1 "$REPEATS"); do
      quiet_gate "ramp-${inst}i-$rep"; log "ramp, $inst instance(s), repeat $rep"
      cluster_up "$inst" 0 0; sample_start "ramp-${inst}i-$rep"
      k6run "$FINAL/cluster/ramp-${inst}i-$rep.json" ramp.js TARGET_URL="http://127.0.0.1:$FRONT_PORT" API_KEY="$KEY" RATES="$RAMP_RATES" STEP_S="$STEP_S" STEP_WARMUP_S="$STEP_WARMUP_S"
      cluster_down
    done
  done
  for inst in 1 3; do
    rate="$(node "$ROOT/bench/final-summary.ts" ceiling "$FINAL" "$inst" 0.6 2>"$FINAL/cluster/ceiling-${inst}i.err")" || rate=0
    [ "$rate" -ge 1 ] || { echo "run-all: no ceiling for $inst instance(s); steady runs skipped" >&2; continue; }
    for rep in $(seq 1 "$REPEATS"); do
      quiet_gate "steady-${inst}i-$rep"; log "steady at $rate req/s (60% of the ceiling), $inst instance(s), repeat $rep"
      cluster_up "$inst" 0 0; sample_start "steady-${inst}i-$rep"
      k6run "$FINAL/cluster/steady-${inst}i-$rate-$rep.json" chat.js TARGET_URL="http://127.0.0.1:$FRONT_PORT" API_KEY="$KEY" RATE="$rate" WARMUP_S="$STEADY_WARMUP_S" DURATION_S="$STEADY_S"
      cluster_down
    done
  done
  for inst in 1 3; do
    for rep in $(seq 1 "$REPEATS"); do
      quiet_gate "spike-${inst}i-$rep"; log "spike, $inst instance(s), repeat $rep"
      cluster_up "$inst" 200 10; sample_start "spike-${inst}i-$rep"
      k6run "$FINAL/cluster/spike-${inst}i-$rep.json" spike.js TARGET_URL="http://127.0.0.1:$FRONT_PORT" API_KEY="$KEY" "${SPIKE_ENV[@]}"
      cluster_down
    done
  done
fi

# ---- 5. correctness under concurrency -----------------------------------------------------------------------------
if want correctness; then
  quiet_gate correctness; log "correctness: $CORR_RUNS runs, 3 instances"
  # The mock answers after 300 ms with 100 tokens, so a flood's requests are all decided while the first are in flight.
  cluster_up 3 300 0 100; sample_start correctness
  env OUT="$FINAL" TARGET_URL="http://127.0.0.1:$FRONT_PORT" RUNS="$CORR_RUNS" ${CORR_ENV[@]+"${CORR_ENV[@]}"} bash "$ROOT/bench/run-correctness.sh" >"$FINAL/correctness.log" 2>&1 \
    || { tail -5 "$FINAL/correctness.log" >&2; echo "run-all: correctness failed" >&2; exit 1; }
  cluster_down
fi

# ---- 6. cache and semantic cache ----------------------------------------------------------------------------------
if want cache; then
  for rep in $(seq 1 "$SECONDARY_REPEATS"); do
    quiet_gate "cache-$rep"; log "cache repeat $rep"
    env OUT="$FINAL/cache/rep-$rep" ${CACHE_ENV[@]+"${CACHE_ENV[@]}"} bash "$ROOT/bench/run-cache.sh" >"$FINAL/cache-$rep.log" 2>&1 \
      || { tail -5 "$FINAL/cache-$rep.log" >&2; echo "run-all: cache failed" >&2; exit 1; }
  done
fi
if want semantic; then
  quiet_gate semantic; log "semantic cache latency"
  env OUT="$FINAL/semantic" ${SEM_ENV[@]+"${SEM_ENV[@]}"} bash "$ROOT/bench/run-semantic.sh" >"$FINAL/semantic.log" 2>&1 \
    || { tail -5 "$FINAL/semantic.log" >&2; echo "run-all: semantic latency run failed" >&2; exit 1; }
  log "semantic cache threshold evaluation"
  node --env-file-if-exists="$ROOT/.env.local" "$ROOT/bench/semantic/eval.ts" ${EVAL_ARGS[@]+"${EVAL_ARGS[@]}"} --out "$FINAL/semantic" >"$FINAL/semantic-eval.log" 2>&1 \
    || { tail -5 "$FINAL/semantic-eval.log" >&2; echo "run-all: semantic evaluation failed" >&2; exit 1; }
fi

# ---- 7. provider outage -------------------------------------------------------------------------------------------
if want chaos; then
  for rep in $(seq 1 "$SECONDARY_REPEATS"); do
    quiet_gate "chaos-$rep"; log "chaos repeat $rep (through nginx on $FRONT_PORT)"
    env OUT="$FINAL/chaos/rep-$rep" FRONT_PORT="$FRONT_PORT" GATEWAY_PORT=3101 ${CHAOS_ENV[@]+"${CHAOS_ENV[@]}"} bash "$ROOT/bench/run-chaos.sh" >"$FINAL/chaos-$rep.log" 2>&1 \
      || { tail -5 "$FINAL/chaos-$rep.log" >&2; echo "run-all: chaos failed" >&2; exit 1; }
  done
fi

# ---- 8. request logging -------------------------------------------------------------------------------------------
if want logging; then
  quiet_gate logging; log "logging, inline vs stream"
  env OUT="$FINAL/logging" ${LOG_ENV[@]+"${LOG_ENV[@]}"} bash "$ROOT/bench/run-logging.sh" >"$FINAL/logging.log" 2>&1 \
    || { tail -5 "$FINAL/logging.log" >&2; echo "run-all: logging failed" >&2; exit 1; }
fi

# ---- dashboard (PR 11), where it exists ---------------------------------------------------------------------------
if want dashboard; then
  if node -e 'process.exit(require("./package.json").scripts?.["bench:dashboard"] ? 0 : 1)' 2>/dev/null; then
    quiet_gate dashboard; log "dashboard"
    mkdir -p "$FINAL/dashboard"
    OUT="$FINAL/dashboard" npm --prefix "$ROOT" run --silent bench:dashboard >"$FINAL/dashboard/output.txt" 2>&1 \
      || { tail -5 "$FINAL/dashboard/output.txt" >&2; echo "run-all: dashboard failed" >&2; exit 1; }
  else
    echo "dashboard: no bench:dashboard script on this base (the dashboard has not been merged); not run" >>"$FINAL/skipped.txt"
    log "dashboard skipped: no bench:dashboard script on this base"
  fi
fi

# ---- 9. profile of one gateway under the ramp ---------------------------------------------------------------------
if want profile; then
  quiet_gate profile; log "profile: one instance under --cpu-prof"
  mkdir -p "$FINAL/profile"
  GATEWAY_NODE_ARGS="--cpu-prof --cpu-prof-dir=$FINAL/profile" cluster_up 1 0 0; sample_start profile
  k6run "$FINAL/profile/ramp-1i-profile.json" ramp.js TARGET_URL="http://127.0.0.1:$FRONT_PORT" API_KEY="$KEY" RATES="$RAMP_RATES" STEP_S="$STEP_S" STEP_WARMUP_S="$STEP_WARMUP_S"
  cluster_down # SIGTERM lets the gateway exit cleanly, which is when node writes the .cpuprofile
fi

# ---- summary ------------------------------------------------------------------------------------------------------
echo "elapsed_s: $(( $(date +%s) - START_S ))" >"$FINAL/elapsed.txt"
[ -s "$FINAL/skipped.txt" ] || rm -f "$FINAL/skipped.txt"
node "$ROOT/bench/final-summary.ts" "$FINAL"
log "done in $(( ($(date +%s) - START_S) / 60 )) min; summary in $FINAL/summary.md"
