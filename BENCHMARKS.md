# Benchmarks

Method and the reasons behind it: [docs/benchmarks/README.md](docs/benchmarks/README.md). Raw k6 summaries
for every figure below are committed in [bench/results/pr-1/](bench/results/pr-1/); re-run with
`npm run bench:baseline`. Every number here is read from those JSON files (`http_req_duration`,
`http_req_waiting` and the gateway's own timing, measured phase only, tag `phase:measure`).

The gateway-timing metric is named `gw_server_timing_ms` in the committed JSON. It was read from the
`server-timing` header as it was when these runs were recorded: for the non-streamed (instant) runs the `gw`
field, computed as total minus upstream. In practice that is **pre-dispatch time** (request received to upstream
request dispatched): the post-receipt span it also covered contained no work, because copying the upstream body
into memory was counted under `upstream` and the reply was serialised and written after the measurement. For the
streamed (realistic) runs the `gw-pre` field, which is **pre-dispatch only**. The gateway now reports `gw-pre` and `gw-post` separately on non-streamed responses, and
the k6 script records them as `gw_pre_server_timing_ms` and `gw_post_server_timing_ms`. The committed
results were not re-run.

## Environment

| | |
|---|---|
| Machine | Apple M5, 10 cores, 24 GB, macOS 26.6.2 |
| Runtime | Node v26.4.0, running `.ts` directly (type stripping) |
| Load generator | k6 v2.3.0 (go1.27.1, darwin/arm64) |
| Libraries | Fastify 5.12.8, undici 8.12.4, zod 4.6.7 |
| Topology | k6, gateway and mock provider as native processes on the same laptop, loopback. Docker (Colima) runs Redis and Postgres only and is not on the path |
| Gateway settings | `UPSTREAM_CONNECTIONS=256`, `LOG_LEVEL=warn`, one process |
| Payload | request 124 bytes; response 363 bytes non-streamed (instant), 4683 bytes as 23 SSE events (realistic) |
| Code under test | gateway and mock as of commit `34d9fbd` |
| Method | k6 `constant-arrival-rate`, 30 s warm-up discarded, 60 s measured |

The laptop was otherwise idle but this is a single machine running load generator and system under test
together, so figures are relative evidence for this PR's baseline, not a capacity claim.

## Gateway overhead

Overhead is the gateway run minus the direct-to-mock run, at the same arrival rate.

| Scenario | Rate | Direct p50 ms | Gateway p50 ms | Overhead p50 ms | Direct p95 ms | Gateway p95 ms | Overhead p95 ms | Errors |
|---|---|---|---|---|---|---|---|---|
| Instant, non-streamed, total duration | 1000 req/s | 1.190 | 1.423 | 0.233 | 1.278 | 2.260 | 0.982 | 0 |
| Realistic, streamed, time to first byte | 200 req/s | 200.202 | 200.440 | 0.238 | 201.274 | 201.528 | 0.254 | 0 |

Realistic mock: 200 ms to first token, 20 tokens at 10 ms. Instant mock: no latency, no token delay.

Streamed total duration (request start to last byte) was 395.487 ms p50 / 400.745 ms p95 direct and
393.185 ms / 398.527 ms through the gateway. The gateway figure is lower, a difference of about 2 ms in the
wrong direction for an overhead, so it sits inside the noise of the mock's per-token timers and is not used
as an overhead figure. Time to first byte is the streamed measure.

### Cross-check against the gateway's own timing

The gateway reports `server-timing`. As recorded, that is its in-process time: 0.008 ms p50 / 0.010 ms p95
for the instant run (effectively pre-dispatch) and 0.010 ms p50 / 0.018 ms p95 for the realistic run
(pre-dispatch only). It is not the overhead figure. k6's direct-versus-gateway difference, about 0.23 ms at p50, is
the real overhead, because it includes the extra HTTP hop (parsing the request, an extra socket round trip,
writing the response) that the header cannot see. The plan's check was that the two must not differ by more
than 1 ms at p50; they differ by about 0.22 ms, and the difference is explained by that hop.

## Throughput

Arrival rate stepped up against the instant mock, non-streamed, 5 s warm-up and 15 s measured per step
(shorter than the overhead runs to keep the sweep to a few minutes). A step counts as good when errors are
under 1% and p95 is under twice the first step's gateway p95 (1.296 ms, so under 2.592 ms). "Delivered" is
requests completed in the measured window divided by 15 s.

| Target rate (req/s) | Gateway delivered | Gateway p50 ms | Gateway p95 ms | Gateway errors | Direct delivered | Direct p50 ms | Direct p95 ms | Direct errors |
|---|---|---|---|---|---|---|---|---|
| 2000 | 2000 | 1.048 | 1.296 | 0 | 2000 | 1.039 | 1.212 | 0 |
| 4000 | 4000 | 0.686 | 1.184 | 0 | 4000 | 0.806 | 1.095 | 0 |
| 6000 | 6000 | 0.684 | 1.106 | 0 | 6000 | 0.600 | 1.063 | 0 |
| 8000 | 8000 | 0.734 | 1.099 | 0 | 8000 | 0.670 | 1.055 | 0 |
| 10000 | 10000 | 0.683 | 1.106 | 0 | 10000 | 0.666 | 1.057 | 0 |
| 12000 | 11878 | 0.797 | 99.091 | 0 | 12000 | 0.659 | 1.067 | 0 |
| 14000 | 14000 | 0.796 | 2.785 | 0 | 14000 | 0.656 | 1.058 | 0 |
| 16000 | 16000 | 0.788 | 3.094 | 0 | 16000 | 0.665 | 1.060 | 0 |
| 18000 | 17998 | 0.868 | 25.948 | 0 | 17902 | 0.685 | 1.437 | 0 |
| 20000 | 20000 | 0.849 | 14.863 | 0 | 19995 | 0.683 | 1.265 | 0 |

**Result: 10000 req/s** is the last good step through the gateway, one Node process. Every step up to
20000 req/s completed with zero errors, but from 12000 req/s the gateway's p95 left the band (99.091 ms at
12000, then 2.785, 3.094, 25.948 and 14.863 ms), while the mock called directly stayed at or below 1.437 ms
across the same range. The tail growth is consistent with the gateway process, sharing CPU with k6 and the
mock, being the first thing to saturate; the 12000 req/s step also delivered 11878 req/s, showing that one
step stalled briefly. Steps were run once each, so the single 99 ms p95 is one observation, not a trend.
Whether it is the single event loop, the pool size or CPU contention is not established here.

Direct-to-mock reference: the mock alone sustained every step with p95 at most 1.437 ms.

## Auth overhead (PR 3)

> **Provisional.** These runs shared the laptop with other builds and other projects' test suites (load
> around 11 on 10 cores was observed the same day), so the overhead figures are noisy and not comparable with
> PR 1's. They are kept as recorded; the quiet re-run in PR 12 (residual R8) replaces them.

Raw k6 summaries: [bench/results/pr-3/](bench/results/pr-3/), produced by `bash bench/run-baseline.sh` with
`STEP_RATES=""` (the throughput sweep was not re-run for auth). Same machine, method and rates as the PR 1 runs
above, with every gateway request sending `Authorization: Bearer gw_...`. "Redis" is `AUTH_CACHE=redis`, one
Redis GET per request once the key is cached; "none" is `AUTH_CACHE=none`, a Postgres query on every request.
Overhead is the gateway run minus the direct-to-mock run **of the same PR 3 session**. The direct-to-mock instant
run was slower and noisier in this session than in PR 1 (p50 1.145 ms, p95 2.208 ms against 1.19 ms and
1.278 ms), so the PR 1 overhead figures above and the figures here are not strictly like for like.

| Scenario | Rate | Direct p50 ms | Gateway p50 ms | Overhead p50 ms | Direct p95 ms | Gateway p95 ms | Overhead p95 ms | Errors |
|---|---|---|---|---|---|---|---|---|
| Instant, total duration, auth + Redis | 1000 req/s | 1.145 | 1.762 | 0.617 | 2.208 | 2.580 | 0.372 | 0 |
| Instant, total duration, auth, no cache | 1000 req/s | 1.145 | 1.919 | 0.774 | 2.208 | 2.690 | 0.482 | 0 |
| Realistic, time to first byte, auth + Redis | 200 req/s | 200.197 | 201.251 | 1.054 | 201.275 | 202.722 | 1.447 | 0 |
| Realistic, time to first byte, auth, no cache | 200 req/s | 200.197 | 201.555 | 1.358 | 201.275 | 203.041 | 1.766 | 0 |

