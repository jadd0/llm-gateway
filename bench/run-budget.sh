#!/usr/bin/env bash
# Budget benchmark, run natively: mock provider, gateway and k6 on this machine.
# Usage: bash bench/run-budget.sh   (env overrides: OUT, RATE_INSTANT, RATE_REALISTIC, RATE_PG, FLOOD_ROUNDS, FLOOD, ...)
# Needs Postgres and Redis up (docker compose up -d --wait) and `npm run db:migrate` applied.
# Three parts:
#   overhead    the same request rate through the gateway with budgets off and on (rate limiter on in both),
#               for a tenant whose cap is too high to ever refuse, so the difference is the cost of the
#               reserve and settle. Instant non-streamed and realistic streamed.
#   flood       FLOOD_ROUNDS rounds; each round a fresh tenant with a FLOOD_CAP_USD cap is hit by FLOOD
#               requests at once. flood.json records what was admitted and refused, and from Postgres the
#               largest settled spend as a share of the cap and the largest overshoot in micro-USD.
#   redis-down  the gateway pointed at a Redis that is not there, so every decision is made on the
#               Postgres path: the same flood, and the instant overhead profile with budgets off and on
#               (auth reads Postgres in both, so the difference is the Postgres reserve and settle).
# Redis itself is never stopped (the compose Redis is shared); an unreachable REDIS_URL stands in for it.
# Run it behind `bash bench/quiet.sh <OUT>`; a build running alongside invalidates the overhead numbers.
set -euo pipefail
# Every client is 127.0.0.1, so the per-address failed-auth limiter would throttle the load; it is not what is measured.
export AUTH_FAIL_LIMIT_PER_MIN="${AUTH_FAIL_LIMIT_PER_MIN:-0}"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PR="${PR:-5}"
OUT="${OUT:-$ROOT/bench/results/pr-$PR}"
MOCK_PORT="${MOCK_PORT:-9000}"
GATEWAY_PORT="${GATEWAY_PORT:-8080}"
RATE_INSTANT="${RATE_INSTANT:-1000}"     # req/s for the instant overhead comparison
RATE_REALISTIC="${RATE_REALISTIC:-200}"  # req/s for the realistic streamed comparison
RATE_PG="${RATE_PG:-200}"                # req/s for the Postgres-path comparison
WARMUP_S="${WARMUP_S:-30}"
DURATION_S="${DURATION_S:-60}"
FLOOD_ROUNDS="${FLOOD_ROUNDS:-100}"
FLOOD="${FLOOD:-50}"
FLOOD_CAP_USD="${FLOOD_CAP_USD:-0.01}"
HIGH_LIMIT=999999999                     # the CLI's largest accepted limit: never reached
HIGH_CAP_USD=999999999                   # a cap no run gets near
RUN="$(date +%s)"

