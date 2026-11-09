# PR 4 — Distributed rate limiter (Redis Lua token bucket)

**CONCERN:** after PR 3 every caller is identified but unlimited; one key can flood the gateway
or the provider, and a per-process counter would multiply the limit by the number of instances.

**ACCEPTANCE:** per-key token buckets for requests per minute and tokens per minute, enforced together by one atomic Lua script in Redis; a test firing 1,000 concurrent requests at a key limited to 100 requests/min admits exactly 100 and returns 429 with Retry-After to the rest, including when the requests are spread across 3 gateway app instances sharing one Redis; the token bucket is charged an estimate before the call and corrected to actual usage after (streamed and non-streamed); refill verified over time; Redis unavailable fails open; docs/rate-limiter/ walks the script line by line.

**SCOPE GUARD:** rate limits only. No spend caps (PR 5), no retries/fallback (PR 7). The
3-instance nginx proof under real load is PR 12; here instances are in-process. No admin UI:
limits are set by the PR 3 CLI.

**BASE:** main after PR 3 merges (needs `api_keys`, `key-store`, the auth plugin); branch
`pr-4-rate-limiter` (worktree `.claude/worktrees/pr-4-rate-limiter`); stacked on none;
migration: next free number at generate time. Residuals owned by this PR: none.

## Files
| path | change |
|---|---|
| `packages/gateway/src/db/schema.ts` | `api_keys`: add `rpm_limit`, `tpm_limit` |
| `packages/gateway/drizzle/0001_ambiguous_legion.sql`, `packages/gateway/drizzle/meta/0001_snapshot.json`, `packages/gateway/drizzle/meta/_journal.json` | generated migration |
| `packages/gateway/src/auth/plugin.test.ts` | the caller now carries `keyId` and limits |
| `packages/gateway/src/usage/estimate.ts` | **new**. Pre-call token estimate (shared with PR 5) |
| `packages/gateway/src/usage/estimate.test.ts` | **new** |
| `packages/gateway/src/usage/sse-usage.ts` | **new**. Pass-through stream tap that extracts `usage` from the final SSE chunk without buffering |
| `packages/gateway/src/usage/sse-usage.test.ts` | **new** |
| `packages/gateway/src/ratelimit/token-bucket.lua` | **new**. The script (see Invariants) |
| `packages/gateway/src/ratelimit/token-bucket-adjust.lua` | **new**. The reconcile script (adds or subtracts, capped at capacity) |
| `packages/gateway/src/request-body.ts` | **new**. Parses the JSON body once per request, shared by the limiter and the route |
| `packages/gateway/src/redis.ts` | `createRedis` takes `commandTimeoutMs` so the limiter's own timeout governs |
| `packages/gateway/src/test-env.ts` | `seedKey` takes per-key limits |
| `packages/gateway/src/ratelimit/limiter.ts` | **new**. Loads the script (ioredis `defineCommand`), `take()`, `adjust()`, fail-open handling |
| `packages/gateway/src/ratelimit/limiter.test.ts` | **new** |
| `packages/gateway/src/ratelimit/plugin.ts` | **new**. Fastify `preHandler` after auth: take, set headers, 429/400; hands the route a `settle()` that the route calls once it knows the usage (an `onResponse` hook does not run for hijacked streams) |
| `packages/gateway/src/ratelimit/plugin.test.ts` | **new** |
| `packages/gateway/src/auth/key-store.ts` | cached key value carries `keyId`, `rpmLimit`, `tpmLimit`; `setLimits` overwrites the cache entry |
| `packages/gateway/src/auth/key-store.test.ts` | limits in cache; limit change visible on next request |
| `packages/gateway/src/routes/chat.ts` | non-streamed: read `usage` from the body as it passes; streamed: inject `stream_options.include_usage=true` upstream and pipe through `sse-usage` tap; hand actual usage to the reconcile hook |
| `packages/gateway/src/routes/chat.test.ts` | usage reaches reconcile in both modes; stream still unbuffered with the tap |
| `packages/gateway/src/cli/keys.ts` | `create-key --rpm --tpm`; `set-limits <prefix> --rpm --tpm` |
| `packages/gateway/src/cli/keys.test.ts` | set-limits test |
| `packages/gateway/src/config.ts` | new rows (Decisions) |
| `packages/gateway/src/app.ts` | register ratelimit plugin after auth |
| `.env.example` | new rows |
| `bench/k6/burst.js` | **new**. 1,000 requests at once at a 100 rpm key; counts 200 vs 429 |
| `bench/run-ratelimit.sh` | **new**. Overhead run (limits high, nothing rejected) vs PR 3 auth-on; burst correctness run |
| `bench/results/pr-4/*.json` | **new** |
| `BENCHMARKS.md` | "Rate limiting (PR 4)" section |
| `docs/rate-limiter/README.md` | **new**. Plain English + the Lua script annotated line by line + interview Qs |
| `docs/gateway/chat-passthrough.html`, `docs/auth/api-key-check.html` | labels updated for the rate-limit step and limits on the cached key |
| `docs/rate-limiter/token-bucket.html` | **new**. Archify diagram: request → Lua (both buckets) → allow/deny → reconcile |
| `docs/README.md`, `docs/architecture/README.md`, `docs/architecture/architecture.html`, `docs/gateway/README.md`, `docs/auth/README.md` | rate limiter built; request path updated |
| `docs/diagrams/flows.md` | add the flow line below |

