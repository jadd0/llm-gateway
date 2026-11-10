# Benchmarks

Every figure on this page is copied from a `summary.md` that `node bench/final-summary.ts <folder>` generates from
the committed k6 JSON, CPU samples and profiles in that folder, and from nothing else. Cells are the median of
the repeats with the range in brackets. Method and the reasons behind it: [docs/benchmarks/README.md](docs/benchmarks/README.md);
the rig: [docs/benchmarks/cluster.html](docs/benchmarks/cluster.html).

Three result folders, one script (`bash bench/run-all.sh`):

| folder | what it holds | why it exists |
|---|---|---|
| [`bench/results/final/`](bench/results/final/summary.md) | the full suite, 264 min (2026-11-10, commit `e1657da`) | overhead, correctness, dashboard, semantic, and the breaking point *before* the fix |
| [`bench/results/final-after/`](bench/results/final-after/summary.md) | ramp, steady, spike and profile again, 143 min (commit `59fc011`) | the breaking point *after* the one fix, on a fresh database |
| [`bench/results/final-worker/`](bench/results/final-worker/summary.md) | cache, chaos and logging again, 47 min (commit `67f3d05`) | the first run's cache repeats 2-3, chaos and logging were invalid (below) |

## Conditions

| | |
|---|---|
| Machine | Apple M5, 10 cores, 24 GB, macOS 26.6.2, on mains power |
| Software | Node v26.4.0 (`.ts` run directly), k6 v2.3.0, nginx 1.31.8 (native, Homebrew) |
| Topology | k6, nginx, the gateways, the log worker and the mock provider are native processes on this laptop. Postgres 17 (pgvector) and Redis 7.4 (AOF on) run in Docker under Colima and are reached through Colima's port forwarding |
| Quiet gate | before every scenario `bench/quiet.sh` waited for a 1-minute load average under 2.0 on mains power; each scenario's `conditions/<name>/conditions.txt` records the load and the busiest processes at its start |
| Repeats | 3 per performance scenario, 10 per correctness check |

**What these numbers are not.** The load generator shares the machine with what it measures: k6 alone used up to
2.6 cores in the ramps, and nginx, up to 3 gateways, the worker, the mock and the Docker VM took the rest. A
ceiling here is this laptop's, not a server's, and 3 instances compete for the same 10 cores. Every Redis and
Postgres call also crosses Colima's SSH port forward: during the first run the Redis forward reconnected for
two minutes (02:36 to 02:38) and at 05:06 every forward dropped while the containers stayed healthy, which
ended one run (it was restarted from the beginning, `colima restart`).

## Overhead of one gateway

`final/`. The gateway run minus the direct-to-mock run, per repeat, over successful responses. Instant: no mock
latency, non-streamed. Realistic: 200 ms to first token, streamed. Budgets off (`BUDGET_ENABLED=false`),
auth with its Redis cache, everything else at the `.env.local` settings.

| profile | repeats | added p50 | added p95 | added p99 | result |
|---|---:|---|---|---|---|
| instant | 3 | 1.4 ms (1.3 to 1.4) | 2.1 ms (1.2 to 2.1) | 2.8 ms (2.0 to 2.9) | ok |
| realistic | 3 | 0.4 ms (-0.7 to 1.8) | 0.9 ms (-2.0 to 0.9) | -0.7 ms (-2.3 to 1.1) | ok |

Against a provider that takes hundreds of milliseconds, the realistic figures are inside the mock's own timer
noise (a negative difference is noise, not a speed-up).

## Ceiling and breaking point (1 vs 3 instances)

Ramp through nginx with an instant mock; budgets, rate limits, auth and the stream request log with its worker
all on; 15 steps from 1000 to 32000 req/s, 15 s measured per step. **Ceiling:** the last step with errors at
most 1%, p95 at most 2x the first step's p95 and under 1% dropped iterations. **Breaking point:** the first step
with p95 over 10x the first step's or errors over 1%.

