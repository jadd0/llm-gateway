# Roadmap — llm-gateway

Queue for /product. One `## PR <id> — title` block per PR, built in order (PRs stack). Every
acceptance line ends in a check or a number from a committed run; no figure enters the README or
BENCHMARKS.md without one. Every PR creates or updates `docs/<part>/` for each part it touches: a
plain-English README (what, why, decisions with their numbers, likely interview questions) and an
archify diagram of that part (D-007, D-009). Tests sit beside the code they test (D-008).

## PR 1 — Skeleton, mock provider and streaming passthrough
status: pending
acceptance: `docker compose up` brings up Redis and Postgres+pgvector; `POST /v1/chat/completions` through the gateway returns the mock's response, streamed and non-streamed, with SSE chunks arriving unbuffered (test asserts the first chunk reaches the client before the last is sent); a committed k6 run of the mock direct vs through the gateway records gateway overhead p50/p95 and req/s in BENCHMARKS.md with hardware and versions.
scope_notes: one upstream (the mock, OpenAI format). No auth, limits, caching, retries or logging pipeline. Gate goes green (first tests land here).
base_branch: main
commit:
completed_at:
notes:

## PR 2 — Framework comparison benchmark
status: pending
acceptance: the same trivial proxy route on raw node:http, Express 5 and Fastify, each load-tested by k6 under identical settings; req/s and p50/p95 for each committed with raw output and written up in docs/benchmarks/ (framework comparison section and diagram).
scope_notes: bench code lives under bench/; does not change the gateway.
base_branch: main
commit:
completed_at:
notes:

## PR 3 — Tenants and API keys
status: pending
acceptance: tenants and keys in Postgres with keys stored hashed (never plaintext); a missing or wrong key gets 401, a valid key passes and the tenant is attached to the request; key lookup is cached so the hot path does not query Postgres per request; overhead re-measured with auth on and recorded.
scope_notes: key creation by CLI script, no admin UI. No limits or budgets yet.
base_branch: main
commit:
completed_at:
notes:

## PR 4 — Distributed rate limiter (Redis Lua token bucket)
status: pending
acceptance: per-key token buckets for requests per minute and tokens per minute, enforced together by one atomic Lua script in Redis; a test firing 1,000 concurrent requests at a key limited to 100 requests/min admits exactly 100 and returns 429 with Retry-After to the rest, including when the requests are spread across 3 gateway app instances sharing one Redis; the token bucket is charged an estimate before the call and corrected to actual usage after (streamed and non-streamed); refill verified over time; Redis unavailable fails open; docs/rate-limiter/ walks the script line by line.
scope_notes: rate limits only (requests and tokens per minute, D-015). Spend caps are PR 5; the nginx multi-instance proof is PR 12.
base_branch: main
commit:
completed_at:
notes:

## PR 5 — Budgets: pre-estimate and reconcile
status: pending
acceptance: each tenant has a hard spend cap; cost is reserved atomically before the call from an estimate and reconciled to actual tokens after; a test hammering a tenant with a small cap under concurrency never lets settled spend exceed the cap; exhausted budget returns 402.
scope_notes: prices come from a static model price table in config. No billing integration.
base_branch: main
commit:
completed_at:
notes:

## PR 6 — Provider adapters: Anthropic, OpenAI and a third
status: pending
acceptance: one OpenAI-format request routes by model name to Anthropic, OpenAI or the third provider, translating request, response, streaming chunks and usage; contract tests run against recorded fixtures; one live smoke call per provider documented, not in the gate.
scope_notes: third provider chosen at plan time. The mock stays the benchmark target.
base_branch: main
commit:
completed_at:
notes:

## PR 7 — Resilience: timeouts, retries, circuit breaker, fallback
status: pending
acceptance: per-attempt timeouts; retries with exponential backoff and jitter on retryable errors only; a circuit breaker per provider with shared state in Redis; an ordered fallback chain of models; a k6 chaos run that kills the mock mid-load records client success % during the outage; explainer walks the breaker's states line by line.
scope_notes: no retry once a stream has started sending to the client.
base_branch: main
commit:
completed_at:
notes:

## PR 8 — Exact-match cache
status: pending
acceptance: non-streamed and streamed responses cached in Redis keyed on a normalised request hash; per-request opt-out header; k6 cold vs warm runs record hit rate and latency.
scope_notes: only deterministic requests (temperature 0) are cacheable unless configured otherwise.
base_branch: main
commit:
completed_at:
notes:

## PR 9 — Semantic cache (pgvector)
status: pending
acceptance: prompts embedded and stored in pgvector; near-duplicates above a similarity threshold served from cache; a realistic labelled prompt set measures hit rate and wrong-answer rate at several thresholds; HNSW vs IVFFlat compared on query latency and recall; the chosen threshold and index written up with the numbers.
scope_notes: embedding off the hot path where possible; opt-out shared with PR 8.
base_branch: main
commit:
completed_at:
notes:

## PR 10 — Queued, batched request logging
status: pending
acceptance: every request logged with tenant, model, tokens, cost, latency, cache hit and fallback used; writes go through a queue and are batch-inserted; k6 p95 recorded before and after moving logging off the request path; no log lost on graceful shutdown.
scope_notes: queue choice (BullMQ or pg-boss) decided at plan time.
base_branch: main
commit:
completed_at:
notes:

## PR 11 — Dashboard with rollups
status: pending
acceptance: a Next.js page shows p50/p95 latency, spend by tenant, cache hit rate and error rate over time, read from pre-aggregated rollups; query time stays flat on a seeded log of 1M+ rows (measured).
scope_notes: read-only, no auth beyond a single admin token. Founder signs off the screens.
base_branch: main
commit:
completed_at:
notes:

## PR 12 — Three instances, full benchmark suite
status: pending
acceptance: 3 gateway instances behind nginx; rate limits and budgets hold under concurrent load (0 over-limit requests across N runs, N recorded); scenarios steady, spike, 1 vs 3 instances, cache cold vs warm and provider outage all run from one script; breaking point found, cause named, fix applied and before/after numbers recorded in BENCHMARKS.md.
scope_notes: laptop vs cloud VM decided at plan time; hardware recorded either way.
base_branch: main
commit:
completed_at:
notes:

## PR 13 — Write-up and proof
status: pending
acceptance: README final with measured results and reproduction steps, architecture diagram, benchmark write-up published, 60s demo video linked.
scope_notes: blog post and video are the founder's; agents draft text and diagrams only.
base_branch: main
commit:
completed_at:
notes:
