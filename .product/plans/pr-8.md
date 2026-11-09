# PR 8 — Exact-match cache

**CONCERN:** apps send the same deterministic request again and again (evals, retries, shared
prompts); every repeat costs a full provider call in money and seconds.

**ACCEPTANCE:** non-streamed and streamed responses cached in Redis keyed on a normalised request hash; per-request opt-out header; k6 cold vs warm runs record hit rate and latency.

**SCOPE GUARD:** exact match only (near-duplicates are PR 9). Only deterministic requests
(`temperature: 0`) are cacheable unless configured otherwise. No caching of tool calls, `n > 1`,
error replies or truncated streams. No cache admin UI; one CLI command for the sharing flag.

**BASE:** main after PR 7 merges (PR 7 rewrites `routes/chat.ts` into an attempt loop; merge main
in before building); branch `pr-8-cache` (worktree `.claude/worktrees/pr-8-cache`); stacked on
none; **migration: one** (next free number at generate time). Residuals owned: none.

## Files
| path | change |
|---|---|
| `packages/gateway/src/cache/key.ts` | **new**. `normalise(body)` → canonical object; `cacheKey(scope, normalised)` → `{prefix}cache:v1:{scope}:{sha256}`; `isCacheable(body, config)` → `{ok} \| {reason}` |
| `packages/gateway/src/cache/store.ts` | **new**. Redis get/set with timeout and size cap, fail-open |
| `packages/gateway/src/cache/single-flight.ts` | **new**. In-process promise map + Redis lock (`SET NX PX`) + pub/sub notify for followers in other processes |
| `packages/gateway/src/cache/replay.ts` | **new**. Stored completion → non-streamed body, or → OpenAI SSE chunks ending in `[DONE]` |
| `packages/gateway/src/cache/collect.ts` | **new**. Assembles a completion from a streamed reply as it passes (no buffering of the client stream) |
| `packages/gateway/src/cache/plugin.ts` | **new**. preHandler between rate limit and budget: lookup, single-flight wait, serve hit; fills on success |
| `packages/gateway/src/cache/*.test.ts` | **new**. Beside each file above |
| `packages/gateway/src/routes/chat.ts`, `routes/chat-cache.test.ts` (**new**) | fill hook after a served 2xx; `x-gateway-cache` header on every reply |
| `packages/gateway/src/budget/plugin.ts`, `budget/budget.ts`, `budget/pg-ledger.ts` | a hit writes a zero-cost ledger row with `cached`, `saved_micros`; no hold |
| `packages/gateway/src/ratelimit/plugin.ts` | a hit refunds the token estimate (request still counts) |
| `packages/gateway/src/db/schema.ts`, `drizzle/<next>_*.sql`, `drizzle/meta/*` | `tenants.cache_shared`, `spend_ledger.cached`, `spend_ledger.saved_micros` |
| `packages/gateway/src/auth/*` | key-cache record carries `cacheShared` |
| `packages/gateway/src/cli/keys.ts`, `cli/keys.test.ts` | `set-cache-sharing <tenant> on\|off` (refreshes key cache like `set-budget`); `show-spend` prints hits and saved |
| `packages/gateway/src/app.ts`, `config.ts`, `config.test.ts`, `.env.example` | rows in Decisions |
| `bench/k6/cache.js`, `bench/run-cache.sh` | **new**. Cold, warm and stampede scenarios |
| `bench/cache-summary.ts`, `bench/cache-summary.test.ts` | **new**. `bench/results/pr-8/summary.md` from k6 JSON only |
| `bench/results/pr-8/*` | **new** (full run by the orchestrator, R4) |
| `package.json` | script `bench:cache` |
| `BENCHMARKS.md` | "Exact-match cache (PR 8)" section |
| `docs/cache/README.md` | **new**. Key normalisation, what is cacheable, isolation and sharing, single-flight, streamed replay, billing, numbers, interview Qs |
| `docs/cache/cache-flow.html` | **new**. Archify flow: request → cacheable? → lookup → hit replay / single-flight / miss → fill |
| `docs/README.md`, `docs/architecture/*`, `docs/gateway/README.md`, `docs/budgets/README.md`, `docs/rate-limiter/README.md` | cache built; request path updated |
| `docs/diagrams/flows.md` | register the cache flow |
| `.product/DECISIONS.md` | D-032–D-035 |

## Schema

