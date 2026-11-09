#!/usr/bin/env bash
# The benchmark cluster: one mock provider, N gateways on BASE_PORT..BASE_PORT+N-1, the log worker and nginx
# in front on NGINX_PORT, all native processes on this machine. Runs in the foreground; on exit (Ctrl-C, SIGTERM,
# or any process dying at start) it stops everything it started. Meant to be backgrounded by bench/run-all.sh.
#
# Usage:
#   bash bench/cluster.sh up              start the cluster, write $CLUSTER_DIR/ready when healthy, then wait
#   bash bench/cluster.sh nginx <listen-port> <gateway-port>...
#                                         nginx alone in front of gateways someone else runs (the chaos run)
#   bash bench/cluster.sh render <listen-port> <gateway-port>...
#                                         print the nginx.conf that would be used (checked by `nginx -t` in smoke runs)
# Env (all optional):
#   INSTANCES=3  BASE_PORT=3101  NGINX_PORT=8080  MOCK_PORT=9000  CLUSTER_DIR=<tmp dir>
#   MOCK_LATENCY_MS=0 MOCK_TOKEN_DELAY_MS=0 MOCK_COMPLETION_TOKENS=20   mock provider settings
#   WITH_WORKER=1       start the request-log worker (set 0 for LOG_MODE=inline runs)
#   GATEWAY_NODE_ARGS   extra node flags for gateway 1 only, e.g. "--cpu-prof --cpu-prof-dir=/path"
#   Anything else in the environment (BUDGET_ENABLED, RATE_LIMIT_ENABLED, REDIS_URL, ...) reaches every gateway.
# Needs Postgres and Redis up (docker compose up -d --wait), `npm run db:migrate` applied, nginx on PATH.
set -euo pipefail
# Every client is 127.0.0.1, so the per-address failed-auth limiter would throttle the load; it is not what is measured.
export AUTH_FAIL_LIMIT_PER_MIN="${AUTH_FAIL_LIMIT_PER_MIN:-0}"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MODE="${1:-up}"
INSTANCES="${INSTANCES:-3}"
BASE_PORT="${BASE_PORT:-3101}"
NGINX_PORT="${NGINX_PORT:-8080}"
MOCK_PORT="${MOCK_PORT:-9000}"
WITH_WORKER="${WITH_WORKER:-1}"
CLUSTER_DIR="${CLUSTER_DIR:-${TMPDIR:-/tmp}/llm-gateway-cluster-$$}"
PIDS=()

require_free_port() { # a stale server on it would be measured instead of ours
  if [ -n "$(lsof -ti "tcp:$1" -sTCP:LISTEN 2>/dev/null)" ]; then
    echo "cluster: port $1 is already in use; stop that process first" >&2; exit 1
  fi
}
wait_up() { # url expected-http-status pid
  local code
  for _ in $(seq 1 100); do
    if ! kill -0 "$3" 2>/dev/null; then echo "cluster: process $3 exited before answering $1" >&2; exit 1; fi
    code=$(curl -s -o /dev/null -w '%{http_code}' "$1" || true)
    if [ "$code" = "$2" ]; then return 0; fi
    sleep 0.2
  done
  echo "cluster: timed out waiting for $1 to answer $2 (last status: ${code:-none})" >&2; exit 1
}
cleanup() {
  trap - EXIT INT TERM
  for p in "${PIDS[@]:-}"; do [ -n "$p" ] && kill "$p" 2>/dev/null || true; done
  for p in "${PIDS[@]:-}"; do [ -n "$p" ] && wait "$p" 2>/dev/null || true; done
}

