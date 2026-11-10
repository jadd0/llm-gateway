# LLM Gateway

A self-hostable TypeScript proxy that sits between your apps and LLM providers. Apps talk to one
OpenAI-compatible endpoint; the gateway handles routing, per-tenant rate limits and budgets,
provider failover, and caching, and logs every request without slowing it down.

The project is built to be measured. Every claim below about throughput, overhead or correctness
is backed by a benchmark you can re-run from this repo, and a number appears here only once a
committed run produces it.

> **Status:** early development. The scope below is the v1 plan; nothing is usable yet.

## v1 scope

- **Unified API:** one OpenAI-compatible `/v1/chat/completions` endpoint routing to Anthropic,
  OpenAI and one more provider. Each provider's format and streams are translated to OpenAI's without buffering.
- **Auth and tenancy:** API keys per tenant, hashed at rest, each with its own limits and budget.
- **Rate limiting:** token-bucket limits per key in Redis, enforced by atomic Lua scripts so they
  stay correct across many gateway instances.
- **Budgets:** hard spend caps per tenant. Cost is estimated before the call, reconciled against
  actual tokens after, and requests are refused once the budget is spent.
- **Resilience:** retries with exponential backoff and jitter, timeouts, a circuit breaker per
  provider, and an ordered fallback chain of models.
- **Caching:** an exact-match cache keyed on a normalised request hash, plus an opt-in semantic cache
  (off until a tenant turns it on) that embeds the prompt and serves near-duplicates found in pgvector
  above a similarity threshold, once their numbers, names, quotes and negations also agree.
  Either can be skipped per request.
- **Observability:** every request is logged with tenant, model, tokens, cost, latency, cache hit
  and fallback used. Log writes go through a queue and are batch-inserted, off the request path.
- **Dashboard:** a small Next.js page showing p50/p95 latency, spend by tenant, cache hit rate and
  error rate over time, read from pre-aggregated rollups.

## Architecture

```
client ──► gateway (stateless, N instances behind a load balancer)
             │  authenticate key
             │  check rate limit ─────────────► Redis (Lua token buckets)
             │  check budget
             │  exact cache ──────────────────► Redis
             │  semantic cache ───────────────► Postgres + pgvector
             │  provider call (retry, breaker, fallback) ──► Anthropic / OpenAI / …
             │  stream response to client
             └► enqueue log + cost reconciliation ──► queue ──► Postgres (batched)
```

| Component | Responsibility |
|---|---|
| Gateway (Node, Fastify) | Stateless request handling: auth, routing, streaming |
| Redis | Rate-limit buckets, exact cache, circuit-breaker state |
| Postgres + pgvector | Tenants, keys, budgets, request log, semantic cache |
| Queue | Async log writes, cost reconciliation, embedding jobs |
| Mock provider | OpenAI-compatible stand-in with configurable latency, errors and outages, so benchmarks measure the gateway rather than a real provider |
| Dashboard (Next.js) | Metrics over the request log |

Design notes and diagrams per part live in [`docs/`](docs/README.md).

## Benchmarks

All load tests use [k6](https://k6.io) against the mock provider. Gateway-added overhead is
reported separately from total latency. Results, hardware, method and the raw k6 output are in
[BENCHMARKS.md](BENCHMARKS.md) and `bench/results/final*/`; one script (`bash bench/run-all.sh`) runs them all.
Everything ran on one laptop (Apple M5, 10 cores), load generator included: the ceilings are this machine's.

| Area | What is measured | Result |
|---|---|---|
| Overhead | Gateway-added latency, p50 / p95 | 1.4 ms / 2.1 ms non-streamed (instant mock); inside the noise against a 200 ms provider |
| Throughput | Ceiling and breaking point, every feature on, through nginx | 2000 req/s ceiling; breaks at 4000 req/s with one instance (CPU-bound on budget rebuilds) and 5000 to 6000 with three |
| Steady load | 60 s at 60% of the ceiling | 0 failures in 216003 requests, p95 8.6 ms (1 instance) and 9.1 ms (3) |
| Correctness | Over-limit and over-cap requests, 3 instances, 10 runs each | 0 over the rate limit, 0 over the budget cap, also with Redis restarted mid-run |
| Resilience | Success while the primary provider is down | 100% non-streamed and 99.33% streamed with a fallback chain; fails fast without one |
| Caching | Exact-match hit rate on a Zipf prompt draw | 96.7%, hits in 1.1 ms p50 against 403 ms for a miss; 50 identical requests make 1 upstream call |
| Semantic cache | Wrong answers served, held-out QQP and PAWS pairs | no threshold stays under 1% wrong with the local embedder (best 55.89%), so it stays off by default |
| Dashboard | Overview query at 5M log rows | 23.5 ms on the rollups against 2708 ms from the raw log, same answers |

## Getting started

Needs Node 24+ (26 recommended), npm, Docker (for Redis and Postgres) and [k6](https://k6.io) for benchmarks. Postgres must have the
[pgvector](https://github.com/pgvector/pgvector) extension (the compose file runs a pinned `pgvector/pgvector` image); migration 0007 creates it.

```
npm ci
cp .env.example .env.local
docker compose up -d --wait      # Redis and Postgres+pgvector (not yet used by gateway code)
npm run dev:mock                 # mock provider on :9000
npm run dev:gateway              # gateway on :8080
curl -N localhost:8080/v1/chat/completions -H 'content-type: application/json' \
  -d '{"model":"m","stream":true,"messages":[{"role":"user","content":"hi"}]}'
npm run check                    # typecheck and tests
npm run bench:baseline           # k6 baseline, writes bench/results/pr-1/
```

Per-part docs and diagrams are in [docs/](docs/README.md); measured numbers are in
[BENCHMARKS.md](BENCHMARKS.md).

## Roadmap (out of scope for v1)

- Prompt management UI
- Fine-tuning
- Billing integration
- Plugin system
- Multi-region deployment

## License

[MIT](LICENSE)