PR 1 gateway without auth, same scenarios, for reference: instant 0.233 ms p50 / 0.982 ms p95 over direct;
realistic 0.238 ms p50 / 0.254 ms p95 over direct.

What the figures say, and what they do not:

- Against PR 1, the instant p50 overhead went from 0.233 ms to 0.617 ms, which puts the auth hook (HMAC, one
  Redis round trip, a JSON parse) at roughly 0.4 ms at p50 at this rate. This is the difference of two sessions, not an isolated measurement.
- The cache buys 0.157 ms at p50 and 0.110 ms at p95 in the instant run (1.762 against 1.919 ms; 2.580 against
  2.690 ms), and 0.304 ms / 0.319 ms to first byte in the realistic run. At 1000 req/s the Postgres lookup on
  a local pool is only modestly slower than a Redis lookup; the cache's larger benefit (Postgres load, tail latency under concurrent load) was not measured here.
- The realistic first-byte overhead rose from 0.238 ms to 1.054 ms p50. The Redis hook accounts for a small part of
  that; the rest is not explained by these runs and may be machine noise, since the streamed first-byte
  figure moves with timer jitter. It was measured once per scenario.
- The gateway's own `server-timing` `gw-pre` does not include the key check, because the hook runs before the route starts its clock.

## Rate limiting (PR 4)

Pending quiet run. `bash bench/run-ratelimit.sh`, started behind `bash bench/quiet.sh bench/results/pr-4`, writes the
k6 summaries to `bench/results/pr-4/`; no figure is quoted here until that run is committed (R3).

What the run measures:

- **Overhead of the check:** the same arrival rate through the gateway with `RATE_LIMIT_ENABLED=false` and `true`,
  using a key whose limits are never reached, instant non-streamed and realistic streamed. Files:
  `gateway-{instant,realistic}-ratelimit-{off,on}.json`.
- **Burst:** 1,000 requests at once at a key limited to 100 per minute, counting 200 versus 429
  (`burst.json`, with `status_200`, `status_429`, `status_429_with_retry_after`). A 100-per-minute bucket gains a token
  every 0.6 s, so a burst that takes longer than that admits one more; the run script checks the count against that bound.
- **Estimate error:** the token estimate against the mock's reported usage.

## Budgets (PR 5)

Pending quiet run. `bash bench/run-budget.sh`, started behind `bash bench/quiet.sh bench/results/pr-5`, writes the
results to `bench/results/pr-5/`; no figure is quoted here until that run is committed (R3).

What the run measures:

- **Overhead of the budget:** the same arrival rate through the gateway with `BUDGET_ENABLED=false` and `true` (rate
  limiter on in both), for a tenant whose cap is never reached, instant non-streamed and realistic streamed. Files:
  `gateway-{instant,realistic}-budget-{off,on}.json`.
- **Flood:** 100 rounds; each round a fresh tenant with a $0.01 cap is hit by 50 requests at once. `flood.json` records
  admitted and refused (402) counts, the largest settled spend as a share of the cap, and the largest overshoot in
  micro-USD, read from Postgres. A round's worst case is 312 micro-USD, so a round admits 32 when every decision is made while
  the first calls are still in flight.
