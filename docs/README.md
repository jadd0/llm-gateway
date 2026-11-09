# Docs

One folder per part of the system. Each holds a `README.md` and a diagram drawn from the code as built.

- [architecture/](architecture/README.md): the whole v1 system, built and planned parts marked.
- [gateway/](gateway/README.md): the Fastify proxy, streaming passthrough, upstream pool, error mapping.
- [providers/](providers/README.md): Anthropic, OpenAI and Gemini adapters, model routing, stream translation, error mapping.
- [mock-provider/](mock-provider/README.md): the OpenAI-compatible stand-in used for tests and benchmarks.
- [auth/](auth/README.md): tenants, hashed API keys, the Redis key cache and instant revocation.
- [rate-limiter/](rate-limiter/README.md): per-key requests and tokens per minute in one Redis Lua script, usage reconcile, fail open.
- [budgets/](budgets/README.md): monthly spend caps per tenant, reserve-then-settle in Redis, Postgres fallback, the epoch.
- [benchmarks/](benchmarks/README.md): how overhead is measured, and why the rig runs natively.

Flow registry for the diagram check: [diagrams/flows.md](diagrams/flows.md). Numbers live in [../BENCHMARKS.md](../BENCHMARKS.md).

## Interview questions

Each part ends with "Questions you should be able to answer", with answers:

- [Architecture](architecture/README.md#questions-you-should-be-able-to-answer)
- [Gateway (chat passthrough)](gateway/README.md#questions-you-should-be-able-to-answer)
- [Auth (API keys)](auth/README.md#questions-you-should-be-able-to-answer)
- [Rate limiter](rate-limiter/README.md#questions-you-should-be-able-to-answer)
- [Budgets](budgets/README.md#questions-you-should-be-able-to-answer)
- [Providers](providers/README.md#questions-you-should-be-able-to-answer)
- [Benchmarks](benchmarks/README.md#questions-you-should-be-able-to-answer)
- [Mock provider](mock-provider/README.md#questions-you-should-be-able-to-answer)