## Schema

```sql
alter table api_keys add column rpm_limit integer;   -- null = RATE_LIMIT_DEFAULT_RPM
alter table api_keys add column tpm_limit integer;   -- null = RATE_LIMIT_DEFAULT_TPM
```

## Invariants

- **One script, both buckets, all or nothing.** `token-bucket.lua` gets
  `KEYS = rl:{<keyId>}:req, rl:{<keyId>}:tok` (hash-tagged so both live on one Redis Cluster
  slot) and `ARGV = rpm, tpm, tokenCost`. It:
  1. reads `now` from Redis `TIME` (never a gateway clock, so instances can't disagree);
  2. for each bucket, loads `{tokens, ts}` (missing = full), refills
     `min(capacity, tokens + elapsed × capacity/60s)`;
  3. if `req ≥ 1` **and** `tok ≥ tokenCost`, deducts both and returns allowed + remaining;
     otherwise deducts **neither** and returns denied + ms until the short bucket has enough;
  4. writes both back with `PEXPIRE` = time to refill from empty (idle keys vanish).
  Capacity = the per-minute limit (a full minute's burst); refill = limit/60 per second.
- **Request too large:** `tokenCost > tpm` can never pass → 400
  `{error:{type:"invalid_request_error",code:"request_too_large"}}`, no bucket touched.
- **Estimate:** `tokenCost = ceil(promptChars / 4) + (max_tokens ?? max_completion_tokens ?? RATE_LIMIT_DEFAULT_MAX_TOKENS)`.
  The same function is reused by PR 5. (Same principle OpenAI uses: prompt + requested output.)
- **Reconcile:** after the response, `adjust(tok, estimate − actualTotal)` with a tiny second
  script that adds (refund) or subtracts (debit; may go negative, so later requests wait) and
  caps at capacity. Actual usage: non-streamed from the response body's `usage`; streamed from
  the final chunk via `sse-usage` (the gateway sets `stream_options.include_usage=true`). No
  usage seen (client aborted, upstream error) → keep the estimate charged. A denied request is
  never reconciled.
- **Streaming stays unbuffered:** the tap forwards each chunk the moment it arrives and only
  inspects lines starting `data: {` for a `usage` field; PR 1's unbuffered test must still pass.
- **Fail open:** Redis error or no reply within `RATE_LIMIT_REDIS_TIMEOUT_MS` → allow, no
  ratelimit headers, one warn log per outage (not per request), resume on recovery.
- **Headers** (OpenAI's names) on every limited response: `x-ratelimit-limit-requests`,
  `x-ratelimit-remaining-requests`, `x-ratelimit-reset-requests`, and the `-tokens` trio.
  429 adds `retry-after` (whole seconds, rounded up) and body
  `{error:{type:"rate_limit_exceeded",code:"rate_limit_exceeded",message:"…requests|tokens…"}}`.
- **Limit changes take effect on the next request:** `set-limits` writes Postgres, then
  overwrites the key's cache entry (no NX), the same race-proof order as PR 3's revoke.
- Order in the request path: auth → rate limit → route.

## Tests

`ratelimit/limiter.test.ts` (real Redis):
- `1000 concurrent takes at 100 rpm admit exactly 100`
- `1000 concurrent requests across 3 in-process gateway apps sharing Redis admit exactly 100`
- `bucket refills at limit/60 per second` (rpm 60: drain, wait 1.1 s, exactly 1 more passes)
- `denied by the token bucket consumes no request token` (and vice versa)
- `refund after a smaller actual usage restores tokens, capped at capacity`
- `debit after a larger actual usage drives the bucket negative and delays later requests`
- `retry-after equals the time until the short bucket can serve the request`
- `Redis down fails open and logs once`
- `idle bucket keys expire`

`ratelimit/plugin.test.ts`:
- `429 carries retry-after, ratelimit headers and an OpenAI-shaped body`
- `request whose estimate exceeds tpm gets 400 request_too_large and touches no bucket`
- `limit change via set-limits applies to the next request`

`usage/estimate.test.ts`: `estimate = prompt chars/4 + max_tokens, falling back to the default`
`usage/sse-usage.test.ts`: `extracts usage from the final chunk; bytes out equal bytes in; chunks forwarded immediately`
`routes/chat.test.ts`: `streamed and non-streamed responses report actual usage to reconcile`

## Acceptance proof

1. `npm run db:migrate`; `npm run keys -- create-key acme --rpm 100 --tpm 50000`.
2. `bash scripts/gate.sh` → PASS (limiter tests are the exactness proof).
3. `bash bench/run-ratelimit.sh` → burst run: `bench/results/pr-4/burst.json` shows 100 × 200
   and 900 × 429; overhead run vs `bench/results/pr-3/` recorded in BENCHMARKS.md.
4. curl 101 requests quickly → 101st returns 429 with `retry-after` (hop: `ratelimit/plugin.ts`
   → `limiter.ts` → `token-bucket.lua`).

## Adversarial

1. Two buckets, one denied: hammer a key whose tpm runs out before rpm; request count consumed
   equals requests admitted, exactly.
2. Clock skew: run two gateway processes with one clock shifted (libfaketime or a test seam
   that offsets `Date.now`); admissions still exact because only Redis `TIME` is used.
3. Kill Redis mid-burst: requests keep flowing (fail open), no crash; restart Redis and limits
   apply again within one request.
4. Client aborts 200 streams mid-way: each keeps its estimate charged; none refunded twice.
5. Every figure in BENCHMARKS.md and docs/rate-limiter traces to `bench/results/pr-4/` (R3).

## Data flows

- Rate limit check and usage reconcile → `docs/rate-limiter/token-bucket.html` → `packages/gateway/src/{ratelimit/*.ts,ratelimit/token-bucket.lua,usage/*.ts}`

## Decisions

- **Requests and tokens per minute** (founder, D-015), both in one atomic script.
- **Fail open when Redis is down** (founder, D-016): availability over strict limits; spend is
  still capped by PR 5.
- **Token bucket** per the brief (D-001): bursts allowed up to one minute's limit, average capped.
- **Token estimate is a chars/4 heuristic, not a tokenizer:** it is corrected after every call,
  so precision only matters within one request; a tokenizer per request costs CPU on the hot
  path. Revisit in PR 12 if the error is large (the explainer states the measured error from
  the mock's usage vs the estimate).
- **Redis time, hash-tagged keys, idle expiry**: as in Invariants; each is an interview answer.
- **Auth lookup and rate limit stay two Redis round trips** for now; merging them into one
  script is a PR 12 optimisation if Redis round trips show up as the bottleneck.
- **Config rows:** `RATE_LIMIT_DEFAULT_RPM=600`, `RATE_LIMIT_DEFAULT_TPM=200000`,
  `RATE_LIMIT_DEFAULT_MAX_TOKENS=1024`, `RATE_LIMIT_REDIS_TIMEOUT_MS=50`,
  `RATE_LIMIT_ENABLED=true` (false only for benchmarks isolating other parts).
- **Docs** (R2 + D-007): `docs/rate-limiter/README.md` annotates every line of
  `token-bucket.lua`; interview Qs: why atomic, why Lua not MULTI/WATCH, why Redis time, why
  token bucket vs sliding window, what fail-open risks, how tokens are estimated and corrected.
  Before merge the founder is walked through the script and quizzed (in chat, not a file).
