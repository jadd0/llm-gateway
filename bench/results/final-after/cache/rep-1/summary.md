# Exact-match cache

Source: `cache-cold.json`, `cache-warm.json`, `cache-warm-stream.json` and `cache-stampede.json` (k6 summary exports of `bench/k6/cache.js`, started by `bench/run-cache.sh`).
Conditions: `conditions.txt` in this folder. Hits and misses are what the gateway reported in `x-gateway-cache`; upstream calls are the sum of `x-gateway-attempts` (0 for a hit).
Every request is `temperature: 0`. The cache is empty for each run's prompts when it starts, so the first request for a prompt is a miss.

| run | requests | hits | misses | other | hit rate | upstream calls | non-200 | hit p50 | hit p95 | miss p50 | miss p95 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| Cold: every prompt new | 6001 | 0 | 6001 | 0 | 0.00% | 6001 | 0 | n/a | n/a | 403.3 ms | 404.7 ms |
| Warm: Zipf draw from a fixed prompt set | 6001 | 5803 | 198 | 0 | 96.70% | 198 | 0 | 1.4 ms | 2.0 ms | 405.5 ms | 407.8 ms |
| Warm, streamed | 6001 | 5773 | 228 | 0 | 96.20% | 228 | 0 | 1.4 ms | 2.0 ms | 408.5 ms | 420.0 ms |
| Stampede: identical requests at once | 50 | 49 | 1 | 0 | 98.00% | 1 | 0 | 411.9 ms | 412.1 ms | 409.0 ms | 409.0 ms |
