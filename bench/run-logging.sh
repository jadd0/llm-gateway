#!/usr/bin/env bash
# Request-logging benchmark, run natively: mock provider, gateway, log worker and k6 on this machine.
# Usage: bash bench/run-logging.sh   (env overrides: OUT, RATE, WARMUP_S, DURATION_S, REPEATS, ...)
# Needs Postgres and Redis up (docker compose up -d --wait), `npm run db:migrate` applied, and API_KEY_PEPPER set
# (32+ characters, in .env.local or the environment).
# The same constant request rate twice, REPEATS times each:
#   inline   LOG_MODE=inline: one awaited Postgres insert per request, on the request path
#   stream   LOG_MODE=stream: one XADD per request, the log worker writes batches to Postgres
# In stream mode the worker is sampled every second (stream lag, pending entries, rows in request_log).
# bench/logging-summary.ts then writes summary.md from the k6 JSON and the samples alone.
# Run it behind `bash bench/quiet.sh <OUT>`; a build running alongside invalidates the latency numbers.
set -euo pipefail
# Every client is 127.0.0.1, so the per-address failed-auth limiter would throttle the load; it is not what is measured.
export AUTH_FAIL_LIMIT_PER_MIN="${AUTH_FAIL_LIMIT_PER_MIN:-0}"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PR="${PR:-10}"
OUT="${OUT:-$ROOT/bench/results/pr-$PR}"
MOCK_PORT="${MOCK_PORT:-9000}"
GATEWAY_PORT="${GATEWAY_PORT:-8080}"
RATE="${RATE:-200}"
WARMUP_S="${WARMUP_S:-10}"
DURATION_S="${DURATION_S:-60}"
REPEATS="${REPEATS:-3}"
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

# One sample: ms since start, stream lag, pending entries, rows in request_log. Args: prefix group start_ms
sample() {
  node --env-file-if-exists="$ROOT/.env.local" -e '
    const { Redis } = require("ioredis"); const pg = require("pg");
    const [prefix, group, start] = process.argv.slice(1);
    (async () => {
      const r = new Redis(process.env.REDIS_URL); const c = new pg.Client({ connectionString: process.env.DATABASE_URL });
      await c.connect();
      let lag = 0, pending = 0;
      try {
        for (const g of await r.xinfo("GROUPS", prefix + "requestlog")) {
          const m = Object.fromEntries(g.reduce((a, v, i) => (i % 2 ? a : [...a, [v, g[i + 1]]]), []));
          if (m.name === group) { lag = Number(m.lag ?? 0); pending = Number(m.pending ?? 0); }
        }
      } catch {}
      const rows = Number((await c.query("select count(*) as n from request_log where created_at >= to_timestamp($1 / 1000.0)", [start])).rows[0].n);
      console.log([Date.now() - Number(start), lag, pending, rows].join(","));
      r.disconnect(); await c.end();
    })().catch((e) => { console.error(e.code || e.name); process.exit(1); });
  ' "$@"
}

require_free_port "$MOCK_PORT"
MOCK_PORT="$MOCK_PORT" MOCK_LATENCY_MS=200 MOCK_TOKEN_DELAY_MS=10 MOCK_COMPLETION_TOKENS=20 \
  node "$ROOT/packages/mock-provider/src/server.ts" >/dev/null &
MOCK_PID=$!; PIDS+=("$MOCK_PID")
wait_up "http://127.0.0.1:$MOCK_PORT/__control" 200 "$MOCK_PID"

npm --prefix "$ROOT" run --silent keys -- create-tenant bench >/dev/null 2>&1 || true # exists on re-runs
npm --prefix "$ROOT" run --silent keys -- set-budget bench --monthly-usd "$HIGH_CAP_USD" >/dev/null 2>&1 \
  || { echo "could not set the bench tenant's budget (is Postgres up and migrated?)" >&2; exit 1; }
KEY="$(npm --prefix "$ROOT" run --silent keys -- create-key bench "logging-$RUN" --rpm "$HIGH_LIMIT" --tpm "$HIGH_LIMIT" 2>/dev/null)"
case "$KEY" in gw_*) ;; *) echo "could not create a bench key (is Postgres up and migrated?)" >&2; exit 1;; esac
KEYS+=("$KEY")

