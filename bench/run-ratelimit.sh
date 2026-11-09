#!/usr/bin/env bash
# Rate limiter benchmark, run natively: mock provider, gateway and k6 on this machine.
# Usage: bash bench/run-ratelimit.sh   (env overrides: OUT, RATE_INSTANT, RATE_REALISTIC, BURST, ...)
# Needs Postgres and Redis up (docker compose up -d --wait) and `npm run db:migrate` applied.
# Two parts:
#   overhead  the same request rate through the gateway with the limiter off (RATE_LIMIT_ENABLED=false,
#             the auth-only path) and on, with a key whose limits are too high to ever reject, so the
#             difference is the cost of the check itself. Instant non-streamed and realistic streamed.
#   burst     BURST requests at once with a key limited to 100 requests/min: how many get 200 vs 429.
# Run it behind `bash bench/quiet.sh <OUT>`; a build running alongside invalidates the overhead numbers.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PR="${PR:-4}"
OUT="${OUT:-$ROOT/bench/results/pr-$PR}"
MOCK_PORT="${MOCK_PORT:-9000}"
GATEWAY_PORT="${GATEWAY_PORT:-8080}"
RATE_INSTANT="${RATE_INSTANT:-1000}"     # req/s for the instant overhead comparison
RATE_REALISTIC="${RATE_REALISTIC:-200}"  # req/s for the realistic streamed comparison
WARMUP_S="${WARMUP_S:-30}"
DURATION_S="${DURATION_S:-60}"
BURST="${BURST:-1000}"
BURST_RPM="${BURST_RPM:-100}"
BURST_TPM="${BURST_TPM:-50000}"
HIGH_LIMIT=999999999                     # the CLI's largest accepted limit: never reached

mkdir -p "$OUT"
PIDS=()
KEYS=()
cleanup() {
  for p in "${PIDS[@]:-}"; do [ -n "$p" ] && kill "$p" 2>/dev/null || true; done
  for k in "${KEYS[@]:-}"; do
    [ -n "$k" ] && npm --prefix "$ROOT" run --silent keys -- revoke-key "${k:0:12}" >/dev/null 2>&1 || true
  done
}
trap cleanup EXIT

require_free_port() { # port: a stale server on it would be measured instead of ours
  if [ -n "$(lsof -ti "tcp:$1" -sTCP:LISTEN 2>/dev/null)" ]; then
    echo "port $1 is already in use; stop that process first" >&2; exit 1
  fi
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
start_mock() { # latency token_delay
  require_free_port "$MOCK_PORT"
  MOCK_PORT="$MOCK_PORT" MOCK_LATENCY_MS="$1" MOCK_TOKEN_DELAY_MS="$2" MOCK_COMPLETION_TOKENS=20 \
    node "$ROOT/packages/mock-provider/src/server.ts" >/dev/null &
  MOCK_PID=$!; PIDS+=("$MOCK_PID")
  wait_up "http://127.0.0.1:$MOCK_PORT/__control" 200 "$MOCK_PID"
}
start_gateway() { # RATE_LIMIT_ENABLED comes from the caller's environment (default true)
  require_free_port "$GATEWAY_PORT"
  GATEWAY_PORT="$GATEWAY_PORT" OPENAI_BASE_URL="http://127.0.0.1:$MOCK_PORT" \
    UPSTREAM_CONNECTIONS="${UPSTREAM_CONNECTIONS:-256}" LOG_LEVEL=warn RATE_LIMIT_ENABLED="${RATE_LIMIT_ENABLED:-true}" BUDGET_ENABLED="${BUDGET_ENABLED:-false}" \
    RATE_LIMIT_REDIS_TIMEOUT_MS="${RATE_LIMIT_REDIS_TIMEOUT_MS:-1000}" \
    node --env-file-if-exists="$ROOT/.env.local" "$ROOT/packages/gateway/src/server.ts" >/dev/null &
  GW_PID=$!; PIDS+=("$GW_PID")
  # No key sent, so a live gateway answers 401.
  wait_up "http://127.0.0.1:$GATEWAY_PORT/v1/chat/completions" 401 "$GW_PID"
}
stop_gateway() { kill "${GW_PID:-}" 2>/dev/null || true; wait "${GW_PID:-}" 2>/dev/null || true; GW_PID=""; }
stop() { kill "$MOCK_PID" "${GW_PID:-}" 2>/dev/null || true; wait "$MOCK_PID" "${GW_PID:-}" 2>/dev/null || true; GW_PID=""; }

new_key() { # label rpm tpm: prints the key once; it lives only in a shell variable
  local k
  k="$(npm --prefix "$ROOT" run --silent keys -- create-key bench "$1" --rpm "$2" --tpm "$3" 2>/dev/null)"
  case "$k" in gw_*) ;; *) echo "could not create a bench key (is Postgres up and migrated?)" >&2; exit 1;; esac
  KEYS+=("$k"); NEW_KEY="$k"
}

