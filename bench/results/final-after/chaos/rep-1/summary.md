# Resilience under outage

Source: `chaos-fallback-on.json` and `chaos-fallback-off.json` (k6 summary exports of `bench/k6/chaos.js`, started by `bench/run-chaos.sh`).
Conditions: `conditions.txt` in this folder. Success is a complete answer: HTTP 200, and for a stream the `[DONE]` terminator.
The phase of a request is the one it was sent in: before the first mock is killed, while it is down, after a fresh one is started.

## With the fallback chain (`mock-openai-1>mock-anthropic-1`)

| phase | kind | requests | success | p50 | p95 | upstream calls per request | requests with one call | served by fallback |
|---|---|---:|---:|---:|---:|---:|---:|---:|
| before | non-streamed | 4406 | 100.00% | 402.2 ms | 403.4 ms | 1.00 | 4406 | 0 |
| before | streamed | 1103 | 100.00% | 395.9 ms | 398.9 ms | 1.00 | 1103 | 0 |
| outage | non-streamed | 5919 | 100.00% | 402.5 ms | 1091.4 ms | 1.49 | 4904 | 5815 |
| outage | streamed | 1499 | 99.40% | 396.7 ms | 1067.7 ms | 1.50 | 1226 | 1463 |
| after | non-streamed | 5588 | 100.00% | 402.3 ms | 403.5 ms | 1.00 | 5588 | 1281 |
| after | streamed | 1398 | 100.00% | 396.0 ms | 398.9 ms | 1.00 | 1398 | 321 |

## Without a chain

| phase | kind | requests | success | p50 | p95 | upstream calls per request | requests with one call | served by fallback |
|---|---|---:|---:|---:|---:|---:|---:|---:|
| before | non-streamed | 3260 | 30.18% | 2223.2 ms | 43760.0 ms | 0.32 | 998 | 0 |
| before | streamed | 838 | 31.03% | 2119.6 ms | 43751.3 ms | 0.33 | 266 | 0 |
| outage | non-streamed | 5699 | 0.19% | 2000.5 ms | 10030.5 ms | 0.00 | 11 | 0 |
| outage | streamed | 1440 | 0.21% | 2000.5 ms | 9288.6 ms | 0.00 | 3 | 0 |
| after | non-streamed | 2577 | 13.23% | 9433.5 ms | 10010.0 ms | 0.13 | 341 | 0 |
| after | streamed | 645 | 13.18% | 9363.9 ms | 10007.5 ms | 0.13 | 85 | 0 |
