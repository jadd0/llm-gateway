# Docs

One folder per part of the system. Each holds a `README.md` and a diagram drawn from the code as built.

- [architecture/](architecture/README.md): the whole v1 system, built and planned parts marked.
- [gateway/](gateway/README.md): the Fastify proxy, streaming passthrough, upstream pool, error mapping.
- [mock-provider/](mock-provider/README.md): the OpenAI-compatible stand-in used for tests and benchmarks.
- [benchmarks/](benchmarks/README.md): how overhead is measured, and why the rig runs natively.

Flow registry for the diagram check: [diagrams/flows.md](diagrams/flows.md). Numbers live in [../BENCHMARKS.md](../BENCHMARKS.md).
