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
  OpenAI and one more provider. Server-sent event streams are passed through without buffering.
- **Auth and tenancy:** API keys per tenant, hashed at rest, each with its own limits and budget.
- **Rate limiting:** token-bucket limits per key in Redis, enforced by atomic Lua scripts so they
  stay correct across many gateway instances.
- **Budgets:** hard spend caps per tenant. Cost is estimated before the call, reconciled against
  actual tokens after, and requests are refused once the budget is spent.
- **Resilience:** retries with exponential backoff and jitter, timeouts, a circuit breaker per
  provider, and an ordered fallback chain of models.
- **Caching:** an exact-match cache keyed on a normalised request hash, plus a semantic cache that
  embeds the prompt and serves near-duplicates found in pgvector above a similarity threshold.
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
reported separately from total latency. Results, hardware, versions, concurrency and payload
sizes will live in `BENCHMARKS.md`, with the raw k6 output committed alongside.

| Area | What is measured | Result |
|---|---|---|
| Throughput | Sustained load against the mock provider | 10000 req/s through one gateway process, zero errors. One run per step, 15 s steps, "good" judged by a p95 criterion, k6, gateway and mock on one laptop; see [BENCHMARKS.md](BENCHMARKS.md) |
| Overhead | Gateway-added latency, p50 / p95 | 0.23 ms / 0.98 ms non-streamed at 1000 req/s; 0.24 ms / 0.25 ms to first streamed byte at 200 req/s |
| Correctness | Over-limit requests across 3+ instances under concurrent load | _not yet measured_ |
| Resilience | Client success rate while a provider is down | _not yet measured_ |
| Caching | Hit rate and spend saved on a realistic prompt set | _not yet measured_ |

Planned scenarios: steady load, spike, 1 vs 3 instances, cache cold vs warm, and a provider
outage mid-test.

## Getting started

Needs Node 24+ (26 recommended), npm, Docker (for Redis and Postgres) and [k6](https://k6.io) for benchmarks.

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
