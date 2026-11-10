# Request logging off the request path

Source: `logging-inline-<n>.json` and `logging-stream-<n>.json` (k6 summary exports of `bench/k6/logging.js`, started by `bench/run-logging.sh`) and `worker-stream-<n>.csv` (one sample a second).
Conditions: `conditions.txt` in this folder. Same constant arrival rate for both modes; the cells are the median over the repeats with the range in brackets.

| mode | repeats | requests | failed | p50 | p95 | p99 |
|---|---:|---:|---:|---|---|---|
| inline | 3 | 18429 | 6311 | 13858.0 ms (13680.7 to 18683.4) | 38137.2 ms (37017.9 to 56045.0) | 38778.8 ms (37682.7 to 57398.1) |
| stream | 3 | 26561 | 20254 | 0.0 ms (0.0 to 0.0) | 60001.3 ms (50500.3 to 60001.4) | 60002.2 ms (51027.8 to 60002.2) |

Worker, stream mode:

| repeats | max lag (entries) | max pending | rows per second |
|---:|---|---:|---|
| 3 | 47 (23 to 63) | 61 | 43.7 (38.4 to 57.3) |
