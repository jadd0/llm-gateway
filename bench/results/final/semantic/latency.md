# Semantic cache request latency

Source: `semantic-seed.json`, `semantic-paraphrase.json`, `semantic-exact.json` and `semantic-miss.json` (k6 summary exports of `bench/k6/semantic.js`, started by `bench/run-semantic.sh`).
Conditions: `conditions.txt` in this folder. Statuses are what the gateway reported in `x-gateway-cache`; upstream calls are the sum of `x-gateway-attempts`.

| run | requests | exact hits | semantic hits | misses | other | upstream calls | non-200 | exact-hit p50 / p95 | semantic-hit p50 / p95 | miss p50 / p95 | median similarity |
|---|---:|---:|---:|---:|---:|---:|---:|---|---|---|---:|
| Seed: the original prompts, once each | 200 | 0 | 0 | 200 | 0 | 200 | 0 | n/a / n/a | n/a / n/a | 475.8 ms / 1022.0 ms | n/a |
| Paraphrase: another wording of a seeded prompt | 301 | 80 | 143 | 78 | 0 | 78 | 0 | 4.4 ms / 9.7 ms | 37.6 ms / 69.0 ms | 443.3 ms / 471.1 ms | 0.974 |
| Exact: a seeded prompt repeated | 301 | 301 | 0 | 0 | 0 | 0 | 0 | 9.8 ms / 14.1 ms | n/a / n/a | n/a / n/a | n/a |
| Miss: a system prompt nobody has used | 301 | 0 | 0 | 301 | 0 | 301 | 0 | n/a / n/a | n/a / n/a | 431.1 ms / 449.8 ms | n/a |
