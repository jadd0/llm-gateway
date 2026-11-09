# Architecture

Diagram: [architecture.html](architecture.html).

An LLM gateway is one HTTP endpoint that apps call instead of calling model providers directly.
It forwards each request upstream and relays the answer, and later PRs add the policy around that
hop (auth, limits, budgets, caching, failover, logging).

## Built

- **Gateway** (`packages/gateway`): Fastify. `POST /v1/chat/completions` is forwarded to one upstream,
  streamed or not. See [../gateway/README.md](../gateway/README.md).
- **Mock provider** (`packages/mock-provider`): OpenAI-wire-format stand-in with configurable latency,
  errors and outages. See [../mock-provider/README.md](../mock-provider/README.md).
- **Redis and Postgres+pgvector** (`docker-compose.yml`): started, not yet used by gateway code.

## Planned (marked dashed in the diagram)

Real provider adapters, per-key auth, Redis token-bucket limits, budgets, exact and semantic caches,
retries and circuit breaker, a batched request-log queue into Postgres, and the dashboard.

## Request flow today

client, then gateway, then the mock, then back. Nothing else sits on the path.

## Why this design

The gateway is a stateless process in front of the providers, so more instances can be added behind a load
balancer and shared state (limits, caches, logs) lives in Redis and Postgres rather than in the process.
PR 1 builds only the hop in the middle and measures it first, so every later feature has a baseline to be
compared against rather than an impression.

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
   Postgres. PR 1 does not use either yet; they are started so later PRs have them.
3. **What is built versus planned?** Built: passthrough and the mock. Planned: everything dashed in the
   diagram.
4. **How do you know the numbers are the gateway's?** The mock removes provider variance, and each figure is
   a difference against a direct-to-mock run at the same rate.
5. **What is not known yet?** What limits throughput above 10000 req/s on this machine; see the
   benchmarks page.