| | instances | ceiling (req/s) | breaking point (req/s) |
|---|---:|---|---|
| before the fix (`final/`) | 1 | 2000 (2000 to 2000) | 4000 (4000 to 4000) |
| before the fix (`final/`) | 3 | 2000 (2000 to 2000) | 6000 (5000 to 6000) |
| after the fix (`final-after/`) | 1 | 2000 (1000 to 2000) | 4000 (4000 to 4000) |
| after the fix (`final-after/`) | 3 | 1000 (1000 to 2000) | 5000 (4000 to 5000) |

The ceiling rule is relative to the first step: the after runs started faster (p95 5.0 ms against 7.5 ms at
1000 req/s, one instance), so the same latency later in the ramp counts against them sooner. Read the steps:

| offered req/s | 1 instance before: p95 | 1 instance after: p95 | 3 instances before: p95 | 3 instances after: p95 |
|---:|---|---|---|---|
| 1000 | 7.5 ms | 5.0 ms | 8.1 ms | 5.4 ms |
| 2000 | 11.2 ms | 9.3 ms | 12.4 ms | 10.6 ms |
| 3000 | 21.2 ms | 36.9 ms | 18.9 ms | 21.3 ms |
| 4000 | 220.8 ms (3790 achieved) | 255.4 ms (3613 achieved) | 27.4 ms | 49.1 ms |
| 5000 | 286.1 ms (3748 achieved) | 349.5 ms (3383 achieved) | 61.9 ms | 1597.7 ms (2644 achieved) |

**What breaks it.** At 4000 req/s one gateway process tops out at about 3600 to 3800 achieved req/s, its CPU
pinned at 125 to 140% (the main thread plus the garbage collector, `cluster/cpu-ramp-1i-*.csv`). The CPU profile
of a gateway at that point (`profile/`) is not spent on HTTP or JSON: about two thirds of its busy time is
budget balance rebuilds, materialising Postgres rows into objects (drizzle `mapResultRow` and entity code
16%, `utf8Slice` 13%, garbage collection 15%, under `redis-ledger.ts` `reserve`). Under that load Redis calls
pass the budget's 50 ms timeout, the gateway treats the misses as a Redis outage and moves the epoch, and every
in-flight request then rebuilds its balance from Postgres on its own (residual R29).

**The one fix** (`59fc011`): the rebuild's read of the month's estimated charges filtered every ledger row of
the tenant's month. A partial index `spend_ledger_estimated_idx (tenant_id, period) WHERE estimated` took that
query from 64.5 ms (parallel seq scan, 450 MB read) to 4.9 ms on the same 3.2M-row data. It removed the
Postgres saturation that stalled later scenarios; it did not move the ramp's breaking point, which is bound by
the gateway's CPU on the JavaScript side of the same rebuilds. The before and after runs also differ in
database state (the after runs started from an empty database), so the table above compares the two runs, not
the fix alone.

## Steady load at 60% of the ceiling

Same stack as the ramp, 60 s measured.

| run | instances | req/s | requests | failed | p50 | p95 | p99 |
|---|---:|---:|---:|---:|---|---|---|
| `final/` | 1 | 1200 | 216003 | 0 | 5.4 ms (5.4 to 5.8) | 8.6 ms (8.6 to 8.9) | 11.2 ms (11.1 to 12.1) |
| `final/` | 3 | 1200 | 216003 | 0 | 5.9 ms (5.9 to 6.0) | 9.1 ms (9.0 to 9.3) | 11.4 ms (11.3 to 12.5) |
| `final-after/` | 1 | 600 | 108003 | 0 | 3.0 ms (2.9 to 3.0) | 4.5 ms (4.4 to 4.5) | 5.5 ms (5.5 to 5.7) |
| `final-after/` | 3 | 600 | 108002 | 0 | 3.3 ms (3.2 to 3.4) | 4.9 ms (4.8 to 5.0) | 6.1 ms (6.0 to 6.1) |

The after rate is 600 because the after ceiling for 3 instances came out at 1000.

## Spike

`final-after/`. 200 req/s base with a realistic mock, 10x for 20 s. Recovery: seconds after the spike until a 5 s
window has p95 within 1.5x the base p95 and no errors.

