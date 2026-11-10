# Resilience under outage

Source: `chaos-fallback-on.json` and `chaos-fallback-off.json` (k6 summary exports of `bench/k6/chaos.js`, started by `bench/run-chaos.sh`).
Conditions: `conditions.txt` in this folder. Success is a complete answer: HTTP 200, and for a stream the `[DONE]` terminator.
The phase of a request is the one it was sent in: before the first mock is killed, while it is down, after a fresh one is started.

## With the fallback chain (`mock-openai-1>mock-anthropic-1`)

| phase | kind | requests | success | p50 | p95 | upstream calls per request | requests with one call | served by fallback |
|---|---|---:|---:|---:|---:|---:|---:|---:|
| before | non-streamed | 3137 | 65.03% | 9712.6 ms | 60001.9 ms | 1.00 | 1671 | 369 |
| before | streamed | 805 | 64.84% | 9331.3 ms | 60001.9 ms | 0.97 | 436 | 86 |
| outage | non-streamed | 3768 | 0.00% | 60000.7 ms | 60002.5 ms | 0.00 | 0 | 0 |
| outage | streamed | 895 | 0.00% | 60000.7 ms | 60002.5 ms | 0.00 | 0 | 0 |
| after | non-streamed | 3616 | 0.00% | 0.0 ms | 2000.7 ms | 0.00 | 0 | 0 |
| after | streamed | 905 | 0.00% | 0.1 ms | 2000.5 ms | 0.00 | 0 | 0 |

## Without a chain

| phase | kind | requests | success | p50 | p95 | upstream calls per request | requests with one call | served by fallback |
|---|---|---:|---:|---:|---:|---:|---:|---:|
| before | non-streamed | 2952 | 43.83% | 59965.3 ms | 59969.5 ms | 0.44 | 1294 | 0 |
| before | streamed | 759 | 44.93% | 59965.1 ms | 59969.5 ms | 0.45 | 341 | 0 |
| outage | non-streamed | 3730 | 0.00% | 59961.3 ms | 59965.0 ms | 0.00 | 0 | 0 |
| outage | streamed | 823 | 0.00% | 59961.9 ms | 59965.3 ms | 0.00 | 0 | 0 |
| after | non-streamed | 1241 | 0.00% | 0.0 ms | 0.1 ms | 0.00 | 0 | 0 |
| after | streamed | 665 | 0.00% | 0.1 ms | 0.1 ms | 0.00 | 0 | 0 |
