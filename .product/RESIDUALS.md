<!-- product-kit RESIDUALS.md v1 — from umbo 0f95e4fa -->
# Residuals — known gaps, deliberately deferred, each with an owner

A residual is a gap we **found and understood** and chose not to close in the PR that found it.
It is not a TODO and not a bug backlog: every row names the PR that must close it, and that PR's
plan is not approved at its gate until every row pointing at it is closed or re-argued here.

A gap that lives only in a code comment is a gap that ships. That is what this file prevents.

New rows go in the open table, **above** "Closing a residual". Ids are `R<n>`, never reused.

| # | Gap | Found in | Owner | Why it was not closed there |
|---|-----|----------|-------|------------------------------|
| R2 | One `UPSTREAM_TIMEOUT_MS` sets connect, headers and body timeouts together; a slow non-streamed real-provider completion (> 30 s to headers) gets a 504, and connect failures wait the full 30 s | PR 1 review (`packages/gateway/src/upstream.ts:19`) | PR 7 | Timeouts per attempt and per phase are PR 7's concern; PR 1 runs only against the mock |
| R3 | Every request body is JSON-parsed and zod-validated on the hot path although the original bytes are forwarded; costs event-loop CPU on large bodies | PR 1 review (`packages/gateway/src/routes/chat.ts:58`) | PR 12 | Later PRs need the parsed body (model routing, token estimate, cache key); whether to parse lazily is decided with PR 12's load numbers |
| R4 | Throughput p95 jumps from ~2.6 ms to 99 ms at the 12000 req/s step; cause not established (event loop, pool, or CPU contention with k6 on one machine) and each step ran once | PR 1 benchmark (`bench/results/pr-1/step-gateway-12000.json`) | PR 12 | Finding the breaking point and its cause is PR 12's acceptance |
| R5 | Stream-end attribution in `routes/chat.ts` (~line 79) is order-sensitive: under load a client abort can fail the write before 'close' fires and be logged as an upstream failure; the client-abort test waits a fixed 300 ms with no positive signal that the abort was seen. Better: decide from the request socket's close/destroyed state in one place | PR 1 review of fix diff (a5382f0..4a99569) | PR 10 | Affects warn-log accuracy only, not responses; PR 10 owns request logging and outcome classification |
| R6 | Budget cap can be exceeded briefly while gateway instances disagree about a Redis failover: an instance still on Redis (or rebuilding from Postgres after a Redis restart) can't see Postgres-path admissions made by other instances until its next epoch check. Measured: 1.92x with Redis-only holds; 1.02x after Postgres holds; 2 of 13 steady-flood outage runs overshot by 1-2% of the cap after the second fix round (bounded by the epoch-check interval, being cut from 5 s to ~250 ms) | PR 5 verify (D-024, D-025) | PR 12 | Closing it fully needs fleet-wide failover coordination; PR 12 measures the remaining bound with 3 real instances and decides |
| R7 | Settled spend is written to Postgres in-process after the response (3 retries, then an error log); a crash between the Redis settle and the Postgres write loses that record | PR 5 plan | PR 10 | The durable queue arrives in PR 10 |
| R8 | Per-PR benchmark figures (PR 2 onwards, and PR 1's throughput sweep) were taken on the founder's laptop while other projects' test suites and a Docker VM shared the CPU (load ~11 on 10 cores seen 2026-11-09); PR 2's ceilings spread 60-233% and PR 3's overhead quadrupled vs PR 1. They are provisional | PR 2/PR 3 builds | PR 12 | PR 12 re-runs the full suite behind `bench/quiet.sh` (or on a dedicated machine) and only its figures go on the CV |
| R9 | No protection against an unauthenticated flood of random well-formed keys: each costs a Postgres query plus a 60 s negative-cache entry in Redis; negative caching only helps repeated bad keys. Needs per-IP (pre-auth) limiting | PR 3 review | PR 12 | Per-IP limiting is outside v1's per-key scope; PR 12's load suite measures the cost and decides |
| R10 | SSE usage tap in strip mode re-concatenates its held buffer per chunk and rescans from the start per event (quadratic up to 1 MiB on large partial events); on overflowing 1 MiB it falls back to the scan path without priming its decoder, so the usage chunk is no longer stripped for that stream | PR 4 review (`packages/gateway/src/usage/sse-usage.ts` ~115-121) | PR 12 | Only matters for very large single events (e.g. big tool-call arguments, out of v1 scope) or under heavy load; PR 12 measures the streaming hot path |
| R11 | After a Redis outage, Redis can keep one orphaned budget hold (one request's estimate, e.g. 3001 µUSD) with no Postgres row until the reservation TTL lapses; seen in 4 of 15 steady-flood outage runs after the phantom-hold fix (was 8 of 13). Safe-side: it only makes the gateway refuse slightly early, never admits extra spend. Old-epoch Redis keys from bumps linger until month-end expiry | PR 5 final verify | PR 12 | Not a cap or accounting risk; PR 12's multi-instance work owns failover state |
| R12 | Real-model prices are the standard (short-context) rates; a prompt past a model's long-context threshold (Claude Haiku 5.5 over 100k tokens, Gemini 3.1 Pro over 200k, GPT-6 Astra over 272k) is billed higher by the provider, so the budget under-charges those calls. Dated model snapshots are not priced until added (a budgeted request for one gets 400 `model_not_priced`) | PR 6 (`packages/gateway/src/pricing/prices.ts`) | PR 12 | Tiered pricing needs the prompt size known at settle time and a larger table; PR 12 decides with real traffic shapes |
| R13 | Translated error replies (Anthropic, Gemini) drop the provider's rate-limit, request-id and `server-timing` headers (as does the 502 `provider_auth_failed` reply, for every format including OpenAI pass-through); only the body is rewritten, so a client cannot see the provider's remaining quota or correlation id | PR 6 review (`packages/gateway/src/routes/chat.ts`) | PR 7 | PR 7 builds the retry/fallback layer that reads those headers and decides what to forward |
| R14 | `upstream.ts` builds six adapter instances (one per provider id) where three would do; the mock variants repeat the real ones | PR 6 review (`packages/gateway/src/upstream.ts`) | PR 12 | Harmless duplication (adapters hold no state beyond the clock); tidy-up with the final hardening pass |
| R15 | `providers/test-support.ts` lives in `src/` and ships with the build, and `server.ts` logs one upstream (`OPENAI_BASE_URL`) at start-up though three providers are configured | PR 6 review | PR 10 | PR 10 owns logging and the build layout; start-up should list every configured provider and test helpers should move out of the shipped tree |
| R16 | Gemini and Anthropic are sent `maxOutputTokens` / `max_tokens` = `DEFAULT_MAX_TOKENS` (1024) when the client names none, which truncates thinking models; revisit the default or set per-model defaults | PR 6 review (`packages/gateway/src/providers/gemini.ts`, `anthropic.ts`) | PR 12 | PR 12 owns the model catalogue and its per-model limits |
| R17 | A path-less `OPENAI_BASE_URL` is refused with no override for root-mounted OpenAI-compatible upstreams, and `testConfig` silently appends `/v1` to a bare one | PR 6 review (`packages/gateway/src/upstream.ts`, `config.ts`) | PR 12 | PR 12 owns provider configuration and can add an explicit override |

## Closing a residual

Move the row to Closed in the PR that closes it, in the same commit as the code, adding the
closing PR and commit, and say so in that PR's NOTES. A residual removed without a commit that
closes it is a regression. Never add an open row below this heading.

## Closed

| # | Gap | Closed by | Commit |
|---|-----|-----------|--------|
| R1 | `OPENAI_BASE_URL` path was discarded (the pool used the origin only), so a base URL with a path prefix 404ed | PR 6: `upstream.ts` keeps the base URL path and joins it in front of the adapter's path; tested in `routes/chat-providers.test.ts` | 3e12156 |
