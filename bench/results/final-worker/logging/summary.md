# Request logging off the request path

Source: `logging-inline-<n>.json` and `logging-stream-<n>.json` (k6 summary exports of `bench/k6/logging.js`, started by `bench/run-logging.sh`) and `worker-stream-<n>.csv` (one sample a second).
Conditions: `conditions.txt` in this folder. Same constant arrival rate for both modes; the cells are the median over the repeats with the range in brackets.

| mode | repeats | requests | failed | p50 | p95 | p99 |
|---|---:|---:|---:|---|---|---|
| inline | 3 | 35905 | 0 | 402.3 ms (402.2 to 402.4) | 403.4 ms (403.4 to 403.7) | 404.4 ms (404.1 to 404.8) |
| stream | 3 | 35905 | 0 | 401.8 ms (401.8 to 401.9) | 403.1 ms (403.0 to 403.2) | 403.9 ms (403.9 to 404.1) |

Worker, stream mode:

| repeats | max lag (entries) | max pending | rows per second |
|---:|---|---:|---|
| 3 | 2 (2 to 2) | 3 | 195.2 (194.9 to 195.8) |
