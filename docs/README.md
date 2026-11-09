# Docs

One folder per part of the system. Each holds a `README.md` and a diagram drawn from the code as built.

- [architecture/](architecture/README.md): the whole v1 system, built and planned parts marked.
- [gateway/](gateway/README.md): the Fastify proxy, streaming passthrough, upstream pool, error mapping.
- [providers/](providers/README.md): Anthropic, OpenAI and Gemini adapters, model routing, stream translation, error mapping.
- [mock-provider/](mock-provider/README.md): the OpenAI-compatible stand-in used for tests and benchmarks.
- [auth/](auth/README.md): tenants, hashed API keys, the Redis key cache and instant revocation.
- [rate-limiter/](rate-limiter/README.md): per-key requests and tokens per minute in one Redis Lua script, usage reconcile, fail open.
- [resilience/](resilience/README.md): per-phase timeouts, retries with jitter, a Redis-shared circuit breaker, model fallback chains.
- [budgets/](budgets/README.md): monthly spend caps per tenant, reserve-then-settle in Redis, Postgres fallback, the epoch.
- [benchmarks/](benchmarks/README.md): how overhead is measured, and why the rig runs natively.

Flow registry for the diagram check: [diagrams/flows.md](diagrams/flows.md). Numbers live in [../BENCHMARKS.md](../BENCHMARKS.md).