| instances | base p95 | spike p95 | failed in spike | dropped in spike | recovery (s) |
|---:|---|---|---:|---:|---|
| 1 | 403.1 ms (403.1 to 403.2) | 5511.5 ms (5505.8 to 5514.8) | 0 | 0 | 10 (10 to 10) |
| 3 | 403.5 ms (403.3 to 403.6) | 1032.6 ms (1031.8 to 1033.3) | 0 | 0 | 10 (10 to 10) |

`final/` measured the same within 2 ms. Nothing fails; one instance queues the spike (5.5 s p95), three absorb it.

## Correctness under concurrency

`final/`. 3 instances behind nginx, 10 runs of each check.

| check | runs | requests | over-limit or over-cap | result |
|---|---:|---:|---:|---|
| rate limit flood: admissions within rpm plus refill | 10 | 10000 | 0 | pass |
| budget flood: tenants whose settled spend passed the cap | 10 | 20000 | 0 | pass |
| budget flood with Redis restarted mid-run | 10 | 20000 | 0 | pass |

The request log and the client agreed on the admitted count in 10 of 10 runs; the ledger held a row for every
admitted request in 20 of 20 budget runs; the largest overshoot of a cap was 0 micro-USD.

## Exact-match cache

`final-worker/`, repeat 1 (repeats 2 and 3 are within 0.1 ms and 0.9 points). Realistic mock, `temperature: 0`,
100 req/s.

| run | requests | hit rate | upstream calls | hit p50 / p95 | miss p50 / p95 |
|---|---:|---:|---:|---|---|
| cold: every prompt new | 6001 | 0.00% | 6001 | n/a | 403.0 / 404.3 ms |
| warm: Zipf draw from 200 prompts | 6001 | 96.70% | 198 | 1.1 / 1.3 ms | 403.5 / 405.3 ms |
| warm, streamed | 6001 | 96.08% | 235 | 1.1 / 1.3 ms | 400.7 / 405.0 ms |
| stampede: 50 identical requests at once | 50 | 98.00% | 1 | 408.8 / 409.1 ms | 406.7 ms |

A stampede of 50 identical requests makes one upstream call; the other 49 wait for it.

## Semantic cache

`final/`. Latency, local embedder (voyage-4-nano in Ollama):

| run | requests | exact hits | semantic hits | misses | semantic-hit p50 / p95 | miss p50 / p95 |
|---|---:|---:|---:|---:|---|---|
| paraphrase of a seeded prompt | 301 | 80 | 143 | 78 | 37.6 / 69.0 ms | 443.3 / 471.1 ms |
| a system prompt nobody has used | 301 | 0 | 0 | 301 | n/a | 431.1 / 449.8 ms |

Accuracy, on 5000 held-out QQP and PAWS pairs (threshold chosen on a separate 5000), the gateway's own lookup
(nearest neighbour) with its guards: **no threshold keeps wrong answers under the 1% budget.** The best is 0.88:
41.88% of duplicates served right, 55.89% of served answers wrong (QQP 29.68%, PAWS 64.67%). At the default 0.95:
34.40% hit, 57.18% wrong. PAWS pairs are built to look alike and mean different things, which is the case a
semantic cache must refuse.

So the semantic cache stays **off by default, per-tenant opt-in** (D-061), and with this embedder no tenant
should opt in. `SEMANTIC_THRESHOLD` stays 0.95, `SEMANTIC_CROSS_MODEL=false`, `SEMANTIC_INPUT_TYPE=none`: only
the local model with bare input was evaluated; the Voyage API embedder and the cross-model case need an API key
and are not measured.

## Provider outage

`final-worker/`, repeat 1 (repeats 2 and 3 within a point). Through nginx, realistic mock; the primary mock is
killed at 20 s and restarted at 50 s of 80 s. Success: HTTP 200 and, for a stream, the `[DONE]` terminator.

