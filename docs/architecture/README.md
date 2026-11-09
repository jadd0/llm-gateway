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
  budget balances; Postgres holds tenants and API keys (with their limits and caps) and the spend record. Vectors and the request log are not used yet.

## Planned (marked dashed in the diagram)

Exact and semantic caches,
retries and circuit breaker, a batched request-log queue into Postgres, and the dashboard.

## Request flow today

client, then the gateway's key check (Redis, or Postgres on a miss), then the rate limit (one Redis script), then the
budget reservation, then the provider the model name selects (through its adapter), then back. A request over its limit is answered 429 before it reaches the mock.

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

## Questions you should be able to answer

1. **Why put a gateway between apps and providers at all?** One endpoint and one place for auth, limits,
   budgets, caching and failover. The price is an extra hop, which is why the hop is measured: 0.233 ms p50
   non-streamed in the baseline.
2. **Why is the gateway stateless?** So instances scale horizontally; anything shared goes to Redis or
   Postgres. Auth uses both: Postgres is the source of truth for keys, Redis only caches it.
3. **What is built versus planned?** Built: passthrough, provider adapters (Anthropic, OpenAI, Gemini), the mock, tenants and API-key auth, per-key rate limits, per-tenant monthly budgets (see [../budgets/](../budgets/README.md)), resilience: timeouts, retries, a Redis-shared circuit breaker and model fallback chains (see [../resilience/](../resilience/README.md)). Planned: everything dashed in the
   diagram.
4. **How do you know the numbers are the gateway's?** The mock removes provider variance, and each figure is
   a difference against a direct-to-mock run at the same rate.
5. **What is not known yet?** What limits throughput above 10000 req/s on this machine; see the
   benchmarks page.