run_once() { # mode repeat
  local mode="$1" rep="$2" prefix="bench-log-$RUN-$1-$2:" group="bench-$1-$2"
  require_free_port "$GATEWAY_PORT"
  echo "== $mode #$rep"
  env GATEWAY_PORT="$GATEWAY_PORT" OPENAI_BASE_URL="http://127.0.0.1:$MOCK_PORT/v1" MOCK_BASE_URL="http://127.0.0.1:$MOCK_PORT" \
    LOG_LEVEL=warn REDIS_KEY_PREFIX="$prefix" LOG_MODE="$mode" LOG_GROUP="$group" CACHE_ENABLED=false BUDGET_ENABLED=true RATE_LIMIT_ENABLED=true \
    RATE_LIMIT_REDIS_TIMEOUT_MS="${RATE_LIMIT_REDIS_TIMEOUT_MS:-1000}" \
    node --env-file-if-exists="$ROOT/.env.local" "$ROOT/packages/gateway/src/server.ts" >/dev/null &
  local gw_pid=$!
  local worker_pid="" sampler_pid=""
  wait_up "http://127.0.0.1:$GATEWAY_PORT/v1/chat/completions" 401 "$gw_pid"
  local start_ms; start_ms="$(node -e 'console.log(Date.now())')"
  # The worker runs in both modes: it applies the spend stream (budget settles) whichever way the log is written.
  # Without it every hold lapses and budget rebuilds slow the gateway to a stall.
  env REDIS_KEY_PREFIX="$prefix" LOG_GROUP="$group" LOG_LEVEL=warn \
    node --env-file-if-exists="$ROOT/.env.local" "$ROOT/packages/log-worker/src/worker.ts" >/dev/null &
  worker_pid=$!; PIDS+=("$worker_pid")
  sleep 1; kill -0 "$worker_pid" 2>/dev/null || { echo "the log worker exited at start" >&2; exit 1; }
  if [ "$mode" = stream ]; then
    local csv="$OUT/worker-stream-$rep.csv"
    echo "t_ms,lag,pending,rows" >"$csv"
    ( while kill -0 "$gw_pid" 2>/dev/null; do sample "$prefix" "$group" "$start_ms" >>"$csv" || true; sleep 1; done ) &
    sampler_pid=$!
  fi
  local rc=0
  rm -f "${OUT:?}/logging-$mode-$rep.json"
  API_KEY="$KEY" TARGET_URL="http://127.0.0.1:$GATEWAY_PORT" NONCE="$RUN-$mode-$rep" RATE="$RATE" WARMUP_S="$WARMUP_S" DURATION_S="$DURATION_S" MODEL=mock-model \
    k6 run --quiet --summary-export "$OUT/logging-$mode-$rep.json" "$ROOT/bench/k6/logging.js" >"$OUT/logging-$mode-$rep.log" 2>&1 || rc=$?
  if [ "$rc" -ne 0 ] && [ "$rc" -ne 99 ]; then echo "k6 exited $rc for $mode #$rep; see $OUT/logging-$mode-$rep.log" >&2; exit 1; fi
  if [ ! -s "$OUT/logging-$mode-$rep.json" ]; then echo "k6 did not write $OUT/logging-$mode-$rep.json" >&2; exit 1; fi
  if [ -n "$sampler_pid" ]; then
    # Let the worker drain what is queued before measuring stops, so lag shows how long that took.
    for _ in $(seq 1 60); do sleep 1; if grep -q ",0,0," <(tail -n 1 "$OUT/worker-stream-$rep.csv"); then break; fi; done
    kill "$sampler_pid" 2>/dev/null || true
  fi
  kill -TERM "$worker_pid" 2>/dev/null || true; wait "$worker_pid" 2>/dev/null || true
  kill -TERM "$gw_pid" 2>/dev/null || true; wait "$gw_pid" 2>/dev/null || true
}

for rep in $(seq 1 "$REPEATS"); do
  run_once inline "$rep"
  run_once stream "$rep"
done

node "$ROOT/bench/logging-summary.ts" "$OUT"
node --env-file-if-exists="$ROOT/.env.local" -e '
  const { Redis } = require("ioredis");
  const r = new Redis(process.env.REDIS_URL);
  (async () => {
    const keys = [];
    for await (const batch of r.scanStream({ match: "bench-log-" + process.argv[1] + "-*", count: 500 })) keys.push(...batch);
    for (let i = 0; i < keys.length; i += 500) await r.del(...keys.slice(i, i + 500));
    r.disconnect();
  })().catch(() => r.disconnect());
' "$RUN" || true
echo "results in $OUT"
