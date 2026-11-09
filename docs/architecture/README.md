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
