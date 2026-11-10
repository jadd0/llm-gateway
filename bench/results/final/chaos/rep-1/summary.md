# Resilience under outage

Source: `chaos-fallback-on.json` and `chaos-fallback-off.json` (k6 summary exports of `bench/k6/chaos.js`, started by `bench/run-chaos.sh`).
Conditions: `conditions.txt` in this folder. Success is a complete answer: HTTP 200, and for a stream the `[DONE]` terminator.
The phase of a request is the one it was sent in: before the first mock is killed, while it is down, after a fresh one is started.

## With the fallback chain (`mock-openai-1>mock-anthropic-1`)

| phase | kind | requests | success | p50 | p95 | upstream calls per request | requests with one call | served by fallback |
|---|---|---:|---:|---:|---:|---:|---:|---:|
| before | non-streamed | 2925 | 99.97% | 20974.9 ms | 21825.8 ms | 1.04 | 2878 | 1608 |
| before | streamed | 755 | 100.00% | 20966.4 ms | 21827.6 ms | 1.03 | 747 | 402 |
| outage | non-streamed | 4098 | 32.67% | 60000.9 ms | 60002.5 ms | 0.33 | 1329 | 1091 |
| outage | streamed | 1023 | 32.65% | 60000.8 ms | 60002.6 ms | 0.33 | 334 | 268 |
| after | non-streamed | 1603 | 0.00% | 0.1 ms | 0.2 ms | 0.00 | 0 | 0 |
| after | streamed | 570 | 0.00% | 0.1 ms | 0.3 ms | 0.00 | 0 | 0 |

## Without a chain

| phase | kind | requests | success | p50 | p95 | upstream calls per request | requests with one call | served by fallback |
|---|---|---:|---:|---:|---:|---:|---:|---:|
| before | non-streamed | 2562 | 32.86% | 41673.4 ms | 44383.5 ms | 0.40 | 847 | 0 |
| before | streamed | 661 | 34.34% | 41667.7 ms | 52153.5 ms | 0.39 | 230 | 0 |
| outage | non-streamed | 4220 | 56.07% | 36845.3 ms | 40005.1 ms | 0.56 | 2366 | 0 |
| outage | streamed | 921 | 77.20% | 37043.7 ms | 40078.7 ms | 0.77 | 711 | 0 |
| after | non-streamed | 2973 | 95.76% | 37596.8 ms | 37804.1 ms | 0.96 | 2847 | 0 |
| after | streamed | 1004 | 74.80% | 37434.5 ms | 37800.4 ms | 0.75 | 751 | 0 |
