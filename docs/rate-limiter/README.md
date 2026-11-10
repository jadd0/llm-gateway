# Rate limiter

Diagram: [token-bucket.html](token-bucket.html). Code: `packages/gateway/src/ratelimit/` (`token-bucket.lua`,
`token-bucket-adjust.lua`, `limiter.ts`, `plugin.ts`) and `packages/gateway/src/usage/` (`estimate.ts`, `sse-usage.ts`).

Every API key has two limits per minute: **requests** and **tokens**. Each limit is a bucket that holds one minute's
worth and refills continuously (limit / 60 per second). A request is admitted only if both buckets can pay for it,
and then both are charged. Otherwise neither is charged and the caller gets `429` with `Retry-After`.

The buckets live in Redis, not in the gateway process. Run three gateways and they share one count; a per-process
counter would hand each instance the full limit. The check is one Lua script, so Redis runs it start to finish
without any other command in between: two gateways can never both read "1 token left" and both spend it.

## The path of a request

Budgets (PR 5) sit right after this check and settle through the same step as the token bucket; see [../budgets/README.md](../budgets/README.md). A request the budget refuses gets its tokens back.

1. `auth/plugin.ts` (onRequest) identifies the key, as before. The cached key entry now carries `keyId`, `rpmLimit`
   and `tpmLimit`, so the limiter costs no extra database read.
2. `ratelimit/plugin.ts` (preHandler, after the body is read) first asks whether the route would accept the body
   (valid JSON, a string `model`, an array `messages`). A body the route is going to answer with a 400 is not
   charged at all: no request token, no tokens. (Such 400s cost the gateway almost nothing and need a valid key.)
   Then it estimates the token cost: `ceil(prompt characters / 4)` plus the output allowance, which is
   `max_tokens` (or `max_completion_tokens`) when the caller set one, else `RATE_LIMIT_DEFAULT_MAX_TOKENS` (a TPM estimate only; the cap sent to the provider and the budget hold come from the per-model defaults, which this does not change)
   trimmed to whatever is left of the key's minute, so a small request with no `max_tokens` is not refused
   because of a default the caller never chose.
3. A request that can never fit in the key's whole tokens-per-minute is `400 request_too_large`, nothing charged:
   the caller named a `max_tokens` that with the prompt exceeds it, or the prompt alone does.