- **What the Postgres mirror costs:** the same overhead pair also covers it, since every request now writes its hold to
  Postgres as well as Redis.
- **Redis down:** the same flood (`flood-redis-down.json`) and the instant profile with budgets off and on
  (`gateway-instant-redis-down-budget-{off,on}.json`) against a gateway whose Redis is unreachable, so every decision is
  made on the Postgres path.

## Translation overhead (PR 6)

Pending quiet run. `bash bench/run-providers.sh`, started behind `bash bench/quiet.sh bench/results/pr-6`, writes the
results to `bench/results/pr-6/`; no figure is quoted here until that run is committed (R3).

What the run measures: the realistic streamed scenario (200 req/s, 200 ms first byte, 10 ms per token, 20 tokens) through
the gateway to the mock's three formats, `mock-openai-1` (pass-through) against `mock-anthropic-1` and `mock-gemini-1`
(translated). The difference between the first and the other two is the cost of translating the request, the stream and the
usage. Files: `gateway-mock-{openai,anthropic,gemini}-1.json`. A short run on the build machine only proved the script
works; it is not a result.


## Resilience under outage (PR 7)

Pending quiet run. `bash bench/quiet.sh bench/results/pr-7 && bash bench/run-chaos.sh` writes `chaos-fallback-on.json`,
`chaos-fallback-off.json` and `summary.md` to `bench/results/pr-7/`; no figure is quoted here until that run is committed (R3).

What the run measures: 200 req/s non-streamed plus 50 req/s streamed for 80 s against two mocks with realistic latency. The mock
behind `mock-openai-1` is killed with SIGKILL at 20 s and a fresh one is started at 50 s. The run is done once with the chain
`mock-openai-1>mock-anthropic-1` and once with no chain. `summary.md` gives, per phase (before, outage, after) and kind, the
client success rate, p50 and p95, upstream calls per request and how many requests the fallback served. A short run on the build
machine only proved the scripts work; it is not a result.

## Exact-match cache (PR 8)

Pending quiet run. `bash bench/quiet.sh bench/results/pr-8 && bash bench/run-cache.sh` writes `cache-cold.json`, `cache-warm.json`,
`cache-warm-stream.json`, `cache-stampede.json` and `summary.md` to `bench/results/pr-8/`; no figure is quoted here until that run is
committed (R3).

What the run measures: all with `temperature: 0` against a mock with realistic latency. Cold sends only prompts the cache has never
seen. Warm draws from 200 of 2 000 distinct prompts with a Zipf skew (s = 1.1), so the hit rate is measured, not assumed, both
non-streamed and streamed. Stampede sends 50 identical non-streamed requests at once and counts upstream calls. `summary.md` gives
hit rate, p50 and p95 for hits and misses, and upstream calls. A short run on the build machine only proved the scripts work; it is
not a result.

## Request logging off the hot path (PR 10)

Pending quiet run. `bash bench/quiet.sh bench/results/pr-10 && bash bench/run-logging.sh` writes `logging-inline-<n>.json`,
`logging-stream-<n>.json`, `worker-stream-<n>.csv` and `summary.md` to `bench/results/pr-10/`; no figure is quoted here until that run
is committed (R3).

What the run measures: the same constant request rate (default 200 req/s, 60 s after a 10 s warm-up, cache off, budgets and rate limit
on, mock provider with realistic latency) with `LOG_MODE=inline` (one awaited Postgres insert per request, on the request path) and
`LOG_MODE=stream` (one `XADD`, the log worker writes batches), three repeats each. `summary.md` gives p50, p95 and p99 as median with
range over the repeats, and for the worker the maximum stream lag, the maximum pending entries and rows written per second. A short run
on the build machine only proved the scripts work; it is not a result.

