# Benchmarks

Diagram: [benchmarks.html](benchmarks.html). Results and machine details: [../../BENCHMARKS.md](../../BENCHMARKS.md).
Cluster rig diagram: [cluster.html](cluster.html). Rig: `bench/k6/chat.js`, `bench/run-baseline.sh`. Raw output: `bench/results/pr-1/`.

## Decision: gateway, mock and k6 run natively; Docker holds only Redis and Postgres

Docker on macOS (Colima here) routes published ports through a virtual network, which adds latency of
the same order as the overhead being measured. Running the gateway, mock and k6 as plain processes on
the host removes that hop from every figure. Redis and Postgres are stateful and have no latency
role in PR 1, so they stay in Docker. The cost: k6, the gateway and the mock share one machine's CPU,
so the throughput ceiling is for that arrangement, not for the gateway alone. Laptop versus cloud VM
for headline numbers is a later PR.

## Method

- **Mock settings.** *Instant*: no latency, no token delay, non-streamed, which isolates the proxy hop
  and gives a throughput ceiling. *Realistic*: 200 ms to first token, 20 tokens at 10 ms, streamed,
  which shows what a user feels.
- **Executor.** k6 `constant-arrival-rate`: a fixed request rate rather than a fixed number of users,
  so a slow gateway cannot hide by slowing the load. 30 s warm-up, then 60 s measured; only the
  measured phase is read.
- **Overhead, two ways.** (1) The difference between the gateway run and the direct run at p50 and p95.
  (2) The gateway's own `server-timing` figure. It covers only the gateway's pre-dispatch work (and, on non-streamed responses, building the reply headers);
  it leaves out reading the request, copying the upstream body, serialising and writing the reply. So it is
  a floor, not the overhead; the k6 difference includes the extra HTTP hop. A p50 gap between the two over
  1 ms is investigated before publishing.
- **Throughput.** The arrival rate is stepped up against the instant mock, through the gateway and direct,
  in shorter steps (5 s warm-up, 15 s measured). The reported rate is the last step with under 1% errors
  and a p95 under twice the first step's p95.

## Why this design

The goal is one number a reader can trust: how much the gateway adds. Everything else is arranged to keep
that number clean: a mock for a stable upstream, a fixed arrival rate, a direct baseline at the same rate,
and a native rig.

## Measured (from [BENCHMARKS.md](../../BENCHMARKS.md))

Overhead 0.233 ms p50 / 0.982 ms p95 (instant, 1000 req/s); 0.238 ms p50 / 0.254 ms p95 to first byte
(realistic, 200 req/s). Throughput: last good step 10000 req/s; p95 99.091 ms at the 12000 req/s step.

## The final suite: three instances behind nginx

Diagram: [cluster.html](cluster.html). One command, `bash bench/run-all.sh`, runs every scenario into `bench/results/final/`
and writes `summary.md` from that folder's JSON alone (`bench/final-summary.ts`); nothing in it is typed by hand.

- **The rig.** k6 sends to nginx (native, `least_conn`, keep-alive to the gateways, no buffering so streams pass as they
  arrive), which spreads over gateways on ports 3101 to 310N. They share one Redis and one Postgres, one mock provider, and
  one log worker. `bench/cluster.sh` starts and stops all of it; `bench/nginx/nginx.conf` is the front.
- **Why native nginx.** Docker on macOS adds a network hop that would sit inside every number (see the decision above).
- **Why a POST is never retried.** nginx replays a request on another gateway only if it could not connect. A request a gateway
  had already read might have spent budget, so killing a gateway costs its in-flight requests and nothing after nginx marks it down.
- **Scenarios.** Overhead (direct vs one gateway), ramp (ceiling and breaking point, 1 and 3 instances), steady at 60% of the
  ceiling, spike, correctness under concurrency (rate limit, budget, budget with a Redis restart), cache, semantic cache,
  provider outage through nginx, request logging, and a profile of one gateway under the ramp.
- **Correctness is counted, not assumed.** Rate-limit admissions are the status-200 rows in the request log for the run's key,
  compared with the key's bucket plus what refilled during the burst. Budget runs ask Postgres how many tenants settled above their cap.
- **Honesty rules.** The load generator shares the machine. A ceiling that stopped on dropped k6 iterations is labelled k6-bound.
  Every run is gated by `bench/quiet.sh`, and repeats are reported as median and range.
- **Smoke vs full.** `bash bench/run-all.sh --smoke` proves the wiring with tiny durations in a scratch folder and its numbers
  mean nothing. The full run is for a quiet machine, overnight; its estimated duration is in the script's header.
