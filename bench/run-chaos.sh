#!/usr/bin/env bash
# Resilience benchmark, run natively: two mock providers, the gateway and k6 on this machine.
# Usage: bash bench/run-chaos.sh   (env overrides: OUT, DURATION_S, KILL_AT_S, RESTART_AT_S, RATE_JSON, RATE_STREAM, ...)
# Needs Postgres and Redis up (docker compose up -d --wait) and `npm run db:migrate` applied.
#
# Two mocks: A (port 9000, serves mock-openai-1) and B (port 9001, serves mock-anthropic-1). Under load the
# script kills A with SIGKILL at KILL_AT_S and starts a fresh A at RESTART_AT_S. The run is done twice, with
# the fallback chain mock-openai-1>mock-anthropic-1 and without it. k6 tags each request with the phase it was
# sent in (before, outage, after); bench/chaos-summary.ts turns the two k6 summaries into summary.md.
# FRONT_PORT=<port>: nginx (bench/cluster.sh nginx) listens there in front of the gateway for each run, and k6 sends
# its load through it; the final suite sets it so the outage is measured through the same front as the cluster runs.
# Run it behind `bash bench/quiet.sh <OUT>`; a build running alongside invalidates the latency numbers.
set -euo pipefail
# Every client is 127.0.0.1, so the per-address failed-auth limiter would throttle the load; it is not what is measured.
export AUTH_FAIL_LIMIT_PER_MIN="${AUTH_FAIL_LIMIT_PER_MIN:-0}"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PR="${PR:-7}"
OUT="${OUT:-$ROOT/bench/results/pr-$PR}"
MOCK_A_PORT="${MOCK_A_PORT:-9000}"
MOCK_B_PORT="${MOCK_B_PORT:-9001}"
GATEWAY_PORT="${GATEWAY_PORT:-8080}"
DURATION_S="${DURATION_S:-80}"
KILL_AT_S="${KILL_AT_S:-20}"
RESTART_AT_S="${RESTART_AT_S:-50}"
RATE_JSON="${RATE_JSON:-200}"
RATE_STREAM="${RATE_STREAM:-50}"
HIGH_LIMIT=999999999
HIGH_CAP_USD=999999999
RUN="$(date +%s)"

mkdir -p "${OUT:?}"
PIDS=()
KEYS=()
cleanup() {
  for p in "${PIDS[@]:-}"; do [ -n "$p" ] && kill "$p" 2>/dev/null || true; done
  for k in "${KEYS[@]:-}"; do
    [ -n "$k" ] && npm --prefix "$ROOT" run --silent keys -- revoke-key "${k:0:12}" >/dev/null 2>&1 || true
  done
}
trap cleanup EXIT

require_free_port() {
  if [ -n "$(lsof -ti "tcp:$1" -sTCP:LISTEN 2>/dev/null)" ]; then
    echo "port $1 is already in use; stop that process first" >&2; exit 1
  fi
}
wait_up() { # url expected-http-status pid
  local code
  for _ in $(seq 1 50); do
    if ! kill -0 "$3" 2>/dev/null; then echo "process $3 exited before answering $1" >&2; exit 1; fi
    code=$(curl -s -o /dev/null -w '%{http_code}' "$1" || true)
    if [ "$code" = "$2" ]; then return 0; fi
    sleep 0.2
  done
  echo "timed out waiting for $1 to answer $2 (last status: ${code:-none})" >&2; exit 1
}
start_mock() { # port: realistic latency, so a request is in flight when its mock dies
  require_free_port "$1"
  MOCK_PORT="$1" MOCK_LATENCY_MS=200 MOCK_TOKEN_DELAY_MS=10 MOCK_COMPLETION_TOKENS=20 \
    node "$ROOT/packages/mock-provider/src/server.ts" >/dev/null &
  LAST_PID=$!; PIDS+=("$LAST_PID")
  wait_up "http://127.0.0.1:$1/__control" 200 "$LAST_PID"
}
start_gateway() { # fallback chain ("" for none), run name
  require_free_port "$GATEWAY_PORT"
  # Each run has its own Redis prefix: a breaker left open by the first run must not be inherited by the second.
  env GATEWAY_PORT="$GATEWAY_PORT" REDIS_KEY_PREFIX="chaos-$RUN-$2:" OPENAI_BASE_URL="http://127.0.0.1:$MOCK_A_PORT/v1" \
    MOCK_BASE_URL="http://127.0.0.1:$MOCK_A_PORT" MOCK_ANTHROPIC_BASE_URL="http://127.0.0.1:$MOCK_B_PORT" \
    MODEL_FALLBACKS="$1" UPSTREAM_CONNECTIONS="${UPSTREAM_CONNECTIONS:-256}" LOG_LEVEL=warn \
    RATE_LIMIT_REDIS_TIMEOUT_MS="${RATE_LIMIT_REDIS_TIMEOUT_MS:-1000}" \
    node --env-file-if-exists="$ROOT/.env.local" "$ROOT/packages/gateway/src/server.ts" >/dev/null &
  GW_PID=$!; PIDS+=("$GW_PID")
  wait_up "http://127.0.0.1:$GATEWAY_PORT/v1/chat/completions" 401 "$GW_PID"
  # The log worker applies the spend stream (settles); without it every hold lapses and budget rebuilds slow to a stall.
  env REDIS_KEY_PREFIX="chaos-$RUN-$2:" LOG_LEVEL=warn node --env-file-if-exists="$ROOT/.env.local" "$ROOT/packages/log-worker/src/worker.ts" >/dev/null &
  WORKER_PID=$!; PIDS+=("$WORKER_PID")
  sleep 1; kill -0 "$WORKER_PID" 2>/dev/null || { echo "the log worker exited at start" >&2; exit 1; }
}
FRONT_PORT="${FRONT_PORT:-}"
start_front() { # nginx in front of the gateway, when FRONT_PORT is set; waits until it answers
  [ -n "$FRONT_PORT" ] || return 0
  CLUSTER_DIR="$(mktemp -d)" NGINX_PORT="$FRONT_PORT" bash "$ROOT/bench/cluster.sh" nginx "$FRONT_PORT" "$GATEWAY_PORT" >/dev/null &
  FRONT_PID=$!; PIDS+=("$FRONT_PID")
  wait_up "http://127.0.0.1:$FRONT_PORT/v1/chat/completions" 401 "$FRONT_PID"
}
stop_all() {
  kill "${FRONT_PID:-}" "${WORKER_PID:-}" "${GW_PID:-}" "${MOCK_A_PID:-}" "${MOCK_B_PID:-}" 2>/dev/null || true
  wait "${FRONT_PID:-}" "${WORKER_PID:-}" "${GW_PID:-}" "${MOCK_A_PID:-}" "${MOCK_B_PID:-}" 2>/dev/null || true
  FRONT_PID=""; WORKER_PID=""; GW_PID=""; MOCK_A_PID=""; MOCK_B_PID=""
}

