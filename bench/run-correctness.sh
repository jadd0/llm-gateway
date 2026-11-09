#!/usr/bin/env bash
# Correctness under concurrency against a running cluster (bench/cluster.sh up, 3 instances behind nginx).
# Usage: OUT=<dir> RUNS=10 bash bench/run-correctness.sh   (env: TARGET_URL, RUNS, FLOOD_ROUNDS, FLOOD, FLOOD_CAP_USD, BURST, BURST_RPM, FAILOVER_AT_S)
# Needs the cluster started with BUDGET_ENABLED=true, RATE_LIMIT_ENABLED=true, the log worker, a mock answering after
# 300 ms with 100 completion tokens (run-all.sh starts it that way), and `docker compose` for the Redis restart.
# Each of RUNS runs does three things and writes one JSON file for each:
#   ratelimit-<n>.json         BURST requests at once on a key limited to BURST_RPM per minute; the status-200 rows the
#                              request log holds for that key are the admissions (the client's count is kept for comparison).
#                              The refill window is first request to last admitted request by the log's own timestamps.
#                              A 429 that is not rate_limit_exceeded, any other status, or a log that never catches up is recorded and fails the run in the summary
#   budget-<n>.json            FLOOD_ROUNDS tenants with a FLOOD_CAP_USD cap, each hit by FLOOD requests at once; Postgres
#                              says how many tenants settled above their cap
#   budget-failover-<n>.json   the same flood while Redis is restarted FAILOVER_AT_S seconds in
# bench/final-summary.ts reads those files; a pass is zero over-limit admissions and zero tenants over cap in every run.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="${OUT:?OUT is required (the results folder)}/correctness"
GW="${TARGET_URL:-http://127.0.0.1:8080}"
RUNS="${RUNS:-10}"
FLOOD_ROUNDS="${FLOOD_ROUNDS:-40}"
FLOOD="${FLOOD:-50}"
FLOOD_CAP_USD="${FLOOD_CAP_USD:-0.01}"
BURST="${BURST:-1000}"
BURST_RPM="${BURST_RPM:-100}"
FAILOVER_AT_S="${FAILOVER_AT_S:-5}"
RUN="$(date +%s)"
TOOL=(node --env-file-if-exists="$ROOT/.env.local")

mkdir -p "${OUT:?}"
TENANTS=()
PREFIXES=()
cleanup() {
  for t in "${TENANTS[@]:-}"; do [ -n "$t" ] && "${TOOL[@]}" "$ROOT/bench/correctness-tool.ts" cleanup "$t" >/dev/null 2>&1 || true; done
  for p in "${PREFIXES[@]:-}"; do [ -n "$p" ] && "${TOOL[@]}" "$ROOT/bench/budget-tool.ts" cleanup "$p" >/dev/null 2>&1 || true; done
}
trap cleanup EXIT

k6_ok() { # name rc json
  # 99 is k6's "a threshold failed" exit code; any other non-zero code is a real failure.
  if [ "$2" -ne 0 ] && [ "$2" -ne 99 ]; then echo "k6 exited $2 for $1" >&2; exit 1; fi
  [ -s "$3" ] || { echo "k6 did not write $3" >&2; exit 1; }
}
metric() { # file metric field
  node -e 'const m=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).metrics[process.argv[2]];console.log((m&&m[process.argv[3]])||0)' "$1" "$2" "$3"
}

