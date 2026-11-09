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

- Chat completion passthrough → `docs/gateway/chat-passthrough.html` → `packages/gateway/src/{routes/chat.ts,upstream.ts}`
- API key check → `docs/auth/api-key-check.html` → `packages/gateway/src/auth/{plugin.ts,key-store.ts}`
- API key management (CLI) → `docs/auth/api-key-check.html` → `packages/gateway/src/cli/keys.ts`
