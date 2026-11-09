#!/usr/bin/env bash
# Translation overhead: the same realistic streamed scenario through the gateway for each provider format,
# against the mock provider's OpenAI, Anthropic and Gemini formats. mock-openai is the pass-through
# baseline; the other two add the adapter's request, stream and usage translation.
# Usage: bash bench/run-providers.sh   (env overrides: PR, OUT, RATE, WARMUP_S, DURATION_S, ...)
# Needs Postgres and Redis up (docker compose up -d --wait) and `npm run db:migrate` applied. Full runs
# go behind `bash bench/quiet.sh <results-dir>`; a short run is a smoke test only.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PR="${PR:-6}"
OUT="${OUT:-$ROOT/bench/results/pr-$PR}"
MOCK_PORT="${MOCK_PORT:-9000}"
GATEWAY_PORT="${GATEWAY_PORT:-8080}"
RATE="${RATE:-200}"            # req/s, streamed (the PR 3 realistic profile)
WARMUP_S="${WARMUP_S:-30}"
DURATION_S="${DURATION_S:-60}"
MODELS="${MODELS:-mock-openai-1 mock-anthropic-1 mock-gemini-1}"

mkdir -p "$OUT"
PIDS=()
API_KEY=""
cleanup() {
  for p in "${PIDS[@]:-}"; do [ -n "$p" ] && kill "$p" 2>/dev/null || true; done
  if [ -n "$API_KEY" ]; then npm --prefix "$ROOT" run --silent keys -- revoke-key "${API_KEY:0:12}" >/dev/null 2>&1 || true; fi
}
trap cleanup EXIT

require_free_port() { # a stale server on it would be measured instead of ours
  if [ -n "$(lsof -ti "tcp:$1" -sTCP:LISTEN 2>/dev/null)" ]; then echo "port $1 is already in use; stop that process first" >&2; exit 1; fi
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

require_free_port "$MOCK_PORT"; require_free_port "$GATEWAY_PORT"
MOCK_PORT="$MOCK_PORT" MOCK_LATENCY_MS=200 MOCK_TOKEN_DELAY_MS=10 MOCK_COMPLETION_TOKENS=20 \
  node "$ROOT/packages/mock-provider/src/server.ts" >/dev/null &
MOCK_PID=$!; PIDS+=("$MOCK_PID")
wait_up "http://127.0.0.1:$MOCK_PORT/__control" 200 "$MOCK_PID"
GATEWAY_PORT="$GATEWAY_PORT" OPENAI_BASE_URL="http://127.0.0.1:$MOCK_PORT" MOCK_BASE_URL="http://127.0.0.1:$MOCK_PORT" \
  LOG_LEVEL=warn AUTH_CACHE=redis BUDGET_ENABLED="${BUDGET_ENABLED:-false}" \
  node --env-file-if-exists="$ROOT/.env.local" "$ROOT/packages/gateway/src/server.ts" >/dev/null &
GW_PID=$!; PIDS+=("$GW_PID")
wait_up "http://127.0.0.1:$GATEWAY_PORT/v1/chat/completions" 401 "$GW_PID"

npm --prefix "$ROOT" run --silent keys -- create-tenant bench >/dev/null 2>&1 || true
API_KEY="$(npm --prefix "$ROOT" run --silent keys -- create-key bench "providers-$(date +%s)" 2>/dev/null)"
case "$API_KEY" in gw_*) ;; *) echo "could not create a bench key (is Postgres up and migrated?)" >&2; exit 1;; esac

GW="http://127.0.0.1:$GATEWAY_PORT"
for model in $MODELS; do
  name="gateway-$model"
  echo "== $name (stream=true rate=$RATE/s)"
  rm -f "$OUT/$name.json"
  rc=0
  API_KEY="$API_KEY" MODEL="$model" TARGET_URL="$GW" STREAM=true RATE="$RATE" WARMUP_S="$WARMUP_S" DURATION_S="$DURATION_S" \
    k6 run --quiet --summary-export "$OUT/$name.json" "$ROOT/bench/k6/chat.js" >"$OUT/$name.log" 2>&1 || rc=$?
  # 99 is k6's "a threshold failed" exit code; any other non-zero code is a real failure.
  if [ "$rc" -ne 0 ] && [ "$rc" -ne 99 ]; then echo "k6 exited $rc for $name; see $OUT/$name.log" >&2; exit 1; fi
  if [ ! -s "$OUT/$name.json" ]; then echo "k6 did not write $OUT/$name.json" >&2; exit 1; fi
done
echo "results in $OUT"
