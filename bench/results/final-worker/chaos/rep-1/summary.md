# Resilience under outage

Source: `chaos-fallback-on.json` and `chaos-fallback-off.json` (k6 summary exports of `bench/k6/chaos.js`, started by `bench/run-chaos.sh`).
Conditions: `conditions.txt` in this folder. Success is a complete answer: HTTP 200, and for a stream the `[DONE]` terminator.
The phase of a request is the one it was sent in: before the first mock is killed, while it is down, after a fresh one is started.

## With the fallback chain (`mock-openai-1>mock-anthropic-1`)

| phase | kind | requests | success | p50 | p95 | upstream calls per request | requests with one call | served by fallback |
|---|---|---:|---:|---:|---:|---:|---:|---:|
| before | non-streamed | 4507 | 100.00% | 402.0 ms | 403.5 ms | 1.00 | 4507 | 0 |
| before | streamed | 1127 | 100.00% | 395.9 ms | 398.3 ms | 1.00 | 1127 | 0 |
| outage | non-streamed | 5910 | 100.00% | 402.5 ms | 1082.2 ms | 1.48 | 4926 | 5899 |
| outage | streamed | 1498 | 99.33% | 395.7 ms | 1053.7 ms | 1.49 | 1232 | 1485 |
| after | non-streamed | 5494 | 100.00% | 402.0 ms | 403.4 ms | 1.00 | 5494 | 1165 |
| after | streamed | 1373 | 100.00% | 395.5 ms | 398.1 ms | 1.00 | 1373 | 292 |

## Without a chain

| phase | kind | requests | success | p50 | p95 | upstream calls per request | requests with one call | served by fallback |
|---|---|---:|---:|---:|---:|---:|---:|---:|
| before | non-streamed | 4574 | 98.75% | 402.0 ms | 403.4 ms | 1.02 | 4517 | 0 |
| before | streamed | 1144 | 98.78% | 394.7 ms | 397.6 ms | 1.00 | 1130 | 0 |
| outage | non-streamed | 5981 | 0.00% | 1.7 ms | 646.1 ms | 0.47 | 17 | 0 |
| outage | streamed | 1500 | 0.00% | 1.9 ms | 711.6 ms | 0.48 | 6 | 0 |
| after | non-streamed | 5427 | 80.10% | 401.8 ms | 403.0 ms | 0.80 | 4347 | 0 |
| after | streamed | 1357 | 80.10% | 393.5 ms | 397.0 ms | 0.80 | 1087 | 0 |
