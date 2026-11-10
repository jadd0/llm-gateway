#!/usr/bin/env bash
# Semantic cache latency benchmark, run natively: mock provider, gateway and k6 on this machine.
# Usage: bash bench/run-semantic.sh   (env overrides: OUT, SEEDS, RATE, DURATION_S, SETTLE_S, ...)
# Needs Postgres and Redis up and migrated (docker compose up -d --wait; npm run db:migrate), and an embedder:
# VOYAGE_API_KEY in the environment, or the local model (docker compose up -d ollama ollama-pull).
# Four k6 runs against one gateway (cache, semantic cache, budgets and rate limiter on; mock provider with realistic latency):
#   seed         SEEDS original prompts, once each (all misses); the script then waits for the semantic index to hold them
#   paraphrase   another wording of a seeded prompt per request
#   exact        a seeded prompt repeated per request
#   miss         a prompt nobody has sent per request
# bench/semantic/latency-summary.ts then writes latency.md from the k6 JSON alone.
# Run it behind `bash bench/quiet.sh <OUT>`; a build running alongside invalidates the latency numbers.
set -euo pipefail
# Every client is 127.0.0.1, so the per-address failed-auth limiter would throttle the load; it is not what is measured.
export AUTH_FAIL_LIMIT_PER_MIN="${AUTH_FAIL_LIMIT_PER_MIN:-0}"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PR="${PR:-9}"
OUT="${OUT:-$ROOT/bench/results/pr-$PR}"
MOCK_PORT="${MOCK_PORT:-9000}"
GATEWAY_PORT="${GATEWAY_PORT:-8080}"
SEEDS="${SEEDS:-200}"
RATE="${RATE:-10}"
DURATION_S="${DURATION_S:-30}"
SETTLE_S="${SETTLE_S:-120}"
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

# An embedder must be there, or every "semantic" request would be a plain miss and the table would say so.
OLLAMA="${OLLAMA_URL:-http://127.0.0.1:11434}"
if [ -z "${VOYAGE_API_KEY:-}" ] && ! curl -sf "$OLLAMA/api/tags" >/dev/null; then
  echo "no VOYAGE_API_KEY and no Ollama at $OLLAMA: start it with docker compose up -d ollama ollama-pull" >&2; exit 1
fi

require_free_port "$MOCK_PORT"
MOCK_PORT="$MOCK_PORT" MOCK_LATENCY_MS=200 MOCK_TOKEN_DELAY_MS=10 MOCK_COMPLETION_TOKENS=20 \
  node "$ROOT/packages/mock-provider/src/server.ts" >/dev/null &
MOCK_PID=$!; PIDS+=("$MOCK_PID")
wait_up "http://127.0.0.1:$MOCK_PORT/__control" 200 "$MOCK_PID"

require_free_port "$GATEWAY_PORT"
# The cache entries of every run live under this prefix and are removed with it at the end.
PREFIX="bench-semantic-$RUN:"
env GATEWAY_PORT="$GATEWAY_PORT" OPENAI_BASE_URL="http://127.0.0.1:$MOCK_PORT/v1" MOCK_BASE_URL="http://127.0.0.1:$MOCK_PORT" \
  LOG_LEVEL=warn REDIS_KEY_PREFIX="$PREFIX" CACHE_ENABLED=true SEMANTIC_ENABLED=true BUDGET_ENABLED=true RATE_LIMIT_ENABLED=true \
  RATE_LIMIT_REDIS_TIMEOUT_MS="${RATE_LIMIT_REDIS_TIMEOUT_MS:-1000}" CACHE_REDIS_TIMEOUT_MS="${CACHE_REDIS_TIMEOUT_MS:-200}" \
  node --env-file-if-exists="$ROOT/.env.local" "$ROOT/packages/gateway/src/server.ts" >"$OUT/semantic-gateway.log" 2>&1 &
