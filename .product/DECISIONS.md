<!-- product-kit DECISIONS.md v1 — from umbo 0f95e4fa -->
# Decision log

Every decision that shapes the product or the loop, so anyone can understand later why things are
the way they are. **Grep this before guessing, before "fixing" something that looks wrong, and
before planning anything in a category it covers.** The codemap says where; this says why.

Format — one entry per decision under its category, newest last, ids never reused:

```
- **D-001** YYYY-MM-DD · founder · active — <the decision, one sentence>. Why: <one clause>.
  Src: <plan D#, handoff file, or founder in chat: "<verbatim>"> · Code: <file/config row, if any>
```

- **Who:** `founder` (his words, quoted in Src) or `loop default` (taken on his behalf; listed in
  FOUNDER-TODO to ratify). **Status:** `active`, `superseded by D-…`, or `open`.
- Never delete or rewrite an old entry's meaning: a reversal adds a new entry and marks the old one
  `superseded by D-…`. Two lines per entry; detail lives in the Src file.
- Add a category only when none fits.

## Scope & positioning
- **D-001** 2026-11-08 · founder · active — v1 scope, success criteria and two-week plan are as written in the project brief; out-of-scope items go to the README roadmap. Why: a finished gateway with benchmarks beats a half-built one.
  Src: LLM_Gateway_Brief.pdf

## Pricing & billing

## Roles & permissions

## Money & payments
- **D-017** 2026-11-09 · founder · active — Tenant budgets use reserve-then-settle; the live balance is in Redis, every settled charge is recorded in Postgres, and Redis is rebuilt from Postgres when it loses the balance. Why: fast atomic checks without losing spend history.
  Src: .product/plans/pr-5.md; founder chose "Redis + Postgres record" · Code: packages/gateway/src/budget/
- **D-018** 2026-11-09 · founder · active — When Redis is down, budget checks fall back to a Postgres row-lock path (not fail open, not fail closed). Why: the rate limiter fails open (D-016), so budgets must keep spend capped.
  Src: founder chose "Fall back to Postgres" · Code: packages/gateway/src/budget/pg-ledger.ts
- **D-019** 2026-11-09 · founder · active — Budgets are monthly caps that reset on the 1st of each UTC calendar month. Why: matches how API plans work.
  Src: founder chose "Monthly, resets"
- **D-024** 2026-11-09 · founder · active — Budget caps are hard through a Redis outage: every hold is written to Postgres as well as Redis, the Postgres path and every Redis rebuild count unexpired Postgres holds, and settles always land on the current balance. Costs one extra Postgres write per request (to be measured). Why: the PR 5 verifier measured 1.12-2.1x cap overspend when Redis died with Redis-only holds.
  Src: founder chose "Hard cap: holds in Postgres too" in chat · Code: packages/gateway/src/budget/
- **D-025** 2026-11-09 · founder · active — PR 5 merges after one last pass that shrinks the failover window (epoch checked every ~250 ms) plus the review's leak/deadline fixes; the remaining small overshoot during gateway failover disagreement is measured, documented and owned by PR 12 (R6). Why: after two fix rounds the cap held in 11 of 13 outage runs and the 2 breaches were 1-2% of the cap, with accounting always exact.
  Src: founder chose "Shrink window, merge" in chat · Code: packages/gateway/src/budget/budget.ts
- **D-023** 2026-11-09 · loop default · active — If neither Redis nor Postgres can decide a budget reservation, the request is refused with 503 budget_unavailable (fail closed), and requests refused for budget hand back their rate-limit tokens. Why: D-018 keeps spend capped; with both stores down there is no safe way to admit a paid call.
  Src: .product/plans/pr-5.md "Notes from the build" · Code: packages/gateway/src/budget/budget.ts
- **D-026** 2026-11-09 · loop default · active — When a provider answers 401 or 403 to the gateway's own key, the client gets 502 `provider_auth_failed` with a generic message ("the gateway's credentials for <provider> were rejected"); the provider's real status and message are logged server-side only. Replaces "provider status kept" for 401/403 only. Why: the caller did nothing wrong and cannot fix the gateway's key; a pass-through 401 reads as "your key is bad" and leaks the provider's wording.
  Src: PR 6 fix pass 1 brief · Code: packages/gateway/src/routes/chat.ts

## Data, privacy & legal
- **D-011** 2026-11-09 · founder · active — API keys are stored only as HMAC-SHA256(server pepper, key) via Node's built-in crypto, never plaintext and not bcrypt/argon2. Why: keys are 256-bit random, so slow hashing adds per-request latency for no security gain.
  Src: .product/plans/pr-3.md; founder chose it in chat · Code: packages/gateway/src/auth/keys.ts

## AI & models

## Integrations & providers
- **D-020** 2026-11-09 · founder · active — The third provider is Google Gemini, alongside Anthropic and OpenAI. Why: a genuinely different API that proves the adapter design.
  Src: .product/plans/pr-6.md; founder chose "Google Gemini"
