<!-- product-kit RESIDUALS.md v1 — from umbo 0f95e4fa -->
# Residuals — known gaps, deliberately deferred, each with an owner

A residual is a gap we **found and understood** and chose not to close in the PR that found it.
It is not a TODO and not a bug backlog: every row names the PR that must close it, and that PR's
plan is not approved at its gate until every row pointing at it is closed or re-argued here.

A gap that lives only in a code comment is a gap that ships. That is what this file prevents.

New rows go in the open table, **above** "Closing a residual". Ids are `R<n>`, never reused.

| # | Gap | Found in | Owner | Why it was not closed there |
|---|-----|----------|-------|------------------------------|
| R1 | `OPENAI_BASE_URL` path is discarded: the pool uses the origin and the path is fixed at `/v1/chat/completions`, so a base URL with a path prefix (e.g. OpenRouter `/api/v1`) 404s | PR 1 review (`packages/gateway/src/upstream.ts:28`) | PR 6 | Provider adapters own upstream URL construction; PR 1 has one upstream, the mock |
| R2 | One `UPSTREAM_TIMEOUT_MS` sets connect, headers and body timeouts together; a slow non-streamed real-provider completion (> 30 s to headers) gets a 504, and connect failures wait the full 30 s | PR 1 review (`packages/gateway/src/upstream.ts:19`) | PR 7 | Timeouts per attempt and per phase are PR 7's concern; PR 1 runs only against the mock |
| R3 | Every request body is JSON-parsed and zod-validated on the hot path although the original bytes are forwarded; costs event-loop CPU on large bodies | PR 1 review (`packages/gateway/src/routes/chat.ts:58`) | PR 12 | Later PRs need the parsed body (model routing, token estimate, cache key); whether to parse lazily is decided with PR 12's load numbers |
| R4 | Throughput p95 jumps from ~2.6 ms to 99 ms at the 12000 req/s step; cause not established (event loop, pool, or CPU contention with k6 on one machine) and each step ran once | PR 1 benchmark (`bench/results/pr-1/step-gateway-12000.json`) | PR 12 | Finding the breaking point and its cause is PR 12's acceptance |
| R5 | Stream-end attribution in `routes/chat.ts` (~line 79) is order-sensitive: under load a client abort can fail the write before 'close' fires and be logged as an upstream failure; the client-abort test waits a fixed 300 ms with no positive signal that the abort was seen. Better: decide from the request socket's close/destroyed state in one place | PR 1 review of fix diff (a5382f0..4a99569) | PR 10 | Affects warn-log accuracy only, not responses; PR 10 owns request logging and outcome classification |

## Closing a residual

Move the row to Closed in the PR that closes it, in the same commit as the code, adding the
closing PR and commit, and say so in that PR's NOTES. A residual removed without a commit that
closes it is a regression. Never add an open row below this heading.

## Closed

| # | Gap | Closed by | Commit |
|---|-----|-----------|--------|