GW_PID=$!; PIDS+=("$GW_PID")
GW="http://127.0.0.1:$GATEWAY_PORT"
wait_up "$GW/v1/chat/completions" 401 "$GW_PID"

npm --prefix "$ROOT" run --silent keys -- create-tenant bench >/dev/null 2>&1 || true # exists on re-runs
npm --prefix "$ROOT" run --silent keys -- set-budget bench --monthly-usd "$HIGH_CAP_USD" >/dev/null 2>&1 \
  || { echo "could not set the bench tenant's budget (is Postgres up and migrated?)" >&2; exit 1; }
npm --prefix "$ROOT" run --silent keys -- set-semantic-cache bench on >/dev/null 2>&1 \
  || { echo "could not switch the bench tenant's semantic cache on" >&2; exit 1; }
KEY="$(npm --prefix "$ROOT" run --silent keys -- create-key bench "semantic-$RUN" --rpm "$HIGH_LIMIT" --tpm "$HIGH_LIMIT" 2>/dev/null)"
case "$KEY" in gw_*) ;; *) echo "could not create a bench key (is Postgres up and migrated?)" >&2; exit 1;; esac
KEYS+=("$KEY")

run_k6() { # name scenario
  echo "== $1"
  rm -f "${OUT:?}/semantic-$1.json"
  local rc=0
  API_KEY="$KEY" TARGET_URL="$GW" SCENARIO="$2" NONCE="$RUN" SEEDS="$SEEDS" RATE="$RATE" DURATION_S="$DURATION_S" \
    k6 run --quiet --summary-export "$OUT/semantic-$1.json" "$ROOT/bench/k6/semantic.js" >"$OUT/semantic-$1.log" 2>&1 || rc=$?
  # 99 is k6's "a threshold failed" exit code; any other non-zero code is a real failure.
  if [ "$rc" -ne 0 ] && [ "$rc" -ne 99 ]; then echo "k6 exited $rc for $1; see $OUT/semantic-$1.log" >&2; exit 1; fi
  if [ ! -s "$OUT/semantic-$1.json" ]; then echo "k6 did not write $OUT/semantic-$1.json" >&2; exit 1; fi
}

# Counts this run's rows in the semantic index.
index_rows() {
  node --env-file-if-exists="$ROOT/.env.local" -e '
    const pg = require("pg");
    const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
    pool.query("select count(*)::int as n from semantic_cache where exact_key like $1", [process.argv[1] + "%"])
      .then((r) => { console.log(r.rows[0].n); return pool.end(); })
      .catch(() => { console.log(-1); return pool.end(); });
  ' "$PREFIX"
}

run_k6 seed seed
# The index is filled behind the responses, so the paraphrases wait until it holds the seeds (or the wait runs out).
waited=0
until [ "$(index_rows)" -ge "$SEEDS" ] || [ "$waited" -ge "$SETTLE_S" ]; do sleep 2; waited=$((waited + 2)); done
rows="$(index_rows)"
echo "semantic index holds $rows of $SEEDS seeds after ${waited}s" | tee "$OUT/semantic-index.txt"
run_k6 paraphrase paraphrase
run_k6 exact exact
run_k6 miss miss

node "$ROOT/bench/semantic/latency-summary.ts" "$OUT"
# Entries expire by themselves; remove this run's now rather than leave them for the TTL.
node --env-file-if-exists="$ROOT/.env.local" -e '
  const { Redis } = require("ioredis");
  const pg = require("pg");
  const r = new Redis(process.env.REDIS_URL);
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
  (async () => {
    const keys = [];
    for await (const batch of r.scanStream({ match: process.argv[1] + "*", count: 500 })) keys.push(...batch);
    for (let i = 0; i < keys.length; i += 500) await r.del(...keys.slice(i, i + 500));
    await pool.query("delete from semantic_cache where exact_key like $1", [process.argv[1] + "%"]);
    r.disconnect();
    await pool.end();
  })().catch(() => { r.disconnect(); pool.end(); });
' "$PREFIX" || true
echo "results in $OUT"
