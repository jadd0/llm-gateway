# Resilience under outage

Source: `chaos-fallback-on.json` and `chaos-fallback-off.json` (k6 summary exports of `bench/k6/chaos.js`, started by `bench/run-chaos.sh`).
Conditions: `conditions.txt` in this folder. Success is a complete answer: HTTP 200, and for a stream the `[DONE]` terminator.
The phase of a request is the one it was sent in: before the first mock is killed, while it is down, after a fresh one is started.

## With the fallback chain (`mock-openai-1>mock-anthropic-1`)

| phase | kind | requests | success | p50 | p95 | upstream calls per request | requests with one call | served by fallback |
|---|---|---:|---:|---:|---:|---:|---:|---:|
| before | non-streamed | 4448 | 100.00% | 401.9 ms | 403.3 ms | 1.00 | 4448 | 0 |
| before | streamed | 1112 | 100.00% | 394.1 ms | 397.1 ms | 1.00 | 1112 | 0 |
| outage | non-streamed | 5912 | 100.00% | 402.3 ms | 1080.2 ms | 1.51 | 4866 | 5842 |
| outage | streamed | 1499 | 99.33% | 395.6 ms | 1103.0 ms | 1.52 | 1216 | 1471 |
| after | non-streamed | 5552 | 100.00% | 402.0 ms | 403.3 ms | 1.00 | 5552 | 1281 |
| after | streamed | 1388 | 100.00% | 394.1 ms | 397.2 ms | 1.00 | 1388 | 321 |

## Without a chain

| phase | kind | requests | success | p50 | p95 | upstream calls per request | requests with one call | served by fallback |
|---|---|---:|---:|---:|---:|---:|---:|---:|
| before | non-streamed | 4506 | 100.00% | 402.0 ms | 403.4 ms | 1.00 | 4506 | 0 |
| before | streamed | 1127 | 100.00% | 395.6 ms | 397.8 ms | 1.00 | 1127 | 0 |
| outage | non-streamed | 5986 | 0.20% | 1.7 ms | 675.1 ms | 0.48 | 35 | 0 |
| outage | streamed | 1500 | 0.20% | 1.9 ms | 616.5 ms | 0.47 | 8 | 0 |
| after | non-streamed | 5495 | 79.98% | 401.8 ms | 403.4 ms | 0.80 | 4395 | 0 |
| after | streamed | 1374 | 79.99% | 395.2 ms | 397.7 ms | 0.80 | 1099 | 0 |
