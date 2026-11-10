# Exact-match cache

Source: `cache-cold.json`, `cache-warm.json`, `cache-warm-stream.json` and `cache-stampede.json` (k6 summary exports of `bench/k6/cache.js`, started by `bench/run-cache.sh`).
Conditions: `conditions.txt` in this folder. Hits and misses are what the gateway reported in `x-gateway-cache`; upstream calls are the sum of `x-gateway-attempts` (0 for a hit).
Every request is `temperature: 0`. The cache is empty for each run's prompts when it starts, so the first request for a prompt is a miss.

| run | requests | hits | misses | other | hit rate | upstream calls | non-200 | hit p50 | hit p95 | miss p50 | miss p95 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| Cold: every prompt new | 5945 | 0 | 5945 | 0 | 0.00% | 5945 | 0 | n/a | n/a | 610.2 ms | 717.9 ms |
| Warm: Zipf draw from a fixed prompt set | 5998 | 5800 | 198 | 0 | 96.70% | 198 | 0 | 3.1 ms | 5.4 ms | 559.0 ms | 611.9 ms |
| Warm, streamed | 5996 | 5738 | 258 | 0 | 95.70% | 258 | 0 | 3.4 ms | 5.5 ms | 590.7 ms | 760.7 ms |
| Stampede: identical requests at once | 50 | 49 | 1 | 0 | 98.00% | 1 | 0 | 453.5 ms | 454.2 ms | 448.6 ms | 448.6 ms |