run_k6() { # name key stream rate warmup duration
  echo "== $1 (stream=$3 rate=$4/s)"
  rm -f "$OUT/$1.json"
  local rc=0
  API_KEY="$2" TARGET_URL="$GW" STREAM="$3" RATE="$4" WARMUP_S="$5" DURATION_S="$6" \
    k6 run --quiet --summary-export "$OUT/$1.json" "$ROOT/bench/k6/chat.js" >"$OUT/$1.log" 2>&1 || rc=$?
  # 99 is k6's "a threshold failed" exit code; any other non-zero code is a real failure.
  if [ "$rc" -ne 0 ] && [ "$rc" -ne 99 ]; then echo "k6 exited $rc for $1; see $OUT/$1.log" >&2; exit 1; fi
  if [ ! -s "$OUT/$1.json" ]; then echo "k6 did not write $OUT/$1.json" >&2; exit 1; fi
}

GW="http://127.0.0.1:$GATEWAY_PORT"
npm --prefix "$ROOT" run --silent keys -- create-tenant bench >/dev/null 2>&1 || true # exists on re-runs

# Overhead: limiter off, then on, for each profile.
new_key "rl-overhead-$(date +%s)" "$HIGH_LIMIT" "$HIGH_LIMIT"; HIGH_KEY="$NEW_KEY"
for profile in instant realistic; do
  if [ "$profile" = instant ]; then lat=0; tok=0; stream=false; rate=$RATE_INSTANT
  else lat=200; tok=10; stream=true; rate=$RATE_REALISTIC; fi
  start_mock "$lat" "$tok"
  for mode in off on; do
    if [ "$mode" = off ]; then export RATE_LIMIT_ENABLED=false; else export RATE_LIMIT_ENABLED=true; fi
    start_gateway
    run_k6 "gateway-$profile-ratelimit-$mode" "$HIGH_KEY" "$stream" "$rate" "$WARMUP_S" "$DURATION_S"
    stop_gateway
  done
  stop
done

# Burst: one key, BURST_RPM requests/min, BURST requests at the same moment, instant mock.
export RATE_LIMIT_ENABLED=true
new_key "rl-burst-$(date +%s)" "$BURST_RPM" "$BURST_TPM"; BURST_KEY="$NEW_KEY"
start_mock 0 0; start_gateway
echo "== burst ($BURST requests at once, key limited to $BURST_RPM/min)"
rm -f "$OUT/burst.json"
rc=0
API_KEY="$BURST_KEY" TARGET_URL="$GW" BURST="$BURST" \
  k6 run --quiet --summary-export "$OUT/burst.json" "$ROOT/bench/k6/burst.js" >"$OUT/burst.log" 2>&1 || rc=$?
if [ "$rc" -ne 0 ] && [ "$rc" -ne 99 ]; then echo "k6 exited $rc for the burst; see $OUT/burst.log" >&2; exit 1; fi
if [ ! -s "$OUT/burst.json" ]; then echo "k6 did not write $OUT/burst.json" >&2; exit 1; fi
stop

# The burst's own check. A key admits its bucket (BURST_RPM) plus what refilled while the burst was in
# flight, at BURST_RPM/60 per second; every request was sent at once, so the slowest request's duration
# bounds that window.
node -e '
const j = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).metrics;
const n = (m) => (j[m] && (j[m].count ?? j[m].value)) || 0;
const ok = n("status_200"), lim = n("status_429"), other = n("status_other"), ra = n("status_429_with_retry_after");
const windowS = (j.http_req_duration.max || 0) / 1000;
const maxAdmit = Number(process.argv[2]) + Math.floor(windowS * Number(process.argv[2]) / 60);
console.log(JSON.stringify({ admitted: ok, rejected: lim, other, rejectedWithRetryAfter: ra, windowS, maxAdmit }));
if (ok < Number(process.argv[2]) || ok > maxAdmit || other !== 0 || ra !== lim || ok + lim !== Number(process.argv[3])) {
  console.error("burst result outside what the limiter allows"); process.exit(1);
}
' "$OUT/burst.json" "$BURST_RPM" "$BURST"
echo "results in $OUT"