run_once() { # name fallback-chain
  local name="$1" chain="$2" t0 rc=0
  echo "== $name (chain: ${chain:-none}; kill A at ${KILL_AT_S}s, restart at ${RESTART_AT_S}s of ${DURATION_S}s)"
  start_mock "$MOCK_A_PORT"; MOCK_A_PID=$LAST_PID
  start_mock "$MOCK_B_PORT"; MOCK_B_PID=$LAST_PID
  start_gateway "$chain" "$name"
  start_front
  rm -f "${OUT:?}/$name.json"
  t0=$(( $(date +%s) * 1000 + 3000 ))
  API_KEY="$KEY" TARGET_URL="http://127.0.0.1:${FRONT_PORT:-$GATEWAY_PORT}" T0="$t0" KILL_AT_S="$KILL_AT_S" RESTART_AT_S="$RESTART_AT_S" \
    DURATION_S="$DURATION_S" RATE_JSON="$RATE_JSON" RATE_STREAM="$RATE_STREAM" \
    k6 run --quiet --summary-export "$OUT/$name.json" "$ROOT/bench/k6/chaos.js" >"$OUT/$name.log" 2>&1 &
  K6_PID=$!
  sleep_until() { local target=$1 now; now=$(( $(date +%s) * 1000 )); [ "$target" -gt "$now" ] && sleep "$(awk -v ms=$((target - now)) 'BEGIN{printf "%.3f", ms/1000}')"; return 0; }
  sleep_until $(( t0 + KILL_AT_S * 1000 ))
  kill -9 "$MOCK_A_PID" 2>/dev/null || true
  wait "$MOCK_A_PID" 2>/dev/null || true
  echo "   killed A"
  sleep_until $(( t0 + RESTART_AT_S * 1000 ))
  start_mock "$MOCK_A_PORT"; MOCK_A_PID=$LAST_PID
  echo "   restarted A"
  wait "$K6_PID" || rc=$?
  # 99 is k6's "a threshold failed" exit code; any other non-zero code is a real failure.
  if [ "$rc" -ne 0 ] && [ "$rc" -ne 99 ]; then echo "k6 exited $rc for $name; see $OUT/$name.log" >&2; exit 1; fi
  [ -s "$OUT/$name.json" ] || { echo "k6 did not write $OUT/$name.json" >&2; exit 1; }
  stop_all
}

npm --prefix "$ROOT" run --silent keys -- create-tenant bench >/dev/null 2>&1 || true
npm --prefix "$ROOT" run --silent keys -- set-budget bench --monthly-usd "$HIGH_CAP_USD" >/dev/null 2>&1 \
  || { echo "could not set the bench tenant's budget (is Postgres up and migrated?)" >&2; exit 1; }
KEY="$(npm --prefix "$ROOT" run --silent keys -- create-key bench "chaos-$RUN" --rpm "$HIGH_LIMIT" --tpm "$HIGH_LIMIT" 2>/dev/null)"
case "$KEY" in gw_*) ;; *) echo "could not create a bench key (is Postgres up and migrated?)" >&2; exit 1;; esac
KEYS+=("$KEY")

run_once chaos-fallback-on "mock-openai-1>mock-anthropic-1"
run_once chaos-fallback-off ""
node "$ROOT/bench/chaos-summary.ts" "$OUT"
echo "results in $OUT"
