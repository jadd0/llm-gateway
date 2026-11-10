# Exact-match cache

Source: `cache-cold.json`, `cache-warm.json`, `cache-warm-stream.json` and `cache-stampede.json` (k6 summary exports of `bench/k6/cache.js`, started by `bench/run-cache.sh`).
Conditions: `conditions.txt` in this folder. Hits and misses are what the gateway reported in `x-gateway-cache`; upstream calls are the sum of `x-gateway-attempts` (0 for a hit).
Every request is `temperature: 0`. The cache is empty for each run's prompts when it starts, so the first request for a prompt is a miss.

| run | requests | hits | misses | other | hit rate | upstream calls | non-200 | hit p50 | hit p95 | miss p50 | miss p95 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| Cold: every prompt new | 6000 | 0 | 6000 | 0 | 0.00% | 6000 | 0 | n/a | n/a | 403.3 ms | 404.6 ms |
| Warm: Zipf draw from a fixed prompt set | 6001 | 5802 | 199 | 0 | 96.68% | 199 | 0 | 1.4 ms | 2.0 ms | 405.5 ms | 408.2 ms |
| Warm, streamed | 6001 | 5760 | 241 | 0 | 95.98% | 241 | 0 | 1.4 ms | 2.0 ms | 405.1 ms | 418.9 ms |
| Stampede: identical requests at once | 50 | 49 | 1 | 0 | 98.00% | 1 | 0 | 411.0 ms | 411.6 ms | 409.6 ms | 409.6 ms |