```sql
ALTER TABLE tenants ADD COLUMN cache_shared boolean NOT NULL DEFAULT false;
ALTER TABLE spend_ledger ADD COLUMN cached boolean NOT NULL DEFAULT false;
ALTER TABLE spend_ledger ADD COLUMN saved_micros bigint NOT NULL DEFAULT 0;
```

## Invariants

- **Request order:** auth → rate limit → **cache** → budget → route → settle. A hit never reaches
  budget or the provider.
- **Scope** (D-032): key scope is the tenant id; a tenant with `cache_shared = true` reads and
  writes scope `shared` only. A private tenant never reads `shared` and a shared tenant never
  reads a private scope. The scope is part of the hashed key, never a lookup-time filter.
- **Cacheable** only when all hold: `temperature === 0` (explicit; absent is the provider's
  default, not 0) unless `CACHE_ALLOW_NONDETERMINISTIC=true`; `n` absent or 1; no `tools`,
  `tool_choice`, `functions`; no `cache-control: no-store` / `no-cache` on the request; the model
  routes. Otherwise `x-gateway-cache: uncacheable` (or `bypass` for the header) and the request
  proceeds untouched.
- **Normalised key** (sha256 of canonical JSON, keys sorted): requested `model` (not the serving
  one); `messages` with role, `name`, and content normalised so a string and a single
  `[{type:"text",text}]` part are the same; `temperature`, `top_p`, `seed`, `stop` (string → one-
  element array), effective max tokens (`max_completion_tokens ?? max_tokens ?? default`),
  `presence_penalty`/`frequency_penalty` with 0 dropped, `response_format`. Excluded: `stream`,
  `stream_options`, `user`, `metadata`, `service_tier`, `store`. A stream and a non-stream of the
  same request share one entry. The key version `v1` changes whenever normalisation does.
- **Stored only** after a 2xx with `finish_reason` `stop` or `length` and a complete body
  (streams: `[DONE]` seen, no error event, client still connected not required). Entry: the
  completion's message content, finish reason, usage, serving model; ≤ `CACHE_MAX_ENTRY_BYTES`.
  TTL `CACHE_TTL_S`.
- **Opt-out** (per request): `cache-control: no-store` → don't read, don't write;
  `cache-control: no-cache` → don't read, do write (refresh).
- **Hit replay:** non-streamed → `chat.completion` with a fresh `id` (`chatcmpl-cache-…`),
  `created` now, stored content/usage/model. Streamed → role chunk, content in
  `CACHE_REPLAY_CHUNK_CHARS` pieces, finish chunk, usage chunk if `include_usage`, `[DONE]`,
  written immediately. Headers `x-gateway-cache: hit`, `x-gateway-model` = stored serving model,
  `x-gateway-attempts: 0`.
- **Billing** (D-033): a hit charges $0; the ledger gets one row (`cached = true`,
  `cost_micros = 0`, `saved_micros` = stored usage priced at the stored serving model, tokens
  from stored usage). Rate limit: the request counts against rpm; the token estimate is refunded
  in full (no provider tokens used).
- **Single-flight** (D-034), non-streamed requests only: the first miss for a key takes a lock
  (in-process map, then Redis `SET NX PX CACHE_LOCK_MS`); other identical requests, in this or
  another process, wait up to `CACHE_WAIT_MS` for the fill (pub/sub on the key, plus one re-read
  at timeout) and are served as hits. If the leader fails or times out, the lock is released and
  waiters go upstream on their own (no shared failure). Streamed misses never wait and never lead.
- **Redis down or slow** (> `CACHE_REDIS_TIMEOUT_MS`): cache is skipped (`x-gateway-cache:
  unavailable`), the request proceeds; never fails a request.
- **Never cached:** error replies, mid-stream errors, `content_filter`, replies over the size cap,
  anything with tool calls in the response.

## Tests

`cache/key.test.ts`: `string and single text part give the same key`; `field order does not change
the key`; `stream flag does not change the key`; `user and metadata do not change the key`;
`different tenants get different keys; shared tenants share one`; `temperature absent is
uncacheable; 0 is cacheable; config can allow others`; `tools and n>1 are uncacheable`.
`cache/replay.test.ts`: `stored completion replays as a non-streamed body`; `replays as SSE chunks
ending in [DONE] with usage only when asked`; `Arabic and emoji survive replay chunking`.
`cache/collect.test.ts`: `assembles content from OpenAI, Anthropic and Gemini translated streams`;
`error event or missing [DONE] means nothing is stored`.
`cache/single-flight.test.ts` (real Redis): `50 concurrent identical misses make one upstream
call`; `waiters across two plugin instances are served from the leader`; `leader failure lets
waiters go upstream`; `wait timeout falls through to upstream`.
`cache/store.test.ts`: `entry over the size cap is not stored`; `redis down is a miss, not an
error`.
`routes/chat-cache.test.ts`: `second identical request is a hit with no upstream call`;
`streamed request hits an entry made by a non-streamed one`; `no-store bypasses read and write`;
`no-cache refreshes`; `private tenant never sees another tenant's entry`; `shared tenants share,
private tenants do not see shared`; `hit writes a zero-cost ledger row with saved_micros`;
`hit refunds the token estimate and counts one request`; `budget-exhausted tenant is still served
a hit`; `error reply is not cached`; `x-gateway-cache header on hit, miss, bypass, uncacheable`.
`cli/keys.test.ts`: `set-cache-sharing toggles the flag and refreshes the key cache`.

