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
3. For each model in order, the gateway first asks the breaker for one permit. An open breaker skips the model with no network call. The breaker is told how the model's attempts went once, when they are all over (D-038): a success if any attempt succeeded, otherwise one failure, so retries do not amplify a trip.
4. The attempt runs under three timeouts: connect (`UPSTREAM_CONNECT_TIMEOUT_MS`), time to response headers
   (`UPSTREAM_HEADERS_TIMEOUT_MS`, long because a non-streamed completion sends headers only when it is done) and silence
   in the body (`UPSTREAM_IDLE_TIMEOUT_MS`). `UPSTREAM_MAX_DURATION_MS` bounds the whole request including every attempt and backoff. A provider's error answer is read for its body for at most `UPSTREAM_ERROR_BODY_TIMEOUT_MS` (2 s) once its status and headers are in; a body that stalls is dropped and its connection closed, the status kept, so a provider that sends a 503 and then goes quiet costs the request 2 s, not the idle timeout.
5. A failure is classified. Retried: connection refused or reset, connect timeout, and 429, 500, 502, 503, 504, 529.
   A 401, 403 or 404 is not retried on the same model but moves on to the next one (D-037): the gateway's credential or
   model name may be wrong for that provider only. Final at once: 400, 413, 422 and any other 4xx, and anything after reply
   headers were written. If the chain runs out on a 401, the reply is still the generic `provider_auth_failed`.
   A model whose breaker permit is the half-open **probe** gets exactly one attempt (D-039): its single outcome is
   recorded and the request moves to the next model, with no same-model retry.
6. Retried failures wait a **full-jitter** backoff (random between 0 and `min(cap, base * 4^(n-1))`, base 200 ms, cap 2 s), up
   to 3 attempts per model (D-030). A `retry-after` is honoured when it is at most `RETRY_AFTER_MAX_MS` and fits in the time
   left; otherwise the request moves to the next model at once. Before each retry the breaker is checked again; if other
   requests opened it meanwhile, this model is dropped and the next one is tried. No attempt starts with under `RETRY_MIN_REMAINING_MS` left.
7. A **headers timeout** moves to the next model and is never repeated on the same one (D-031): the provider may still be
   working on, and billing, a request we gave up on.
8. When a model answers 200, reply headers are written and the answer is final. A stream that dies later ends with the
   usual error event; it is never retried, because the client has already received bytes.
9. Settle happens once, with the usage of the attempt that served, priced at that model. If nothing served, everything
   held goes back and the client gets the last attempt's answer (translated to the OpenAI shape, with the provider's
   `retry-after`, request-id and rate-limit headers), or `503 all_providers_unavailable` with `retry-after` set to the
   soonest a breaker reopens. When an attempt failed and the rest of the chain was skipped by open breakers, a relayed
   5xx or no-answer error also gets that `retry-after` if the provider sent none; a 4xx never does. Whether the estimate is
   kept or refunded rests on one sticky flag, "some call of this request may still be billing": it is set when a call is
   sent and stays set after a headers timeout or a call cut in flight. It is cleared again only for that same call when
   it turns out to have been refused at connect, failed on the gateway's side, or answered with an error. A later
   model's refusal never clears it. At a deadline or at the end of the chain the estimate is kept if the flag is set, and
   refunded otherwise. A 401, 403 or 404 that moves the request on is logged at warn (model, provider, status).

Every reply carries `x-gateway-model` (the model that served, or the last one tried) and `x-gateway-attempts` (upstream
calls made; 0 when every breaker was open, and also on a 400, 402 or 429 refused before dispatch, where `x-gateway-model` is the model asked for). A name that is not printable ASCII of 1 to 128 characters is not echoed: the header is left out. The body's `model` is whatever the serving provider returned. Each attempt logs
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
- **record, probe:** the lock is deleted only if it still holds this probe's own token (compare, then delete), so a late
  probe cannot free a newer one's lock. Only a 2xx closes the breaker (D-039): the whole hash is deleted and the window
  starts empty. Every other outcome, including a 429, 401 or 404, sets a new `open_until` for another cooldown. An
  abandoned probe (client left) only releases the lock.
- **record, closed:** a call that started before the breaker opened and ends after it changes nothing. Otherwise old
  second counters outside `BREAKER_WINDOW_MS` are deleted, this outcome is counted, and a failure opens the breaker when
  failures in the window are at least `BREAKER_MIN_FAILURES` **and** at least `BREAKER_FAILURE_RATIO` of the outcomes.
- **What counts.** Only failures the provider is to blame for: a connection that could not be made, a headers timeout, and 500, 502, 503, 504, 529. A 429 is quota, not health (D-036), and a 400 or 401 shows the provider is alive; none is counted in the window (but none closes a half-open breaker either).
- **Orphaned probe.** The probe lock lives at most `min(connect + headers timeout, BREAKER_OPEN_MS)`. If the script took the lock but its reply never reached the caller, the breaker is stuck half-open for at most one cooldown. A probe that outlives the lock lets a second probe through.

If Redis does not answer within `BREAKER_REDIS_TIMEOUT_MS`, the same state machine runs in memory in each process (D-029),
and Redis is left alone for a second so a dead Redis costs one short wait, not one per call. A report is
told to the breaker without waiting for it (errors are logged at debug). A report Redis definitely did not store (a refused
or closed connection, a script error) is counted locally and marks Redis down; only one that timed out, where Redis may
have stored it, is dropped rather than counted twice. When Redis answers again the
local state is dropped.

## Numbers

Figures are pending. The chaos run (`bench/run-chaos.sh`) kills one mock mid-load and records client success and latency
per phase, with and without the fallback chain; it is run by the orchestrator, and its output will be committed under
`bench/results/pr-7/`. See [../../BENCHMARKS.md](../../BENCHMARKS.md).
