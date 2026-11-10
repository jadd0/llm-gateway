# Request logging off the request path

Source: `logging-inline-<n>.json` and `logging-stream-<n>.json` (k6 summary exports of `bench/k6/logging.js`, started by `bench/run-logging.sh`) and `worker-stream-<n>.csv` (one sample a second).
Conditions: `conditions.txt` in this folder. Same constant arrival rate for both modes; the cells are the median over the repeats with the range in brackets.

| mode | repeats | requests | failed | p50 | p95 | p99 |
|---|---:|---:|---:|---|---|---|
| inline | 3 | 12551 | 4318 | 57369.1 ms (14379.9 to 59999.6) | 60001.6 ms (59999.8 to 60001.6) | 60001.7 ms (60000.9 to 60001.7) |
| stream | 3 | 13922 | 5059 | 59999.8 ms (30506.7 to 60000.1) | 60001.2 ms (34045.9 to 60001.7) | 60001.8 ms (57003.2 to 60002.1) |

Worker, stream mode:

| repeats | max lag (entries) | max pending | rows per second |
|---:|---|---:|---|
| 3 | 30 (21 to 33) | 144 | 69.3 (55.1 to 83.4) |
