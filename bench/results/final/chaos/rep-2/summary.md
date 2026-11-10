# Resilience under outage

Source: `chaos-fallback-on.json` and `chaos-fallback-off.json` (k6 summary exports of `bench/k6/chaos.js`, started by `bench/run-chaos.sh`).
Conditions: `conditions.txt` in this folder. Success is a complete answer: HTTP 200, and for a stream the `[DONE]` terminator.
The phase of a request is the one it was sent in: before the first mock is killed, while it is down, after a fresh one is started.

## With the fallback chain (`mock-openai-1>mock-anthropic-1`)

| phase | kind | requests | success | p50 | p95 | upstream calls per request | requests with one call | served by fallback |
|---|---|---:|---:|---:|---:|---:|---:|---:|
| before | non-streamed | 3095 | 100.00% | 13261.5 ms | 14677.0 ms | 1.08 | 2978 | 1544 |
| before | streamed | 795 | 99.75% | 11776.2 ms | 14699.2 ms | 1.09 | 762 | 389 |
| outage | non-streamed | 3952 | 5.01% | 60001.1 ms | 60002.5 ms | 0.05 | 198 | 198 |
| outage | streamed | 967 | 5.17% | 60001.1 ms | 60002.6 ms | 0.05 | 50 | 50 |
| after | non-streamed | 4447 | 0.00% | 0.0 ms | 0.1 ms | 0.00 | 0 | 0 |
| after | streamed | 910 | 0.00% | 0.1 ms | 0.2 ms | 0.00 | 0 | 0 |

## Without a chain

| phase | kind | requests | success | p50 | p95 | upstream calls per request | requests with one call | served by fallback |
|---|---|---:|---:|---:|---:|---:|---:|---:|
| before | non-streamed | 2970 | 44.81% | 11756.5 ms | 60001.0 ms | 1.05 | 1346 | 0 |
| before | streamed | 762 | 45.54% | 11780.5 ms | 60001.0 ms | 1.04 | 349 | 0 |
| outage | non-streamed | 3757 | 0.00% | 60001.2 ms | 60002.5 ms | 0.00 | 0 | 0 |
| outage | streamed | 904 | 0.00% | 60001.2 ms | 60002.5 ms | 0.00 | 0 | 0 |
| after | non-streamed | 1718 | 0.00% | 0.0 ms | 0.1 ms | 0.00 | 0 | 0 |
| after | streamed | 891 | 0.00% | 0.1 ms | 0.1 ms | 0.00 | 0 | 0 |
