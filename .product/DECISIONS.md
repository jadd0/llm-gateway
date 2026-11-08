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

## Data, privacy & legal

## AI & models

## Integrations & providers

## UX & copy

## Architecture & stack
- **D-002** 2026-11-08 · founder · active — Gateway HTTP framework is Fastify (not Express or Hono), to be backed by a raw node:http vs Express 5 vs Fastify k6 comparison in docs/decisions/0001-framework.md. Why: framework cost lands in the measured overhead and req/s ceiling.
  Src: founder in chat: "lets go with fastify then." · Code: packages/gateway/package.json

## Loop & process
- **D-003** 2026-11-08 · founder · active — The rate limiter (Redis Lua token bucket) and circuit breaker are written by the founder by hand; agents write only interfaces, wiring and failing tests for them. Why: every line must be explainable in an interview.
  Src: LLM_Gateway_Brief.pdf, Traps to avoid
- **D-004** 2026-11-08 · founder · active — plan_gate is human: every PR plan is approved by the founder before a build. Why: founder in chat: "i want to plan this myself with you".
  Src: /product init answer · Code: .product/config.md plan_gate
- **D-005** 2026-11-08 · founder · active — merge_policy is merge-when-green to local main; never push. Why: chosen over branch-only at init.
  Src: /product init answer · Code: .product/config.md merge_policy
- **D-006** 2026-11-08 · founder · active — main is the default branch and is published as the public GitHub repo jadd0/llm-gateway; the founder pushes or asks for a push, the loop still never pushes on its own. The brief PDF stays out of git. Why: the repo is the public proof for the CV.
  Src: founder in chat: "make main the main git branch and set up a public github repo for it" · Code: .gitignore
