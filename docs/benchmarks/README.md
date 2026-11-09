# Benchmarks

Diagram: [benchmarks.html](benchmarks.html). Results and machine details: [../../BENCHMARKS.md](../../BENCHMARKS.md).
Rig: `bench/k6/chat.js`, `bench/run-baseline.sh`. Raw output: `bench/results/pr-1/`.

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
  (2) The gateway's own `server-timing` figure. They are expected to agree; a p50 gap over 1 ms is
  investigated before publishing.
- **Throughput.** The arrival rate is stepped up against the instant mock, through the gateway and direct,
  in shorter steps (5 s warm-up, 15 s measured). The reported rate is the last step with under 1% errors
  and a p95 under twice the first step's p95.
