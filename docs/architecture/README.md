# Architecture

Diagram: [architecture.html](architecture.html) (explorable; [architecture.png](architecture.png) is the static export).

An LLM gateway is one HTTP endpoint that apps call instead of calling model providers directly.
It forwards each request to the provider its model name selects and relays the answer, translated to OpenAI's format where the provider has its own, and wraps the policy around that
hop: auth, limits, budgets, resilience, caching and logging.

## Parts

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
  budget balances; Postgres holds tenants and API keys (with their limits and caps) and the spend record. The semantic cache keeps prompt vectors in Postgres; the request log and the spend queue live in a Redis stream.

- **Response cache** (`packages/gateway/src/cache`): identical `temperature: 0` requests are answered from Redis, scoped per
  tenant, with one upstream call per burst of identical misses. See [../cache/README.md](../cache/README.md).
- **Semantic cache** (`packages/gateway/src/semantic`): after an exact miss, the last user message is embedded (Voyage, else a local model) and the nearest stored prompt in pgvector serves its cached answer when close enough and its numbers, names, quotes and negations agree. Off per tenant until it opts in. See [../semantic-cache/README.md](../semantic-cache/README.md).
- **Request log** (`packages/gateway/src/requestlog`, `packages/log-worker`): every request becomes one entry in a Redis stream, and settled spend travels in the same stream; the log worker writes both to Postgres in batches. See [../request-log/README.md](../request-log/README.md).
- **Dashboard** (`packages/dashboard`): a Next.js admin page showing latency percentiles, spend by tenant, cache hit rate and error rate from rollups the log worker writes in each batch's transaction, read through a read-only Postgres role. See [../dashboard/README.md](../dashboard/README.md).
- **Resilience** (`packages/gateway/src/resilience`): timeouts, retries, a Redis-shared circuit breaker and fallback chains. See [../resilience/README.md](../resilience/README.md).

## Request flow

client, then the gateway's key check (Redis, or Postgres on a miss), then the rate limit (one Redis script), then the
response cache (a hit, exact or by meaning, is answered here, at no cost), then the budget reservation, then the provider the model name selects (through its adapter), then back. A request over its limit is answered 429 before it reaches the mock.

## Why this design

The gateway is a stateless process in front of the providers, so more instances can be added behind a load
balancer and shared state (limits, caches, balances, the log queue) lives in Redis and Postgres rather than in the process.
The hop in the middle was built and measured first, so every feature added after it has a baseline to be
compared against rather than an impression. The cost of the key check is in [../auth/README.md](../auth/README.md).

## Measured (from [BENCHMARKS.md](../../BENCHMARKS.md))

Everything ran on one laptop with the load generator on the same machine; conditions are on that page.

- Overhead of the hop: 1.4 ms p50 / 2.1 ms p95 non-streamed with an instant mock; inside the noise against a
  200 ms provider.
- Throughput through nginx with every feature on: ceiling 2000 req/s; breaking point 4000 req/s with one
  instance (the gateway's CPU, spent on budget rebuilds), 6000 (5000 to 6000) with three before the index fix and
  5000 (4000 to 5000) after it.
