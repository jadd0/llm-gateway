# Resilience under outage

Source: `chaos-fallback-on.json` and `chaos-fallback-off.json` (k6 summary exports of `bench/k6/chaos.js`, started by `bench/run-chaos.sh`).
Conditions: `conditions.txt` in this folder. Success is a complete answer: HTTP 200, and for a stream the `[DONE]` terminator.
The phase of a request is the one it was sent in: before the first mock is killed, while it is down, after a fresh one is started.

## With the fallback chain (`mock-openai-1>mock-anthropic-1`)

| phase | kind | requests | success | p50 | p95 | upstream calls per request | requests with one call | served by fallback |
|---|---|---:|---:|---:|---:|---:|---:|---:|
| before | non-streamed | 3365 | 39.76% | 2000.8 ms | 28093.6 ms | 0.44 | 1266 | 778 |
| before | streamed | 872 | 39.56% | 2000.7 ms | 28074.0 ms | 0.44 | 326 | 183 |
| outage | non-streamed | 5192 | 22.05% | 6479.3 ms | 60001.9 ms | 0.22 | 1145 | 1142 |
| outage | streamed | 1300 | 22.08% | 6393.9 ms | 60001.8 ms | 0.22 | 287 | 287 |
| after | non-streamed | 5202 | 0.00% | 2000.5 ms | 2001.9 ms | 0.00 | 0 | 0 |
| after | streamed | 1340 | 0.00% | 2000.5 ms | 2001.9 ms | 0.00 | 0 | 0 |

## Without a chain

| phase | kind | requests | success | p50 | p95 | upstream calls per request | requests with one call | served by fallback |
|---|---|---:|---:|---:|---:|---:|---:|---:|
| before | non-streamed | 3326 | 20.23% | 2001.1 ms | 41549.3 ms | 0.23 | 694 | 0 |
| before | streamed | 853 | 21.57% | 2000.9 ms | 41562.1 ms | 0.25 | 186 | 0 |
| outage | non-streamed | 5812 | 0.03% | 2000.7 ms | 7899.5 ms | 0.00 | 2 | 0 |
| outage | streamed | 1464 | 0.00% | 2000.7 ms | 7887.2 ms | 0.00 | 0 | 0 |
| after | non-streamed | 3036 | 0.00% | 2000.6 ms | 2002.7 ms | 0.00 | 0 | 0 |
| after | streamed | 766 | 0.00% | 2000.6 ms | 2002.5 ms | 0.00 | 0 | 0 |
