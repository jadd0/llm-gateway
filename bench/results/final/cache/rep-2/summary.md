# Exact-match cache

Source: `cache-cold.json`, `cache-warm.json`, `cache-warm-stream.json` and `cache-stampede.json` (k6 summary exports of `bench/k6/cache.js`, started by `bench/run-cache.sh`).
Conditions: `conditions.txt` in this folder. Hits and misses are what the gateway reported in `x-gateway-cache`; upstream calls are the sum of `x-gateway-attempts` (0 for a hit).
Every request is `temperature: 0`. The cache is empty for each run's prompts when it starts, so the first request for a prompt is a miss.

| run | requests | hits | misses | other | hit rate | upstream calls | non-200 | hit p50 | hit p95 | miss p50 | miss p95 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| Cold: every prompt new | 2163 | 0 | 2147 | 16 | 0.00% | 2147 | 16 | n/a | n/a | 10631.4 ms | 47552.8 ms |
| Warm: Zipf draw from a fixed prompt set | 4975 | 4777 | 198 | 0 | 96.02% | 198 | 0 | 30.7 ms | 30397.8 ms | 37370.9 ms | 53994.1 ms |
| Warm, streamed | 5954 | 5618 | 336 | 0 | 94.36% | 336 | 0 | 3.7 ms | 42.1 ms | 1862.1 ms | 5104.8 ms |
| Stampede: identical requests at once | 50 | 49 | 1 | 0 | 98.00% | 1 | 0 | 477.4 ms | 478.0 ms | 471.1 ms | 471.1 ms |
