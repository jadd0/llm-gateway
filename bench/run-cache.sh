#!/usr/bin/env bash
# Exact-match cache benchmark, run natively: mock provider, gateway and k6 on this machine.
# Usage: bash bench/run-cache.sh   (env overrides: OUT, RATE, DURATION_S, STAMPEDE, PROMPTS, POOL, ZIPF_S, ...)
# Needs Postgres and Redis up (docker compose up -d --wait) and `npm run db:migrate` applied.
# Four k6 runs against one gateway (cache, budgets and rate limiter on; mock provider with realistic latency):
#   cold          every prompt new: all misses, the price of looking and filling
#   warm          a Zipf draw from POOL of PROMPTS distinct prompts: the hit rate is measured, not assumed
#   warm-stream   the same draw, streamed requests (a hit is replayed as a stream)
#   stampede      STAMPEDE identical requests at once: upstream calls are counted
# bench/cache-summary.ts then writes summary.md from the k6 JSON alone.
# Run it behind `bash bench/quiet.sh <OUT>`; a build running alongside invalidates the latency numbers.
set -euo pipefail
# Every client is 127.0.0.1, so the per-address failed-auth limiter would throttle the load; it is not what is measured.
export AUTH_FAIL_LIMIT_PER_MIN="${AUTH_FAIL_LIMIT_PER_MIN:-0}"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PR="${PR:-8}"
OUT="${OUT:-$ROOT/bench/results/pr-$PR}"
MOCK_PORT="${MOCK_PORT:-9000}"
GATEWAY_PORT="${GATEWAY_PORT:-8080}"
RATE="${RATE:-100}"
DURATION_S="${DURATION_S:-60}"
STAMPEDE="${STAMPEDE:-50}"
PROMPTS="${PROMPTS:-2000}"
POOL="${POOL:-200}"
ZIPF_S="${ZIPF_S:-1.1}"
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

require_free_port() { # a stale server on it would be measured instead of ours
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

require_free_port "$MOCK_PORT"
MOCK_PORT="$MOCK_PORT" MOCK_LATENCY_MS=200 MOCK_TOKEN_DELAY_MS=10 MOCK_COMPLETION_TOKENS=20 \
  node "$ROOT/packages/mock-provider/src/server.ts" >/dev/null &
MOCK_PID=$!; PIDS+=("$MOCK_PID")
wait_up "http://127.0.0.1:$MOCK_PORT/__control" 200 "$MOCK_PID"

require_free_port "$GATEWAY_PORT"
# The cache entries of every run live under this prefix and are removed with it at the end.
PREFIX="bench-cache-$RUN:"
env GATEWAY_PORT="$GATEWAY_PORT" OPENAI_BASE_URL="http://127.0.0.1:$MOCK_PORT/v1" MOCK_BASE_URL="http://127.0.0.1:$MOCK_PORT" \
  LOG_LEVEL=warn REDIS_KEY_PREFIX="$PREFIX" CACHE_ENABLED=true BUDGET_ENABLED=true RATE_LIMIT_ENABLED=true \
  RATE_LIMIT_REDIS_TIMEOUT_MS="${RATE_LIMIT_REDIS_TIMEOUT_MS:-1000}" CACHE_REDIS_TIMEOUT_MS="${CACHE_REDIS_TIMEOUT_MS:-200}" \
  node --env-file-if-exists="$ROOT/.env.local" "$ROOT/packages/gateway/src/server.ts" >/dev/null &
GW_PID=$!; PIDS+=("$GW_PID")
GW="http://127.0.0.1:$GATEWAY_PORT"
wait_up "$GW/v1/chat/completions" 401 "$GW_PID"
# The log worker applies the spend stream: without it no settle reaches Postgres, every hold lapses, and each budget
# rebuild drags all of them along. A gateway is never deployed without one.
env REDIS_KEY_PREFIX="$PREFIX" LOG_LEVEL=warn node --env-file-if-exists="$ROOT/.env.local" "$ROOT/packages/log-worker/src/worker.ts" >/dev/null &
WORKER_PID=$!; PIDS+=("$WORKER_PID")
sleep 1; kill -0 "$WORKER_PID" 2>/dev/null || { echo "the log worker exited at start" >&2; exit 1; }

npm --prefix "$ROOT" run --silent keys -- create-tenant bench >/dev/null 2>&1 || true # exists on re-runs
npm --prefix "$ROOT" run --silent keys -- set-budget bench --monthly-usd "$HIGH_CAP_USD" >/dev/null 2>&1 \
  || { echo "could not set the bench tenant's budget (is Postgres up and migrated?)" >&2; exit 1; }
KEY="$(npm --prefix "$ROOT" run --silent keys -- create-key bench "cache-$RUN" --rpm "$HIGH_LIMIT" --tpm "$HIGH_LIMIT" 2>/dev/null)"
case "$KEY" in gw_*) ;; *) echo "could not create a bench key (is Postgres up and migrated?)" >&2; exit 1;; esac
KEYS+=("$KEY")

run_k6() { # name scenario stream
  echo "== $1"
  rm -f "${OUT:?}/cache-$1.json"
  local rc=0
  API_KEY="$KEY" TARGET_URL="$GW" SCENARIO="$2" STREAM="$3" NONCE="$RUN-$1" RATE="$RATE" DURATION_S="$DURATION_S" \
    STAMPEDE="$STAMPEDE" PROMPTS="$PROMPTS" POOL="$POOL" ZIPF_S="$ZIPF_S" \
    k6 run --quiet --summary-export "$OUT/cache-$1.json" "$ROOT/bench/k6/cache.js" >"$OUT/cache-$1.log" 2>&1 || rc=$?
  # 99 is k6's "a threshold failed" exit code; any other non-zero code is a real failure.
  if [ "$rc" -ne 0 ] && [ "$rc" -ne 99 ]; then echo "k6 exited $rc for $1; see $OUT/cache-$1.log" >&2; exit 1; fi
  if [ ! -s "$OUT/cache-$1.json" ]; then echo "k6 did not write $OUT/cache-$1.json" >&2; exit 1; fi
}

run_k6 cold cold false
run_k6 warm warm false
run_k6 warm-stream warm true
run_k6 stampede stampede false

node "$ROOT/bench/cache-summary.ts" "$OUT"
# Entries expire by themselves; remove this run's now rather than leave them for the TTL.
node --env-file-if-exists="$ROOT/.env.local" -e '
  const { Redis } = require("ioredis");
  const r = new Redis(process.env.REDIS_URL);
  (async () => {
    const keys = [];
    for await (const batch of r.scanStream({ match: process.argv[1] + "*", count: 500 })) keys.push(...batch);
    for (let i = 0; i < keys.length; i += 500) await r.del(...keys.slice(i, i + 500));
    r.disconnect();
  })().catch(() => r.disconnect());
' "$PREFIX" || true
echo "results in $OUT"
