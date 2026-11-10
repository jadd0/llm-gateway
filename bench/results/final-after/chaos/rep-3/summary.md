# Resilience under outage

Source: `chaos-fallback-on.json` and `chaos-fallback-off.json` (k6 summary exports of `bench/k6/chaos.js`, started by `bench/run-chaos.sh`).
Conditions: `conditions.txt` in this folder. Success is a complete answer: HTTP 200, and for a stream the `[DONE]` terminator.
The phase of a request is the one it was sent in: before the first mock is killed, while it is down, after a fresh one is started.

## With the fallback chain (`mock-openai-1>mock-anthropic-1`)

| phase | kind | requests | success | p50 | p95 | upstream calls per request | requests with one call | served by fallback |
|---|---|---:|---:|---:|---:|---:|---:|---:|
| before | non-streamed | 3393 | 60.09% | 3461.2 ms | 47379.0 ms | 0.60 | 2039 | 0 |
| before | streamed | 869 | 61.22% | 3364.4 ms | 47348.1 ms | 0.61 | 532 | 0 |
| outage | non-streamed | 5793 | 2.87% | 2000.4 ms | 2002.3 ms | 0.03 | 166 | 0 |
| outage | streamed | 1459 | 1.92% | 2000.4 ms | 2002.1 ms | 0.02 | 28 | 0 |
| after | non-streamed | 2587 | 54.50% | 8018.7 ms | 10375.4 ms | 0.55 | 1410 | 0 |
| after | streamed | 653 | 54.21% | 7998.7 ms | 10373.9 ms | 0.54 | 354 | 0 |

## Without a chain

| phase | kind | requests | success | p50 | p95 | upstream calls per request | requests with one call | served by fallback |
|---|---|---:|---:|---:|---:|---:|---:|---:|
| before | non-streamed | 3685 | 16.58% | 2000.5 ms | 19560.6 ms | 0.36 | 630 | 0 |
| before | streamed | 940 | 18.83% | 2000.6 ms | 19500.7 ms | 0.38 | 182 | 0 |
| outage | non-streamed | 5159 | 0.00% | 2000.8 ms | 60001.0 ms | 0.00 | 0 | 0 |
| outage | streamed | 1298 | 0.00% | 2000.8 ms | 60001.0 ms | 0.00 | 0 | 0 |
| after | non-streamed | 5323 | 0.00% | 2000.4 ms | 2001.6 ms | 0.00 | 0 | 0 |
| after | streamed | 1338 | 0.00% | 2000.4 ms | 2001.6 ms | 0.00 | 0 | 0 |
