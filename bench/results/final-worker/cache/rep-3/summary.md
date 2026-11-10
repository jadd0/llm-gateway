# Exact-match cache

Source: `cache-cold.json`, `cache-warm.json`, `cache-warm-stream.json` and `cache-stampede.json` (k6 summary exports of `bench/k6/cache.js`, started by `bench/run-cache.sh`).
Conditions: `conditions.txt` in this folder. Hits and misses are what the gateway reported in `x-gateway-cache`; upstream calls are the sum of `x-gateway-attempts` (0 for a hit).
Every request is `temperature: 0`. The cache is empty for each run's prompts when it starts, so the first request for a prompt is a miss.

| run | requests | hits | misses | other | hit rate | upstream calls | non-200 | hit p50 | hit p95 | miss p50 | miss p95 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| Cold: every prompt new | 6001 | 0 | 6001 | 0 | 0.00% | 6001 | 0 | n/a | n/a | 403.0 ms | 404.3 ms |
| Warm: Zipf draw from a fixed prompt set | 6001 | 5802 | 199 | 0 | 96.68% | 199 | 0 | 1.1 ms | 1.3 ms | 403.5 ms | 405.0 ms |
| Warm, streamed | 6001 | 5751 | 250 | 0 | 95.83% | 250 | 0 | 1.1 ms | 1.3 ms | 400.9 ms | 405.7 ms |
| Stampede: identical requests at once | 50 | 49 | 1 | 0 | 98.00% | 1 | 0 | 409.0 ms | 409.3 ms | 407.4 ms | 407.4 ms |