mkdir -p "${OUT:?}"
PIDS=()
KEYS=()
PREFIXES=()
cleanup() {
  for p in "${PIDS[@]:-}"; do [ -n "$p" ] && kill "$p" 2>/dev/null || true; done
  for k in "${KEYS[@]:-}"; do
    [ -n "$k" ] && npm --prefix "$ROOT" run --silent keys -- revoke-key "${k:0:12}" >/dev/null 2>&1 || true
  done
  for pre in "${PREFIXES[@]:-}"; do
    [ -n "$pre" ] && node --env-file-if-exists="$ROOT/.env.local" "$ROOT/bench/budget-tool.ts" cleanup "$pre" >/dev/null 2>&1 || true
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
start_mock() { # latency token_delay completion_tokens
  require_free_port "$MOCK_PORT"
  MOCK_PORT="$MOCK_PORT" MOCK_LATENCY_MS="$1" MOCK_TOKEN_DELAY_MS="$2" MOCK_COMPLETION_TOKENS="${3:-20}" \
    node "$ROOT/packages/mock-provider/src/server.ts" >/dev/null &
  MOCK_PID=$!; PIDS+=("$MOCK_PID")
  wait_up "http://127.0.0.1:$MOCK_PORT/__control" 200 "$MOCK_PID"
}
start_gateway() { # extra KEY=VALUE settings as arguments
  require_free_port "$GATEWAY_PORT"
  env GATEWAY_PORT="$GATEWAY_PORT" OPENAI_BASE_URL="http://127.0.0.1:$MOCK_PORT/v1" MOCK_BASE_URL="http://127.0.0.1:$MOCK_PORT" \
    UPSTREAM_CONNECTIONS="${UPSTREAM_CONNECTIONS:-256}" LOG_LEVEL=warn \
    RATE_LIMIT_REDIS_TIMEOUT_MS="${RATE_LIMIT_REDIS_TIMEOUT_MS:-1000}" \
    "$@" \
    node --env-file-if-exists="$ROOT/.env.local" "$ROOT/packages/gateway/src/server.ts" >/dev/null &
  GW_PID=$!; PIDS+=("$GW_PID")
  # No key sent, so a live gateway answers 401.
  wait_up "http://127.0.0.1:$GATEWAY_PORT/v1/chat/completions" 401 "$GW_PID"
}
stop_gateway() { kill "${GW_PID:-}" 2>/dev/null || true; wait "${GW_PID:-}" 2>/dev/null || true; GW_PID=""; }
stop() { kill "$MOCK_PID" "${GW_PID:-}" 2>/dev/null || true; wait "$MOCK_PID" "${GW_PID:-}" 2>/dev/null || true; GW_PID=""; }

new_key() { # label: a high-limit key on the bench tenant; prints once, lives only in a shell variable
  local k
  k="$(npm --prefix "$ROOT" run --silent keys -- create-key bench "$1" --rpm "$HIGH_LIMIT" --tpm "$HIGH_LIMIT" 2>/dev/null)"
  case "$k" in gw_*) ;; *) echo "could not create a bench key (is Postgres up and migrated?)" >&2; exit 1;; esac
  KEYS+=("$k"); NEW_KEY="$k"
}

check_k6() { # name rc
  # 99 is k6's "a threshold failed" exit code; any other non-zero code is a real failure.
  if [ "$2" -ne 0 ] && [ "$2" -ne 99 ]; then echo "k6 exited $2 for $1; see $OUT/$1.log" >&2; exit 1; fi
  if [ ! -s "$OUT/$1.json" ]; then echo "k6 did not write $OUT/$1.json" >&2; exit 1; fi
}
run_k6() { # name key stream rate warmup duration
  echo "== $1 (stream=$3 rate=$4/s)"
  rm -f "${OUT:?}/$1.json"
  local rc=0
  API_KEY="$2" TARGET_URL="$GW" STREAM="$3" RATE="$4" WARMUP_S="$5" DURATION_S="$6" \
    k6 run --quiet --summary-export "$OUT/$1.json" "$ROOT/bench/k6/chat.js" >"$OUT/$1.log" 2>&1 || rc=$?
  check_k6 "$1" "$rc"
}