- **D-021** 2026-11-09 · founder · active — Providers are called with plain HTTP over the gateway's own undici pools; no provider SDKs. Why: one place for timeouts, streaming and measurement; no extra dependencies.
  Src: founder chose "Plain HTTP" · Code: packages/gateway/src/providers/
- **D-022** 2026-11-09 · founder · active — One live smoke call per provider, run by hand with the founder's API keys, never in the gate or CI. Why: proves the adapters against real APIs, not only fixtures.
  Src: founder chose "Yes, I'll add keys" · Code: scripts/smoke-providers.ts

## UX & copy

## Architecture & stack
- **D-012** 2026-11-09 · founder · active — Revoked API keys stop working instantly: valid keys are cached in Redis and revocation writes a tombstone (fills use SET NX). Why: founder picked instant revocation over a 30 s in-memory cache.
  Src: .product/plans/pr-3.md; founder chose "Instantly, via Redis" in chat · Code: packages/gateway/src/auth/key-store.ts
- **D-013** 2026-11-09 · founder · active — Postgres access is through Drizzle ORM on node-postgres, migrations generated by drizzle-kit. Why: founder chose Drizzle over plain SQL.
  Src: founder chose "Drizzle ORM" in chat · Code: packages/gateway/src/db/
- **D-014** 2026-11-09 · founder · active — Auth.js is not used for gateway auth (machine API keys, not human login); it is a candidate for dashboard login in PR 11. Why: Auth.js has no per-request API-key check.
  Src: chat 2026-11-09, founder asked about Auth.js and accepted
- **D-015** 2026-11-09 · founder · active — The rate limiter enforces both requests per minute and tokens per minute per key, in one atomic Lua script; tokens are charged an estimate before the call and corrected to actual usage after. Why: founder chose "Requests + tokens" over requests only.
  Src: .product/plans/pr-4.md · Code: packages/gateway/src/ratelimit/
- **D-016** 2026-11-09 · founder · active — If Redis is unavailable the rate limiter fails open (requests served, limits off, one warning per outage). Why: availability over strict limits; budgets still cap spend.
  Src: founder chose "Fail open" in chat · Code: packages/gateway/src/ratelimit/limiter.ts
- **D-002** 2026-11-08 · founder · active — Gateway HTTP framework is Fastify (not Express or Hono), to be backed by a raw node:http vs Express 5 vs Fastify k6 comparison in docs/decisions/0001-framework.md. Why: framework cost lands in the measured overhead and req/s ceiling.
  Src: founder in chat: "lets go with fastify then." · Code: packages/gateway/package.json

## Loop & process
- **D-003** 2026-11-08 · founder · superseded by D-007 — The rate limiter (Redis Lua token bucket) and circuit breaker are written by the founder by hand; agents write only interfaces, wiring and failing tests for them. Why: every line must be explainable in an interview.
  Src: LLM_Gateway_Brief.pdf, Traps to avoid
- **D-004** 2026-11-08 · founder · active — plan_gate is human: every PR plan is approved by the founder before a build. Why: founder in chat: "i want to plan this myself with you".
  Src: /product init answer · Code: .product/config.md plan_gate
- **D-005** 2026-11-08 · founder · active — merge_policy is merge-when-green to local main; never push. Why: chosen over branch-only at init.
  Src: /product init answer · Code: .product/config.md merge_policy
- **D-006** 2026-11-08 · founder · active — main is the default branch and is published as the public GitHub repo jadd0/llm-gateway; the founder pushes or asks for a push, the loop still never pushes on its own. The brief PDF stays out of git. Why: the repo is the public proof for the CV.
  Src: founder in chat: "make main the main git branch and set up a public github repo for it" · Code: .gitignore
- **D-007** 2026-11-08 · founder · active — Agents write all the code, including the rate limiter and circuit breaker; each PR ships a plain-language explanation the founder can defend in an interview. Why: founder in chat: "im not writing any code, no point."
  Src: chat 2026-11-08 · Code: none
- **D-008** 2026-11-09 · founder · active — Tests sit beside the code they test as `<file>.test.ts`; no `test/` folders. Why: founder in chat: "tests should be in the smae folders as code."
  Src: chat 2026-11-09 · Code: vitest.config.ts include
- **D-009** 2026-11-09 · founder · active — Docs are organised as one folder per part (`docs/<part>/`), each with a plain-English README and an archify diagram explaining that part; this replaces per-PR explainers and a separate decisions folder. Why: founder in chat: "docs should be organised as folders in docs. ie docs/interpreter. each part should have an archify diagram explaining".
  Src: chat 2026-11-09 · Code: docs/README.md
- **D-010** 2026-11-09 · founder · active — The PR 2 framework comparison runs each contender as one process (no cluster) and compares only node:http, Express 5 and Fastify (no Hono). Why: one process is the like-for-like per-core test and leaves cores for k6 and the mock.
  Src: .product/plans/pr-2.md; founder chose both recommended options in chat · Code: bench/frameworks/