| chain | phase | non-streamed success | streamed success | p95 (non-streamed) | upstream calls per request | served by fallback |
|---|---|---:|---:|---|---:|---:|
| `mock-openai-1>mock-anthropic-1` | before | 100.00% | 100.00% | 403.5 ms | 1.00 | 0 |
| | outage | 100.00% | 99.33% | 1082.2 ms | 1.48 | 5899 |
| | after | 100.00% | 100.00% | 403.4 ms | 1.00 | 1165 |
| none | before | 98.75% | 98.78% | 403.4 ms | 1.02 | 0 |
| | outage | 0.00% | 0.00% | 646.1 ms | 0.47 | 0 |
| | after | 80.10% | 80.10% | 403.0 ms | 0.80 | 0 |

With a fallback the outage costs latency, not answers: about half the requests try the dead primary first (1.48
calls each) and the breaker sends the rest straight to the fallback. Without one, requests fail fast (1.7 ms p50)
once the breaker is open, and 80% succeed in the window after the restart while the breaker probes its way
closed again.

## Request logging off the request path

`final-worker/`. 200 req/s, realistic mock, 60 s, 3 repeats per mode.

| mode | requests | failed | p50 | p95 | p99 |
|---|---:|---:|---|---|---|
| inline (one awaited insert per request) | 35905 | 0 | 402.3 ms (402.2 to 402.4) | 403.4 ms (403.4 to 403.7) | 404.4 ms (404.1 to 404.8) |
| stream (XADD; the worker writes batches) | 35905 | 0 | 401.8 ms (401.8 to 401.9) | 403.1 ms (403.0 to 403.2) | 403.9 ms (403.9 to 404.1) |

The worker stayed at most 2 entries behind (3 pending) and wrote 195 rows a second. At 200 req/s the two modes
differ by under 1 ms; the stream mode's gain is that a slow or absent Postgres no longer sits on the request path.

## Dashboard query time vs log size

`final/`, median (p95) ms after one warm-up, Postgres 17.

| query | 10,000 rows | 100,000 rows | 1,000,000 rows | 5,000,000 rows |
|---|---:|---:|---:|---:|
| overview 24h, on the rollups | 4.62 (5.35) | 18.4 (19.6) | 23.5 (26.1) | 27.9 (31.4) |
| overview 30d, on the rollups | 13.5 (15.5) | 17.8 (20.0) | 20.9 (23.4) | 23.5 (29.1) |
| overview 30d, from the raw log | 8.73 (9.36) | 64.8 (66.8) | 486.7 (493.1) | 2708 (2715) |
| last 50 errors (partial index) | 1.28 (1.45) | 1.19 (1.35) | 1.29 (1.45) | 1.22 (1.46) |

Rollups and raw log agree exactly on requests, errors and spend at every size and range; the rollups' p95 is read
from a histogram and comes out up to 4% above the raw p95 (3135 against 3113 ms at 5M rows, 30 days).

## Invalid runs, and what was wrong

The first run's cache repeats 2 and 3, all three chaos repeats and the logging run are kept in `final/` but not
used: requests timed out at 60 s and up to 88% failed. Two causes, both found from the evidence before anything
was changed:

1. **No log worker.** `run-cache.sh`, `run-chaos.sh` and `run-logging.sh`'s inline mode started a gateway without
   the worker. Budget settles reach Postgres only through the worker, so every request's hold stayed (69k on the
   bench tenant), each budget rebuild carried all of them, Redis calls timed out and the epoch moved (191 times
   in one run). A gateway is never deployed without a worker; the scripts now start one (`67f3d05`).
2. **One tenant for the whole suite.** By the end of the first run the bench tenant had 3.2M ledger rows, and the
   rebuild's seq scan saturated Postgres. That is the index above.

`final-worker/` repeated those three scenarios with both fixes; every one of its runs is valid.

## Superseded figures

The per-PR figures published before this run (PR 1's 10000 req/s through one process and 0.23 ms p50 overhead,
and the per-PR sections of PRs 3 to 11) were taken one run each on a busy laptop (load up to 11 on 10 cores,
R8). Their raw data stays in `bench/results/pr-*`; this page replaces them. PR 1's higher throughput was a
gateway with no auth, rate limit, budget or request log; the ceiling above has all of them on. The PR 2
framework comparison was not re-run: its harness is not on this base.