# One flood: FLOOD_ROUNDS fresh tenants, each hit by FLOOD requests at once. Writes $OUT/<name>.json
# (the k6 counters plus what Postgres says each tenant settled).
run_flood() { # name
  local name="$1" pre="bf-$RUN-$1" keys rc=0
  PREFIXES+=("$pre")
  echo "== $name ($FLOOD_ROUNDS rounds x $FLOOD at once, cap \$$FLOOD_CAP_USD per round)"
  keys="$(node --env-file-if-exists="$ROOT/.env.local" "$ROOT/bench/budget-tool.ts" setup "$pre" "$FLOOD_ROUNDS" "$FLOOD_CAP_USD" | paste -sd, -)"
  [ -n "$keys" ] || { echo "could not create the flood tenants" >&2; exit 1; }
  rm -f "${OUT:?}/$name-k6.json"
  TARGET_URL="$GW" FLOOD="$FLOOD" \
    k6 run --quiet --summary-export "$OUT/$name-k6.json" -e KEYS="$keys" "$ROOT/bench/k6/budget-flood.js" >"$OUT/$name.log" 2>&1 || rc=$?
  check_k6 "$name-k6" "$rc"
  # Settles are written after the response; wait until every admitted request has its ledger row.
  local admitted measured="" last=""
  admitted="$(node -e 'const m=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).metrics;console.log((m.status_200&&m.status_200.count)||0)' "$OUT/$name-k6.json")"
  for _ in $(seq 1 120); do
    measured="$(node --env-file-if-exists="$ROOT/.env.local" "$ROOT/bench/budget-tool.ts" measure "$pre")"
    last="$(node -e 'console.log(JSON.parse(process.argv[1]).ledgerRows)' "$measured")"
    [ "$last" = "$admitted" ] && break
    sleep 0.5
  done
  node -e '
    const fs = require("fs");
    const [k6path, measured, out, rounds, flood, cap] = process.argv.slice(1);
    const m = JSON.parse(fs.readFileSync(k6path, "utf8")).metrics;
    const c = (n) => (m[n] && m[n].count) || 0;
    const res = JSON.parse(measured);
    const summary = {
      rounds: Number(rounds), requestsPerRound: Number(flood), capUsd: cap,
      admitted: c("status_200"), refused402: c("status_402"), refused402WithBudgetExhaustedBody: c("status_402_budget_exhausted"), other: c("status_other"),
      ...res,
    };
    fs.writeFileSync(out, JSON.stringify(summary, null, 2) + "\n");
    console.log(JSON.stringify(summary));
    if (summary.other !== 0 || summary.admitted + summary.refused402 !== summary.rounds * summary.requestsPerRound) {
      console.error("flood: some answers were neither 200 nor 402"); process.exit(1);
    }
    if (summary.ledgerRows !== summary.admitted) {
      console.error("flood: ledger rows (" + summary.ledgerRows + ") differ from admitted (" + summary.admitted + "): settles had not all landed"); process.exit(1);
    }
  ' "$OUT/$name-k6.json" "$measured" "$OUT/$name.json" "$FLOOD_ROUNDS" "$FLOOD" "$FLOOD_CAP_USD"
}

GW="http://127.0.0.1:$GATEWAY_PORT"
npm --prefix "$ROOT" run --silent keys -- create-tenant bench >/dev/null 2>&1 || true # exists on re-runs
npm --prefix "$ROOT" run --silent keys -- set-budget bench --monthly-usd "$HIGH_CAP_USD" >/dev/null 2>&1 \
  || { echo "could not set the bench tenant's budget (is Postgres up and migrated?)" >&2; exit 1; }
new_key "budget-overhead-$RUN"; HIGH_KEY="$NEW_KEY"

# Overhead: budgets off, then on, for each profile.
for profile in instant realistic; do
  if [ "$profile" = instant ]; then lat=0; tok=0; stream=false; rate=$RATE_INSTANT
  else lat=200; tok=10; stream=true; rate=$RATE_REALISTIC; fi
  start_mock "$lat" "$tok"
  for mode in off on; do
    if [ "$mode" = off ]; then enabled=false; else enabled=true; fi
    start_gateway BUDGET_ENABLED="$enabled"
    run_k6 "gateway-$profile-budget-$mode" "$HIGH_KEY" "$stream" "$rate" "$WARMUP_S" "$DURATION_S"
    stop_gateway
  done
  stop
done

# Flood with Redis up: the mock answers after 300 ms and uses all 100 of max_tokens, so a round's
# requests are all decided while the first ones are still in flight, and what is settled is close to
# what was reserved.
start_mock 300 0 100
start_gateway BUDGET_ENABLED=true
run_flood flood
stop_gateway

# Redis down: a REDIS_URL nothing listens on. Auth reads Postgres (AUTH_CACHE=none) and the rate limiter
# is off, so the budget's Postgres path is the only thing that differs between "off" and "on".
DOWN=(REDIS_URL=redis://127.0.0.1:1 AUTH_CACHE=none RATE_LIMIT_ENABLED=false)
start_gateway BUDGET_ENABLED=true "${DOWN[@]}"
run_flood flood-redis-down
stop_gateway
stop
start_mock 0 0
for mode in off on; do
  if [ "$mode" = off ]; then enabled=false; else enabled=true; fi
  start_gateway BUDGET_ENABLED="$enabled" "${DOWN[@]}"
  run_k6 "gateway-instant-redis-down-budget-$mode" "$HIGH_KEY" false "$RATE_PG" "$WARMUP_S" "$DURATION_S"
  stop_gateway
done
stop
echo "results in $OUT"