## Acceptance proof

1. `bash scripts/gate.sh` → PASS.
2. By hand: same `temperature:0` request twice → `x-gateway-cache: miss` then `hit`, mock request
   count +1 only; streamed repeat → `hit` SSE; with `cache-control: no-store` → `bypass`; second
   tenant → `miss`. Hops: `cache/plugin.ts` → `key.ts` → `store.ts` → `replay.ts`;
   fill: `routes/chat.ts` → `collect.ts` → `store.ts`.
3. `bash bench/quiet.sh bench/results/pr-8 && bash bench/run-cache.sh` (orchestrator): cold (all
   unique), warm (repeats from a fixed prompt set, measured hit rate), stampede (50 identical at
   once → upstream calls counted); p50/p95 hit vs miss with mock latency on.

## Adversarial

1. Tenant A and B send byte-identical requests: B is a miss; A's entry is unreadable to B by
   any header or field combination.
2. Two requests differing only in `temperature` 0 vs 0.0, `"stop":"x"` vs `["x"]`, key order:
   same key. Differing in one character of content: different key.
3. Kill the gateway mid-fill and mid-stream: no partial entry is ever served.
4. Redis paused during a stampede: every request still completes (upstream), none hangs past
   `CACHE_REDIS_TIMEOUT_MS` + normal latency.
5. Leader request gets a 500: waiters do not all get the 500; each goes upstream itself.
6. Budget ledger after 10 hits: sum of `cost_micros` unchanged, `saved_micros` = 10 × cost.
7. Every figure in BENCHMARKS.md and docs/cache traces to `bench/results/pr-8/` (R3).

## Data flows

- Exact-match cache lookup, single-flight and fill → `docs/cache/cache-flow.html` → `packages/gateway/src/{cache/*.ts,routes/chat.ts}`
- Spend ledger (hit rows) → existing `docs/budgets/budget-flow.html` (updated) → `packages/gateway/src/budget/*.ts`

## Decisions

- **D-032 Cache is per tenant; tenants can opt in to a shared pool** (founder):
  `tenants.cache_shared`, default off, set with `set-cache-sharing`. Shared tenants only read and
  write the shared pool.
- **D-033 A hit costs the tenant nothing**; the ledger records the saving (founder).
- **D-034 Single-flight for identical non-streamed misses** (founder); streamed misses each go
  upstream.
- **D-035 A hit counts one request against rpm and refunds the token estimate** (loop default:
  rpm protects the gateway, tpm protects the provider quota a hit doesn't touch).
- **Hits are served even to a budget-exhausted tenant** (follows from D-033: no spend).
- **Config rows:** `CACHE_ENABLED=true`, `CACHE_TTL_S=3600`, `CACHE_MAX_ENTRY_BYTES=262144`,
  `CACHE_ALLOW_NONDETERMINISTIC=false`, `CACHE_LOCK_MS=30000`, `CACHE_WAIT_MS=10000`,
  `CACHE_REDIS_TIMEOUT_MS=50`, `CACHE_REPLAY_CHUNK_CHARS=64`.
- **Redis memory:** entries rely on TTL; docs say to run Redis with `maxmemory-policy
  volatile-lru` so cache entries are evicted before keys without TTL (budgets, breaker).
- **Bench:** 2 000 distinct prompts; warm phase draws from 200 of them (Zipf s=1.1) so the hit
  rate is measured, not assumed; mock latency on (realistic). Builders smoke only (R4).
- **Docs** (R2): interview Qs incl. "why is temperature 0 the default rule?", "why include the
  tenant in the key instead of checking it after?", "how does single-flight work across
  processes?", "why not cache streamed replies as raw SSE?", "what happens when Redis fills up?".