ratelimit_run() { # n
  local n="$1" tenant="rl-$RUN-$1" lines key keyid rc=0 raw="$OUT/.ratelimit-$1-k6.json"
  TENANTS+=("$tenant")
  lines="$("${TOOL[@]}" "$ROOT/bench/correctness-tool.ts" key "$tenant" "$BURST_RPM")"
  key="$(sed -n 1p <<<"$lines")"; keyid="$(sed -n 2p <<<"$lines")"
  case "$key" in gw_*) ;; *) echo "could not create the rate-limit key" >&2; exit 1;; esac
  echo "== ratelimit run $n ($BURST at once, $BURST_RPM/min)"
  API_KEY="$key" TARGET_URL="$GW" BURST="$BURST" k6 run --quiet --summary-export "$raw" "$ROOT/bench/k6/burst.js" >"$OUT/.ratelimit-$n.log" 2>&1 || rc=$?
  k6_ok "ratelimit run $n" "$rc" "$raw"
  local k6_ok_n counted="" prev="-1" caught=false log_n=0
  k6_ok_n="$(metric "$raw" status_200 count)"
  # The worker writes the log in batches: wait until the count has stopped moving and covers what the client saw.
  # If it never does, the run is recorded as not caught up, which the summary counts as a failure.
  for _ in $(seq 1 120); do
    counted="$("${TOOL[@]}" "$ROOT/bench/correctness-tool.ts" count "$keyid")"
    log_n="$(node -e 'console.log(JSON.parse(process.argv[1]).admitted)' "$counted")"
    if [ "$log_n" = "$prev" ] && [ "$log_n" -ge "$k6_ok_n" ]; then caught=true; break; fi
    prev="$log_n"; sleep 1
  done
  node -e '
    const fs = require("fs");
    const [raw, out, rpm, burst, counted, caught] = process.argv.slice(1);
    const m = JSON.parse(fs.readFileSync(raw, "utf8")).metrics;
    const c = (n) => (m[n] && m[n].count) || 0;
    const log = JSON.parse(counted);
    const r = { rpm: Number(rpm), windowS: log.windowS, burst: Number(burst), admittedLog: log.admitted, admittedK6: c("status_200"), rejected429: c("status_429"), other429: c("status_429_other_code"), other: c("status_other"), logCaughtUp: caught === "true" };
    fs.writeFileSync(out, JSON.stringify(r, null, 2) + "\n"); console.log(JSON.stringify(r));
  ' "$raw" "$OUT/ratelimit-$n.json" "$BURST_RPM" "$BURST" "$counted" "$caught"
  rm -f "$raw"
}

flood_run() { # name n restart-redis(0|1)
  local name="$1" n="$2" restart="$3" pre="bf-$RUN-$1-$2" keys rc=0 raw="$OUT/.$1-$2-k6.json" measured="" last="" admitted
  PREFIXES+=("$pre")
  echo "== $name run $n ($FLOOD_ROUNDS rounds x $FLOOD, cap \$$FLOOD_CAP_USD, restart redis: $restart)"
  keys="$("${TOOL[@]}" "$ROOT/bench/budget-tool.ts" setup "$pre" "$FLOOD_ROUNDS" "$FLOOD_CAP_USD" | paste -sd, -)"
  [ -n "$keys" ] || { echo "could not create the flood tenants" >&2; exit 1; }
  TARGET_URL="$GW" FLOOD="$FLOOD" k6 run --quiet --summary-export "$raw" -e KEYS="$keys" "$ROOT/bench/k6/budget-flood.js" >"$OUT/.$name-$n.log" 2>&1 &
  local k6pid=$!
  if [ "$restart" = 1 ]; then
    sleep "$FAILOVER_AT_S"
    docker compose -f "$ROOT/docker-compose.yml" restart redis >/dev/null 2>&1 || echo "WARNING: redis restart failed" >&2
  fi
  wait "$k6pid" || rc=$?
  k6_ok "$name run $n" "$rc" "$raw"
  admitted="$(metric "$raw" status_200 count)"
  # Settles are written after the response; wait until every admitted request has its ledger row.
  for _ in $(seq 1 240); do
    measured="$("${TOOL[@]}" "$ROOT/bench/budget-tool.ts" measure "$pre")"
    last="$(node -e 'console.log(JSON.parse(process.argv[1]).ledgerRows)' "$measured")"
    [ "$last" = "$admitted" ] && break
    sleep 0.5
  done
  node -e '
    const fs = require("fs");
    const [raw, measured, out, rounds, flood] = process.argv.slice(1);
    const m = JSON.parse(fs.readFileSync(raw, "utf8")).metrics;
    const c = (n) => (m[n] && m[n].count) || 0;
    const res = JSON.parse(measured);
    const r = { rounds: Number(rounds), requestsPerRound: Number(flood), admitted: c("status_200"), refused402: c("status_402"), other: c("status_other"), ...res };
    fs.writeFileSync(out, JSON.stringify(r, null, 2) + "\n"); console.log(JSON.stringify(r));
    if (r.admitted + r.refused402 + r.other !== r.rounds * r.requestsPerRound) { console.error("flood: requests unaccounted for"); process.exit(1); }
  ' "$raw" "$measured" "$OUT/$name-$n.json" "$FLOOD_ROUNDS" "$FLOOD"
  rm -f "$raw"
}

for n in $(seq 1 "$RUNS"); do
  ratelimit_run "$n"
  flood_run budget "$n" 0
  flood_run budget-failover "$n" 1
done
echo "results in $OUT"