render_conf() { # listen-port gateway-port...
  local listen="$1"; shift
  local lines="" p
  for p in "$@"; do lines+="    server 127.0.0.1:$p max_fails=1 fail_timeout=5s;"$'\n'; done
  # The upstream block is multi-line, so awk splices it in (passed by environment: BSD awk rejects newlines in -v).
  UPS="${lines%$'\n'}" LISTEN="127.0.0.1:$listen" PREFIX="$CLUSTER_DIR" awk '
    /^__UPSTREAMS__$/ { print ENVIRON["UPS"]; next }
    { gsub(/__LISTEN__/, ENVIRON["LISTEN"]); gsub(/__PREFIX__/, ENVIRON["PREFIX"]); print }
  ' "$ROOT/bench/nginx/nginx.conf"
}
start_nginx() { # listen-port gateway-port...
  local listen="$1"; shift
  require_free_port "$listen"
  mkdir -p "$CLUSTER_DIR/logs" "$CLUSTER_DIR/temp"
  render_conf "$listen" "$@" >"$CLUSTER_DIR/nginx.conf"
  nginx -t -e "$CLUSTER_DIR/logs/error.log" -p "$CLUSTER_DIR" -c "$CLUSTER_DIR/nginx.conf" >"$CLUSTER_DIR/nginx-test.log" 2>&1 \
    || { cat "$CLUSTER_DIR/nginx-test.log" >&2; exit 1; }
  nginx -e "$CLUSTER_DIR/logs/error.log" -p "$CLUSTER_DIR" -c "$CLUSTER_DIR/nginx.conf" >/dev/null 2>&1 &
  NGINX_PID=$!; PIDS+=("$NGINX_PID")
  wait_up "http://127.0.0.1:$listen/v1/chat/completions" 401 "$NGINX_PID"
}

case "$MODE" in
  render)
    shift; mkdir -p "$CLUSTER_DIR"; render_conf "$@"; exit 0 ;;
  nginx)
    shift; trap cleanup EXIT INT TERM
    start_nginx "$@"; echo "cluster: nginx on $1 -> ${*:2}"; wait "$NGINX_PID" ;;
  up)
    trap cleanup EXIT INT TERM
    mkdir -p "$CLUSTER_DIR"; rm -f "$CLUSTER_DIR/ready"
    require_free_port "$MOCK_PORT"
    MOCK_PORT="$MOCK_PORT" MOCK_LATENCY_MS="${MOCK_LATENCY_MS:-0}" MOCK_TOKEN_DELAY_MS="${MOCK_TOKEN_DELAY_MS:-0}" \
      MOCK_COMPLETION_TOKENS="${MOCK_COMPLETION_TOKENS:-20}" \
      node "$ROOT/packages/mock-provider/src/server.ts" >/dev/null &
    p=$!; PIDS+=("$p"); echo "$p" >"$CLUSTER_DIR/mock.pid"
    wait_up "http://127.0.0.1:$MOCK_PORT/__control" 200 "$p"
    ports=()
    for i in $(seq 1 "$INSTANCES"); do
      port=$((BASE_PORT + i - 1)); ports+=("$port"); require_free_port "$port"
      args=(); if [ "$i" = 1 ] && [ -n "${GATEWAY_NODE_ARGS:-}" ]; then read -r -a args <<<"$GATEWAY_NODE_ARGS"; fi
      env GATEWAY_PORT="$port" OPENAI_BASE_URL="http://127.0.0.1:$MOCK_PORT/v1" MOCK_BASE_URL="http://127.0.0.1:$MOCK_PORT" \
        UPSTREAM_CONNECTIONS="${UPSTREAM_CONNECTIONS:-256}" LOG_LEVEL=warn TRUSTED_PROXIES=127.0.0.1 \
        RATE_LIMIT_REDIS_TIMEOUT_MS="${RATE_LIMIT_REDIS_TIMEOUT_MS:-1000}" \
        node ${args[@]+"${args[@]}"} --env-file-if-exists="$ROOT/.env.local" "$ROOT/packages/gateway/src/server.ts" >/dev/null &
      p=$!; PIDS+=("$p"); echo "$p" >"$CLUSTER_DIR/gw-$i.pid"
    done
    for i in $(seq 1 "$INSTANCES"); do
      wait_up "http://127.0.0.1:$((BASE_PORT + i - 1))/v1/chat/completions" 401 "$(cat "$CLUSTER_DIR/gw-$i.pid")"
    done
    if [ "$WITH_WORKER" = 1 ]; then
      node --env-file-if-exists="$ROOT/.env.local" "$ROOT/packages/log-worker/src/worker.ts" >/dev/null &
      p=$!; PIDS+=("$p"); echo "$p" >"$CLUSTER_DIR/worker.pid"
      sleep 1; kill -0 "$p" 2>/dev/null || { echo "cluster: the log worker exited at start" >&2; exit 1; }
    fi
    start_nginx "$NGINX_PORT" "${ports[@]}"
    echo "$INSTANCES" >"$CLUSTER_DIR/ready"
    echo "cluster: ready: nginx :$NGINX_PORT -> ${ports[*]} -> mock :$MOCK_PORT (dir $CLUSTER_DIR)"
    wait ;;
  *) echo "usage: bash bench/cluster.sh up|nginx|render" >&2; exit 2 ;;
esac
