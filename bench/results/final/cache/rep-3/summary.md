# Exact-match cache

Source: `cache-cold.json`, `cache-warm.json`, `cache-warm-stream.json` and `cache-stampede.json` (k6 summary exports of `bench/k6/cache.js`, started by `bench/run-cache.sh`).
Conditions: `conditions.txt` in this folder. Hits and misses are what the gateway reported in `x-gateway-cache`; upstream calls are the sum of `x-gateway-attempts` (0 for a hit).
Every request is `temperature: 0`. The cache is empty for each run's prompts when it starts, so the first request for a prompt is a miss.

| run | requests | hits | misses | other | hit rate | upstream calls | non-200 | hit p50 | hit p95 | miss p50 | miss p95 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| Cold: every prompt new | 3920 | 0 | 3784 | 136 | 0.00% | 3786 | 134 | n/a | n/a | 29131.0 ms | 45545.6 ms |
| Warm: Zipf draw from a fixed prompt set | 5206 | 5006 | 200 | 0 | 96.16% | 200 | 0 | 4.5 ms | 10213.6 ms | 10518.9 ms | 16423.6 ms |
| Warm, streamed | 5995 | 5748 | 247 | 0 | 95.88% | 247 | 0 | 3.8 ms | 6.0 ms | 606.3 ms | 990.3 ms |
| Stampede: identical requests at once | 50 | 49 | 1 | 0 | 98.00% | 1 | 0 | 493.4 ms | 494.0 ms | 490.5 ms | 490.5 ms |
