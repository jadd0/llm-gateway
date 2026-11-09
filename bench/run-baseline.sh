#!/usr/bin/env bash
# Runs the PR 1 baseline natively: mock provider, gateway and k6 on this machine.
# Usage: bash bench/run-baseline.sh   (env overrides: OUT, RATE_INSTANT, RATE_REALISTIC, ...)
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="${OUT:-$ROOT/bench/results/pr-1}"
MOCK_PORT="${MOCK_PORT:-9000}"
GATEWAY_PORT="${GATEWAY_PORT:-8080}"
RATE_INSTANT="${RATE_INSTANT:-1000}"     # req/s for the instant overhead comparison
RATE_REALISTIC="${RATE_REALISTIC:-200}"  # req/s for the realistic streamed comparison
WARMUP_S="${WARMUP_S:-30}"
DURATION_S="${DURATION_S:-60}"
STEP_RATES="${STEP_RATES:-2000 4000 6000 8000 10000 12000 14000 16000 18000 20000}"
STEP_WARMUP_S="${STEP_WARMUP_S:-5}"
STEP_DURATION_S="${STEP_DURATION_S:-15}"

mkdir -p "$OUT"
PIDS=()
cleanup() { for p in "${PIDS[@]:-}"; do [ -n "$p" ] && kill "$p" 2>/dev/null || true; done; }
trap cleanup EXIT

require_free_port() { # port: a stale server on it would be measured instead of ours
  if [ -n "$(lsof -ti "tcp:$1" -sTCP:LISTEN 2>/dev/null)" ]; then
    echo "port $1 is already in use; stop that process first" >&2; exit 1
  fi
}
start_mock() { # latency token_delay
  require_free_port "$MOCK_PORT"
  MOCK_PORT="$MOCK_PORT" MOCK_LATENCY_MS="$1" MOCK_TOKEN_DELAY_MS="$2" MOCK_COMPLETION_TOKENS=20 \
    node "$ROOT/packages/mock-provider/src/server.ts" >/dev/null &
  MOCK_PID=$!; PIDS+=("$MOCK_PID")
  wait_up "http://127.0.0.1:$MOCK_PORT/__control" 200 "$MOCK_PID"
}
start_gateway() {
  require_free_port "$GATEWAY_PORT"
  GATEWAY_PORT="$GATEWAY_PORT" OPENAI_BASE_URL="http://127.0.0.1:$MOCK_PORT" \
    UPSTREAM_CONNECTIONS="${UPSTREAM_CONNECTIONS:-256}" LOG_LEVEL=warn \
    node "$ROOT/packages/gateway/src/server.ts" >/dev/null &
  GW_PID=$!; PIDS+=("$GW_PID")
  wait_up "http://127.0.0.1:$GATEWAY_PORT/v1/chat/completions" 404 "$GW_PID"
}
wait_up() { # url expected-http-status pid: the process we started must be alive and answering
  local code
  for _ in $(seq 1 50); do
    if ! kill -0 "$3" 2>/dev/null; then echo "process $3 exited before answering $1" >&2; exit 1; fi
    code=$(curl -s -o /dev/null -w '%{http_code}' "$1" || true)
    if [ "$code" = "$2" ]; then return 0; fi
    sleep 0.2
  done
  echo "timed out waiting for $1 to answer $2 (last status: ${code:-none})" >&2; exit 1
}
stop() { kill "$MOCK_PID" "${GW_PID:-}" 2>/dev/null || true; wait "$MOCK_PID" "${GW_PID:-}" 2>/dev/null || true; GW_PID=""; }

run_k6() { # name url stream rate warmup duration
  echo "== $1 ($2 stream=$3 rate=$4/s)"
  rm -f "$OUT/$1.json"
  local rc=0
  TARGET_URL="$2" STREAM="$3" RATE="$4" WARMUP_S="$5" DURATION_S="$6" \
    k6 run --quiet --summary-export "$OUT/$1.json" "$ROOT/bench/k6/chat.js" >"$OUT/$1.log" 2>&1 || rc=$?
  # 99 is k6's "a threshold failed" exit code; any other non-zero code is a real failure.
  if [ "$rc" -ne 0 ] && [ "$rc" -ne 99 ]; then
    echo "k6 exited $rc for $1; see $OUT/$1.log" >&2; exit 1
  fi
  if [ ! -s "$OUT/$1.json" ]; then
    echo "k6 did not write $OUT/$1.json" >&2; exit 1
  fi
}

MOCK="http://127.0.0.1:$MOCK_PORT"
GW="http://127.0.0.1:$GATEWAY_PORT"

for profile in instant realistic; do
  if [ "$profile" = instant ]; then lat=0; tok=0; stream=false; rate=$RATE_INSTANT
  else lat=200; tok=10; stream=true; rate=$RATE_REALISTIC; fi
  start_mock "$lat" "$tok"; start_gateway
  run_k6 "direct-$profile" "$MOCK" "$stream" "$rate" "$WARMUP_S" "$DURATION_S"
  run_k6 "gateway-$profile" "$GW" "$stream" "$rate" "$WARMUP_S" "$DURATION_S"
  stop
done

# Throughput: step the arrival rate up through the gateway against the instant mock, and the
# mock directly for reference. BENCHMARKS.md names the last step with errors <= 1%, p95 <= 2x the
# first step's p95.
start_mock 0 0; start_gateway
for target in gateway direct; do
  url=$GW; [ "$target" = direct ] && url=$MOCK
  for r in $STEP_RATES; do
    run_k6 "step-$target-$r" "$url" false "$r" "$STEP_WARMUP_S" "$STEP_DURATION_S"
  done
done
stop
echo "results in $OUT"
