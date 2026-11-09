# Resilience

Diagrams: [request-attempts.html](request-attempts.html) (one request, attempt by attempt) and
[breaker.html](breaker.html) (the circuit breaker's states). Code: `packages/gateway/src/resilience/`
(`timeouts.ts`, `retry.ts`, `breaker.ts`, `breaker.lua`, `fallback.ts`) and the attempt loop in `routes/chat.ts`.

One slow or dead provider used to mean a failed request, or a long wait, for every client. The gateway now retries what
is safe to retry, stops calling a provider that is down, and moves to a backup model.

## What happens to one request

1. The rate limiter and the budget run first and charge **once**, however many attempts follow (D-028: the budget hold is
   priced at the dearest model in the chain).
2. `fallback.ts` turns the requested model into a chain (`MODEL_FALLBACKS`, D-027). A model with no chain is a chain of one.
3. For each model in order, each attempt first asks the breaker for a permit. An open breaker skips the model with no network call.
4. The attempt runs under three timeouts: connect (`UPSTREAM_CONNECT_TIMEOUT_MS`), time to response headers
   (`UPSTREAM_HEADERS_TIMEOUT_MS`, long because a non-streamed completion sends headers only when it is done) and silence
   in the body (`UPSTREAM_IDLE_TIMEOUT_MS`). `UPSTREAM_MAX_DURATION_MS` bounds the whole request including every attempt and backoff.
5. A failure is classified. Retried: connection refused or reset, connect timeout, and 429, 500, 502, 503, 504, 529.
   Never retried: any other 4xx (400, 403, 404, 413), the provider's 401 (that is `provider_auth_failed`, the gateway's
   own key), and anything after reply headers were written.
6. Retried failures wait a **full-jitter** backoff (random between 0 and `min(cap, base * 4^(n-1))`, base 200 ms, cap 2 s), up
   to 3 attempts per model (D-030). A `retry-after` is honoured when it is at most `RETRY_AFTER_MAX_MS` and fits in the time
   left; otherwise the request moves to the next model at once. No attempt starts with under `RETRY_MIN_REMAINING_MS` left.
7. A **headers timeout** moves to the next model and is never repeated on the same one (D-031): the provider may still be
   working on, and billing, a request we gave up on.
8. When a model answers 200, reply headers are written and the answer is final. A stream that dies later ends with the
   usual error event; it is never retried, because the client has already received bytes.
9. Settle happens once, with the usage of the attempt that served, priced at that model. If nothing served, everything
   held goes back and the client gets the last attempt's answer (translated to the OpenAI shape, with the provider's
   `retry-after`, request-id and rate-limit headers), or `503 all_providers_unavailable` with `retry-after` set to the
   soonest a breaker reopens.

Every reply carries `x-gateway-model` (the model that served, or the last one tried) and `x-gateway-attempts` (upstream
calls made; 0 when every breaker was open). The body's `model` is whatever the serving provider returned. Each attempt logs
one line: model, provider target, outcome, milliseconds, never a body or message.

## The breaker, line by line

One breaker per provider target (`openai`, `anthropic`, `gemini`, each `mock-*`). The whole state machine is one Lua script,
`breaker.lua`, so every gateway process shares it and two processes can never both take the probe. State lives in a hash
`{prefix}breaker:{target}`: an `open_until` field while the breaker is open, and per-second counters `t<second>` (outcomes)
and `f<second>` (failures) that form the rolling window.

- **Clock.** Redis `TIME`, so processes with drifting clocks agree. (Tests pass a pinned clock instead.)
- **acquire, no `open_until`:** the breaker is closed; the call is allowed.
- **acquire, `now < open_until`:** open; refused with the time left. No network call is made.
- **acquire, cooldown over:** half-open. `SET probe NX PX` can succeed for exactly one caller across all processes; that
  caller gets the probe, everyone else is told the breaker is still open.
- **record, probe:** the lock is deleted. A failed probe sets a new `open_until`. A probe the provider answered (success, or
  an answer that was the client's fault) deletes the whole hash, so the window starts empty. An abandoned probe (client left)
  only releases the lock.
- **record, closed:** a call that started before the breaker opened and ends after it changes nothing. Otherwise old
  second counters outside `BREAKER_WINDOW_MS` are deleted, this outcome is counted, and a failure opens the breaker when
  failures in the window are at least `BREAKER_MIN_FAILURES` **and** at least `BREAKER_FAILURE_RATIO` of the outcomes.
- **What counts.** Only retryable failures. A 400, or the gateway's own 401, shows the provider is alive and is not counted.

If Redis does not answer within `BREAKER_REDIS_TIMEOUT_MS`, the same state machine runs in memory in each process (D-029),
and Redis is left alone for a second so a dead Redis costs one short wait, not one per call. When Redis answers again the
local state is dropped.

## Numbers

Figures are pending. The chaos run (`bench/run-chaos.sh`) kills one mock mid-load and records client success and latency
per phase, with and without the fallback chain; it is run by the orchestrator, and its output will be committed under
`bench/results/pr-7/`. See [../../BENCHMARKS.md](../../BENCHMARKS.md).

## Interview questions

**Why not retry a timed-out POST on the same provider?** The provider may still be generating, and billing, the request we
abandoned. A second copy could be billed twice. The next model in the chain is a different provider's job, so that is safe.

**Why full jitter?** Plain exponential backoff makes every client that failed together retry together. Picking a random
wait between zero and the ceiling spreads them out, so a provider that is recovering is not hit by a synchronised wave.

**What happens to the breaker when Redis dies?** Each process falls back to its own in-memory breaker with identical rules,
within 50 ms, and drops that state when Redis returns. The cost is that processes no longer share what they learn.

**Why can't you retry a stream?** Once the gateway has written reply headers and the first bytes, the client has seen part
of an answer. A retry would either repeat or splice text. So the gateway retries only until the upstream answers 200.

**How do fallbacks interact with budgets?** The budget holds the worst case of the dearest model in the chain, so falling
back to a dearer model can never push a tenant past its cap. When the request is done, it is charged at the price of the
model that actually served it, and the ledger names that model.
