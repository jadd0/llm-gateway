# Architecture

Diagram: [architecture.html](architecture.html).

An LLM gateway is one HTTP endpoint that apps call instead of calling model providers directly.
It forwards each request to the provider its model name selects and relays the answer, translated to OpenAI's format where the provider has its own, and later PRs add the policy around that
hop (auth, limits, budgets, resilience, caching, logging).

## Built

- **Gateway** (`packages/gateway`): Fastify. `POST /v1/chat/completions` is routed by model name to OpenAI, Anthropic or Gemini (or the mock), translated where needed,
  streamed or not. See [../providers/README.md](../providers/README.md). See [../gateway/README.md](../gateway/README.md).
- **Mock provider** (`packages/mock-provider`): OpenAI-wire-format stand-in with configurable latency,
  errors and outages. See [../mock-provider/README.md](../mock-provider/README.md).
- **Auth** (`packages/gateway/src/auth`): every request needs `Authorization: Bearer gw_...`. Keys are stored
  as HMAC-SHA256 hashes in Postgres and cached in Redis. See [../auth/README.md](../auth/README.md).
- **Rate limiter** (`packages/gateway/src/ratelimit`, `usage`): per-key token buckets for requests and tokens per
  minute, kept in Redis by one Lua script so every gateway instance shares the count. See
  [../rate-limiter/README.md](../rate-limiter/README.md).
- **Budgets** (`packages/gateway/src/budget`, `pricing`): a monthly spend cap per tenant. The worst-case cost is
  reserved atomically in Redis before the call and replaced by the actual cost after; Postgres records every charge and
  decides instead while Redis is down. See [../budgets/README.md](../budgets/README.md).
- **Redis and Postgres+pgvector** (`docker-compose.yml`): Redis holds the key cache, the rate-limit buckets and the live
  budget balances; Postgres holds tenants and API keys (with their limits and caps) and the spend record. The request log and the spend queue live in a Redis stream. Vectors are not used yet.

- **Response cache** (`packages/gateway/src/cache`): identical `temperature: 0` requests are answered from Redis, scoped per
  tenant, with one upstream call per burst of identical misses. See [../cache/README.md](../cache/README.md).
- **Request log** (`packages/gateway/src/requestlog`, `packages/log-worker`): every request becomes one entry in a Redis stream, and settled spend travels in the same stream; the log worker writes both to Postgres in batches. See [../request-log/README.md](../request-log/README.md).
- **Dashboard** (`packages/dashboard`): a Next.js admin page showing latency percentiles, spend by tenant, cache hit rate and error rate from rollups the log worker writes in each batch's transaction, read through a read-only Postgres role. See [../dashboard/README.md](../dashboard/README.md).
- **Resilience** (`packages/gateway/src/resilience`): timeouts, retries, a Redis-shared circuit breaker and fallback chains. See [../resilience/README.md](../resilience/README.md).

## Planned (marked dashed in the diagram)

The semantic cache.

## Request flow today

client, then the gateway's key check (Redis, or Postgres on a miss), then the rate limit (one Redis script), then the
response cache (a hit is answered here, at no cost), then the budget reservation, then the provider the model name selects (through its adapter), then back. A request over its limit is answered 429 before it reaches the mock.

## Why this design

The gateway is a stateless process in front of the providers, so more instances can be added behind a load
balancer and shared state (limits, caches, logs) lives in Redis and Postgres rather than in the process.
PR 1 built only the hop in the middle and measured it first, so every later feature has a baseline to be
compared against rather than an impression. PR 3 added the key check and re-measured; the cost is in
[../auth/README.md](../auth/README.md).

## Measured today (from [BENCHMARKS.md](../../BENCHMARKS.md))

- Overhead of the hop: 0.233 ms p50 / 0.982 ms p95 non-streamed at 1000 req/s; 0.238 ms p50 / 0.254 ms p95
  to first streamed byte at 200 req/s.
- Throughput: last good step 10000 req/s through one gateway process, zero errors up to 20000 req/s, with
  p95 degrading from 12000 req/s. One run per step, laptop, k6 on the same machine.
