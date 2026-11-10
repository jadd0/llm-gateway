<!-- product-kit docs/diagrams/flows.md v1 — from umbo 0f95e4fa -->
# Data-flow registry

Every data flow the product has, one line each, in the format

`- <flow name> → \`docs/diagrams/<file>.html\` → \`<code glob>\``

`scripts/check-diagrams.mjs` (the gate's `check-diagrams` step) reads this file, not the plans.
Each line must parse and its diagram must exist. Every entry of its code glob (each member of a
`{a,b}` group) must match a tracked file, so a move that left a path behind fails here instead of
going quiet. The diagram must not be older than the last commit touching a file the glob matches.

A plan adds or changes a flow by editing this file, and its `## Data flows` section names the same
lines verbatim; for any plan in the branch's diff, a flow line missing from this file fails the step.

## Flows

- Chat completion routing and translation → `docs/providers/providers.html` → `packages/gateway/src/{routes/chat.ts,providers/*.ts,upstream.ts}`
- Chat completion passthrough (OpenAI-format upstreams) → `docs/gateway/chat-passthrough.html` → `packages/gateway/src/{routes/chat.ts,providers/openai.ts,upstream.ts}`
- API key check → `docs/auth/api-key-check.html` → `packages/gateway/src/auth/{plugin.ts,key-store.ts}`
- API key management (CLI) → `docs/auth/api-key-check.html` → `packages/gateway/src/cli/keys.ts`
- Rate limit check and usage reconcile → `docs/rate-limiter/token-bucket.html` → `packages/gateway/src/{ratelimit/*.ts,ratelimit/token-bucket.lua,usage/*.ts}`
- Budget reserve and settle → `docs/budgets/budget-flow.html` → `packages/gateway/src/budget/*.ts`
- Spend recorded to Postgres → `docs/budgets/budget-flow.html` → `packages/gateway/src/budget/{budget.ts,pg-ledger.ts}`
- Budget settle via the stream → `docs/budgets/budget-flow.html` → `packages/{gateway/src/budget/*,log-worker/src/batch.ts}`
- Request log: gateway → Redis stream → log worker → Postgres → `docs/request-log/request-log.html` → `packages/{gateway/src/requestlog/*.ts,log-worker/src/*.ts}`
- Chat completion attempts (retry, breaker, fallback) → `docs/resilience/request-attempts.html` → `packages/gateway/src/{routes/chat.ts,resilience/*.ts}`
- Breaker state → `docs/resilience/breaker.html` → `packages/gateway/src/resilience/{breaker.ts,breaker.lua}`
- Exact-match cache lookup, single-flight and fill → `docs/cache/cache-flow.html` → `packages/gateway/src/{cache/*.ts,routes/chat.ts}`
- Semantic cache lookup and async fill → `docs/semantic-cache/semantic-flow.html` → `packages/gateway/src/{semantic/*.ts,cache/plugin.ts}`
- Benchmark rig (k6, nginx, three gateways, Redis, Postgres, mock, log worker) → `docs/benchmarks/cluster.html` → `bench/{cluster.sh,nginx/nginx.conf}`
- Rollups: log worker batch → rollup tables → dashboard → `docs/dashboard/rollups.html` → `packages/{log-worker/src/{rollup,histogram}.ts,dashboard/lib/queries.ts}`
