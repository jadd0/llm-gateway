# Resilience under outage

Source: `chaos-fallback-on.json` and `chaos-fallback-off.json` (k6 summary exports of `bench/k6/chaos.js`, started by `bench/run-chaos.sh`).
Conditions: `conditions.txt` in this folder. Success is a complete answer: HTTP 200, and for a stream the `[DONE]` terminator.
The phase of a request is the one it was sent in: before the first mock is killed, while it is down, after a fresh one is started.

## With the fallback chain (`mock-openai-1>mock-anthropic-1`)

| phase | kind | requests | success | p50 | p95 | upstream calls per request | requests with one call | served by fallback |
|---|---|---:|---:|---:|---:|---:|---:|---:|
| before | non-streamed | 4485 | 100.00% | 402.0 ms | 403.4 ms | 1.00 | 4485 | 0 |
| before | streamed | 1122 | 100.00% | 395.7 ms | 397.7 ms | 1.00 | 1122 | 0 |
| outage | non-streamed | 5912 | 100.00% | 402.5 ms | 1091.4 ms | 1.49 | 4908 | 5880 |
| outage | streamed | 1499 | 99.33% | 396.2 ms | 1077.1 ms | 1.50 | 1228 | 1481 |
| after | non-streamed | 5515 | 100.00% | 402.0 ms | 403.4 ms | 1.00 | 5515 | 1203 |
| after | streamed | 1379 | 100.00% | 395.4 ms | 397.9 ms | 1.00 | 1379 | 301 |

## Without a chain

| phase | kind | requests | success | p50 | p95 | upstream calls per request | requests with one call | served by fallback |
|---|---|---:|---:|---:|---:|---:|---:|---:|
| before | non-streamed | 4533 | 99.67% | 402.0 ms | 403.5 ms | 1.01 | 4518 | 0 |
| before | streamed | 1134 | 99.65% | 395.6 ms | 398.1 ms | 1.00 | 1130 | 0 |
| outage | non-streamed | 5987 | 0.00% | 1.7 ms | 646.2 ms | 0.48 | 19 | 0 |
| outage | streamed | 1500 | 0.00% | 1.9 ms | 663.3 ms | 0.47 | 4 | 0 |
| after | non-streamed | 5467 | 80.21% | 401.8 ms | 403.2 ms | 0.80 | 4385 | 0 |
| after | streamed | 1367 | 80.25% | 395.1 ms | 397.9 ms | 0.80 | 1097 | 0 |
