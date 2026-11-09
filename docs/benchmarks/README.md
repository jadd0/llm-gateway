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
  (2) The gateway's own `server-timing` figure. It covers only the gateway's in-process time, so it is
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

## Questions you should be able to answer

1. **Why benchmark natively rather than in Docker?** Docker on macOS adds a virtual network hop of the same
   order as the overhead being measured. Running natively keeps it out of every figure.
2. **Why `constant-arrival-rate`?** It fixes requests per second rather than users, so a slow gateway
   cannot hide by slowing the load.
3. **Why compare against a direct run?** The difference isolates the gateway; absolute latency includes the
   mock and k6.
4. **What does the 12000 req/s p95 jump mean?** At the 12000 req/s step the gateway's p95 was 99.091 ms
   while direct stayed at 1.067 ms, and p95 stayed elevated at higher rates. It is consistent with the
   gateway process saturating while sharing a laptop with k6 and the mock. It is one run per step, so the
   single 99 ms value may be a one-off, and the cause (event loop, pool size, CPU contention) is not known.
5. **What are the limits of these numbers?** One laptop, load generator and system under test together, 15 s
   steps, one run each. They are a baseline for comparing later PRs, not a capacity claim.