4. `limiter.take()` runs `token-bucket.lua`. Allowed: the response carries `x-ratelimit-*` headers (OpenAI's names).
   Denied: `429`, `retry-after` in whole seconds (rounded up), and the same headers.
5. The route sends the request upstream. When the answer shows the real usage, `settle()` corrects the token bucket
   by (estimate - actual): a refund if the estimate was high, a debit (the bucket may go negative) if it was low.
   Non-streamed: the `usage` object in the body. Streamed: the gateway asks the provider for it
   (`stream_options.include_usage`) and `sse-usage.ts` reads it from the last chunk as the bytes pass. If the
   client did not ask for usage itself, the usage-only chunk (`choices: []` plus `usage`) is removed from what it
   receives; only the event being read is held back, every other event goes out as soon as it is complete.
6. What is charged when things go wrong:
   - the provider answers non-2xx (500, 429, ...) or cannot be reached (502, 504): nothing was used, the whole
     estimate is refunded (`settle(0)`);
   - the client leaves, or a stream fails after bytes were sent: tokens were partly used, so the estimate stays;
   - a streamed answer with no usage in it, or a request whose `stream_options` is not an object, or a provider answer that was 2xx but whose body then broke: the
     estimate stays;
   - a denied request is never charged or settled.

Two trade-offs to know about:
- With `include_usage` on, OpenAI-style providers put `"usage":null` on every content chunk, and the gateway forwards
  those unchanged (even to a client that did not ask for usage). Most clients ignore the field.
- When the caller names no `max_tokens`, the output allowance is trimmed to what is left of the key's minute
  (`tpm` minus the prompt), so the real output can be larger than what was charged. The correction then debits
  the difference and the bucket goes negative, so the key's later requests wait. The overshoot is bounded by one
  request's output and corrects itself as the bucket refills.

How the request body changes for a streamed request: if the client already sent `include_usage: true` the bytes are
forwarded untouched. If it sent no `stream_options`, `"stream_options":{"include_usage":true},` is spliced in after
the opening brace (no JSON round trip, so large integers such as a `seed` keep every digit). If it sent
`stream_options` without `include_usage: true` the body is rewritten through JSON. If `stream_options` is not an
object the body is forwarded untouched and the usage is not read.

If Redis does not answer within `RATE_LIMIT_REDIS_TIMEOUT_MS` the request is served, unlimited, with no limit headers
(**fail open**, D-016). The log gets one warning when the outage starts and one note when it ends. A reply that
merely arrives late may still mean the script ran and charged; if it later reports the request admitted, the
limiter hands the request token and the tokens back, so a request that was served unlimited is not also counted.

## The script, line by line

`token-bucket.lua`. `KEYS` are the two bucket keys, `ARGV` the arguments; both are explained at the top of the file.
Redis stores each bucket as a hash with two fields: `tokens` (how many it holds, may be fractional or negative) and
`ts` (the millisecond it was last updated).

| Line | Code | What it does |
|---|---|---|
| 1 | `-- Two token buckets ...` | Comment: the whole point of the script. |
| 2 | `-- KEYS[1] = request bucket ...` | Comment: the two keys are written `rl:{keyId}:req` and `rl:{keyId}:tok`. Only the part in braces is hashed to pick a Redis Cluster slot, so both land on the same node, which a multi-key script requires. |
| 3 | `-- ARGV[1] = requests per minute ...` | Comment: the three arguments the gateway sends. |
| 4 | `-- ARGV[4] = optional clock override ...` | Comment: a fourth, optional, argument. Production never sends it. |
| 5 | `local rpm = tonumber(ARGV[1])` | Requests-per-minute limit. Arguments reach Lua as strings, so convert to a number. This is also the request bucket's capacity. |
| 6 | `local tpm = tonumber(ARGV[2])` | Tokens-per-minute limit, also the token bucket's capacity. |
| 7 | `local cost = tonumber(ARGV[3])` | The estimated tokens this request will use. |
| 8 | (blank) | |
| 9 | `local now` | The current time in milliseconds, assigned just below. |
| 10 | `if ARGV[4] then` | Only a test passes a fourth argument. |
| 11 | `now = tonumber(ARGV[4])` | Tests pin the clock here, so a slow machine cannot refill a bucket in the middle of a burst and make the count depend on speed. |
| 12 | `else` | Every real request. |
| 13 | `local t = redis.call('TIME')` | Ask Redis for its own clock: seconds and microseconds. One clock for every gateway instance, so two gateways with clocks minutes apart still agree. |
| 14 | `now = t[1] * 1000 + math.floor(t[2] / 1000)` | Convert to whole milliseconds. |
| 15 | `end` | Closes the `if`. |
| 16 | (blank) | |
| 17 | `local function refill(key, capacity)` | Helper: how many tokens does this bucket hold right now? |
| 18 | `local h = redis.call('HMGET', key, 'tokens', 'ts')` | Read the two stored fields in one call. |
| 19 | `local tokens = tonumber(h[1])` | Tokens it held when last written (`nil` if the key does not exist). |
| 20 | `local ts = tonumber(h[2])` | The time of that last write. |
| 21 | `if tokens == nil or ts == nil then` | Never seen, or expired because it sat idle. |
| 22 | `return capacity` | A bucket nobody has touched is full. |
| 23 | `end` | |
| 24 | `local elapsed = math.max(0, now - ts)` | Milliseconds since the last write. Never negative, even if Redis's clock stepped backwards after a failover. |
| 25 | `return math.min(capacity, tokens + elapsed * capacity / 60000)` | Add what refilled: `capacity` per 60 000 ms. Cap at capacity, so an idle key banks one minute, never more. A bucket in debt (negative) climbs back the same way. |
| 26 | `end` | |
| 27 | (blank) | |
| 28 | `local function save(key, tokens, capacity)` | Helper: write a bucket back. |
| 29 | `redis.call('HSET', key, 'tokens', tokens, 'ts', now)` | Store the new count and the time it is true for. |
| 30 | `local ms = math.ceil((capacity - tokens) * 60000 / capacity)` | How long this bucket needs to be full again: the missing tokens divided by the refill rate. Rounded up. |
| 31 | `redis.call('PEXPIRE', key, math.max(ms, 1))` | Let Redis delete the key at that moment. A full bucket and a missing bucket mean the same thing (line 22), so idle keys cost no memory. At least 1 ms, because Redis refuses 0. |
| 32 | `end` | |
| 33 | (blank) | |
| 34 | `local req = refill(KEYS[1], rpm)` | Current request tokens. Nothing is written yet. |
| 35 | `local tok = refill(KEYS[2], tpm)` | Current token-bucket tokens. |
| 36 | (blank) | |
| 37 | `local allowed = 0` | Result flag; 1 means admitted. |
| 38 | `local wait = 0` | Milliseconds until the request could be admitted; filled in only on a denial. |
| 39 | `local short = 0` | Which bucket is the reason for a denial: 1 requests, 2 tokens. |
| 40 | `if req >= 1 and tok >= cost then` | **The decision.** One request token and the full token cost must both be available. Both conditions, or neither bucket moves. |
| 41 | `allowed = 1` | Admit. |
| 42 | `req = req - 1` | Pay one request. |
| 43 | `tok = tok - cost` | Pay the estimated tokens. |
| 44 | `else` | Denied. Note that nothing is subtracted in this branch. |
| 45 | `local wait_req = 0` | Time the request bucket needs. |
| 46 | `if req < 1 then` | Only if it is the one that is short. |
| 47 | `wait_req = math.ceil((1 - req) * 60000 / rpm)` | Missing fraction of a token times the time one token takes (60 000 / rpm ms). |
| 48 | `end` | |
| 49 | `local wait_tok = 0` | Time the token bucket needs. |
| 50 | `if tok < cost then` | Only if it is short. |
| 51 | `wait_tok = math.ceil((cost - tok) * 60000 / tpm)` | Missing tokens times the time one token takes (60 000 / tpm ms). Includes debt: a bucket at -600 is 610 short of a cost of 10. |
| 52 | `end` | |
| 53 | `wait = math.max(wait_req, wait_tok)` | Both must be satisfied, so the caller must wait for the slower one. This becomes `Retry-After`. |
| 54 | `short = 1` | Assume requests... |
| 55 | `if wait_tok > wait_req then` | ...unless tokens take longer. |
| 56 | `short = 2` | The 429 message names tokens. |
| 57 | `end` | |
| 58 | `end` | Closes the allowed/denied `if`. |
| 59 | (blank) | |
| 60 | `save(KEYS[1], req, rpm)` | Write the request bucket: charged if admitted, merely refilled if denied. |
| 61 | `save(KEYS[2], tok, tpm)` | Same for the token bucket. Writing the refilled value on a denial is harmless: it is the same amount the next call would compute. |
| 62 | (blank) | |
| 63 | `local reset_req = math.ceil((rpm - req) * 60000 / rpm)` | Milliseconds until the request bucket is full: the `x-ratelimit-reset-requests` header. |
| 64 | `local reset_tok = math.ceil((tpm - tok) * 60000 / tpm)` | Same for tokens. |
| 65 | `return {allowed, ...}` | Hand back: admitted or not, whole tokens remaining in each bucket (never shown negative), the wait, both resets, and which bucket was short. |

### The correction script

`token-bucket-adjust.lua` moves one bucket by a delta. It runs after the answer on the token bucket, and also on both
buckets to hand back the charge of a take that timed out. It reads the clock the same way, refills the token bucket (lines
that mirror 17-25), adds `delta = estimate - actual` (a refund when positive, a debit when negative), caps the
result at capacity, and writes it back with the same expiry rule. It does not check that the bucket stays above
zero: a request that used more than estimated leaves the bucket negative, and later requests wait until refill
brings it back.

## Decisions

- **Both limits in one script** (D-015): requests per minute alone would let one caller send a few enormous prompts;
  tokens alone would let one caller send a flood of tiny ones.
- **Fail open** (D-016): availability beats strict limits when Redis is down. Monthly budgets (a later PR) keep spend
  capped regardless.
- **Redis time, not the gateway's**: instances never disagree about "now".
- **Token bucket, not sliding window**: bursts up to a minute's limit are fine, the average is capped, and the state is
  two numbers per bucket instead of a log of timestamps.
- **The estimate is characters / 4, not a tokenizer**: it is corrected after every call, so it only has to be roughly
  right for one request, and a tokenizer would cost CPU on every request. Estimate-versus-actual error from a real
  run: not measured. The final suite measured the limit itself: 0 admissions over the limit in 10 runs on 3 instances
  (see [BENCHMARKS.md](../../BENCHMARKS.md)).
- **A rejected request is never charged**, and a limited response replaces the upstream's own `x-ratelimit-*`
  headers (they describe the gateway's account, not the caller's key).
- **Limits are per key**, set with `npm run keys -- create-key <tenant> --rpm 100 --tpm 50000` or
  `npm run keys -- set-limits <prefix> --rpm 200` (only the limits named are written, so two changes to different
  limits cannot undo each other; it needs no pepper and no Redis for the database write). A key with none uses `RATE_LIMIT_DEFAULT_RPM` (600) and
  `RATE_LIMIT_DEFAULT_TPM` (200 000). `set-limits` writes Postgres, then overwrites the cached key entry (never a
  revoke tombstone), so the next request on any instance sees it.

## What is proven, and where

| Claim | Test |
|---|---|
| 1 000 concurrent takes at 100 per minute admit exactly 100 | `ratelimit/limiter.test.ts` |
| The same across 3 gateway apps sharing one Redis | `ratelimit/limiter.test.ts` |
| Refill is limit / 60 per second; an idle key banks one minute | `ratelimit/limiter.test.ts` |
| Denied by one bucket charges the other nothing | `ratelimit/limiter.test.ts`, `ratelimit/plugin.test.ts` |
| Refund is capped at capacity; a debit delays later requests by the computed time | `ratelimit/limiter.test.ts` |
| Redis down: served, one warning per outage | `ratelimit/limiter.test.ts`, `ratelimit/plugin.test.ts` |
| Actual usage corrects the charge, streamed and not | `routes/chat.test.ts` |
| Provider 500 / 429 / unreachable refund the estimate; a mid-stream failure keeps it | `routes/chat.test.ts` |
| A body the route rejects is not charged; a small request with no `max_tokens` is admitted by a small key | `ratelimit/plugin.test.ts`, `usage/estimate.test.ts` |
| A take that timed out but ran in Redis is handed back in both buckets | `ratelimit/limiter.test.ts` |
| The usage-only chunk is stripped only for a client that did not ask; the body keeps big integers byte for byte | `routes/chat.test.ts`, `usage/sse-usage.test.ts` |
| Streamed bytes in equal bytes out, forwarded at once | `usage/sse-usage.test.ts` |

The exactness tests pin the limiter's clock (the script's optional fourth argument), because at 100 per minute a
bucket gains a token every 0.6 s: a burst that takes longer than that on a loaded machine would legitimately admit
one more. A test that reads the real Redis clock checks that refill really comes from `TIME`.

## Cache hits

The response cache runs right after the limiter. A hit still counts as one request against rpm (the limiter protects the
gateway), but its token estimate is handed back in full, because no provider tokens were used. See
[../cache/README.md](../cache/README.md).

## Measured

Pending quiet run: overhead of the check (limiter off vs on, same rate) and the 1 000-request burst against a
100-per-minute key come from `bench/run-ratelimit.sh`, results in `bench/results/pr-4/`. No figure is quoted here
until that run is committed.
