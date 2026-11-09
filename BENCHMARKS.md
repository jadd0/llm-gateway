# Benchmarks

Method and the reasons behind it: [docs/benchmarks/README.md](docs/benchmarks/README.md). Raw k6 summaries
for every figure below are committed in [bench/results/pr-1/](bench/results/pr-1/); re-run with
`npm run bench:baseline`. Every number here is read from those JSON files (`http_req_duration`,
`http_req_waiting` and `gw_server_timing_ms`, measured phase only, tag `phase:measure`).

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

The gateway reports `server-timing` (`gw` for non-streamed, `gw-pre` for streamed). Its own bookkeeping
time was 0.008 ms p50 / 0.010 ms p95 (instant) and 0.010 ms p50 / 0.018 ms p95 (realistic). k6's difference
is about 0.23 ms at p50, so the two agree to within the 1 ms tolerance set for this PR. The remaining
roughly 0.2 ms is the cost of the second HTTP hop (parsing the request, an extra socket round trip, writing
the response), which the header does not and cannot see.

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
across the same range. The tail growth is the signal that the gateway process, sharing CPU with k6 and the
mock, is the first thing to saturate; the 12000 req/s step also delivered 11878 req/s, showing that one
step stalled briefly. Steps were run once each, so the single 99 ms p95 is one observation, not a trend.
Whether it is the single event loop, the pool size or CPU contention is not established here.

Direct-to-mock reference: the mock alone sustained every step with p95 at most 1.437 ms.
