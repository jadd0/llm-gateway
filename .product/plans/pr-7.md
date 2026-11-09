# PR 7 — Resilience: timeouts, retries, circuit breaker, fallback

**CONCERN:** one slow or dead provider today means a failed request (or a 30 s wait) for every
client; real gateways retry what is safe to retry, stop hammering a provider that is down, and
move to a backup model.

**ACCEPTANCE:** per-attempt timeouts; retries with exponential backoff and jitter on retryable errors only; a circuit breaker per provider with shared state in Redis; an ordered fallback chain of models; a k6 chaos run that kills the mock mid-load records client success % during the outage; explainer walks the breaker's states line by line.

**SCOPE GUARD:** no retry once a stream has started sending to the client (once reply headers are
written, the attempt is final). No request-body `fallbacks` field (D-027). No hedged/parallel
requests, no load balancing across keys, no per-tenant chains. Exact cache is PR 8.

**BASE:** main at 44c1913 (PR 6 merged); branch `pr-7-resilience` (worktree
`.claude/worktrees/pr-7-resilience`); stacked on none; migration: none. Residuals owned by this
PR: **R2** (one timeout for every phase) and **R13** (translated error replies drop provider
headers), both closed here.

## Files
| path | change |
|---|---|
| `packages/gateway/src/resilience/timeouts.ts` | **new**. Per-phase timeout settings; classifies an undici error into `connect`, `headers`, `body`, `deadline` |
| `packages/gateway/src/resilience/retry.ts` | **new**. `isRetryable(outcome)`, `backoffMs(attempt, retryAfter)` (full jitter), attempt loop helper |
| `packages/gateway/src/resilience/breaker.lua` | **new**. Atomic record-outcome / may-I-call script (see Invariants) |
| `packages/gateway/src/resilience/breaker.ts` | **new**. Redis breaker per provider target, with an in-memory breaker used while Redis is unreachable |
| `packages/gateway/src/resilience/fallback.ts` | **new**. Parses `MODEL_FALLBACKS`; `chainFor(model)` |
| `packages/gateway/src/resilience/*.test.ts` | **new**. Beside each file above |
| `packages/gateway/src/routes/chat.ts` | dispatch moves into an attempt loop over chain × retries; settle once with the model that served; R13 header forwarding |
| `packages/gateway/src/routes/chat.test.ts`, `routes/chat-providers.test.ts` | retry, fallback, breaker, no-retry-after-stream-start, header tests |
| `packages/gateway/src/routes/chat-resilience.test.ts` | **new**. End-to-end resilience tests against two mock processes |
| `packages/gateway/src/upstream.ts` | pools take the split timeouts (closes R2); per-mock-format base URL override |
| `packages/gateway/src/budget/plugin.ts`, `budget/plugin.test.ts` | hold priced at the dearest model in the chain; settle at the serving model's price |
| `packages/gateway/src/usage/settle.ts` | settle takes the serving model |
| `packages/gateway/src/app.ts` | wire breaker and chains |
| `packages/gateway/src/config.ts`, `config.test.ts`, `.env.example` | rows in Decisions |
| `packages/mock-provider/src/server.ts`, `server.test.ts` | `/__control` `fail_rate` (0–1) and `status` for injected errors, so a run can mix successes and failures |
| `bench/k6/chaos.js` | **new**. Constant arrival rate; per-second success and latency tagged by phase (before / outage / after) |
| `bench/run-chaos.sh` | **new**. Two mocks; kills mock A at t=20 s, restarts it at t=50 s; runs with fallback on and off |
| `bench/chaos-summary.ts`, `bench/chaos-summary.test.ts` | **new**. Writes `bench/results/pr-7/summary.md` from the k6 JSON only |
| `bench/results/pr-7/*` | **new** (full run by the orchestrator, R4) |
| `package.json` | script `bench:chaos` |
| `BENCHMARKS.md` | "Resilience under outage (PR 7)" section |
| `docs/resilience/README.md` | **new**. Timeouts, retries, breaker (states walked line by line through `breaker.lua`), fallback, what is never retried, numbers, interview Qs |
| `docs/resilience/breaker.html` | **new**. Archify state diagram: closed → open → half-open → closed/open |
| `docs/resilience/request-attempts.html` | **new**. Archify flow: request → chain → breaker check → attempt → retry/fallback → settle |
| `docs/README.md`, `docs/architecture/*`, `docs/gateway/README.md`, `docs/budgets/README.md`, `docs/providers/README.md`, `docs/mock-provider/README.md` | resilience built; request path updated |
| `docs/diagrams/flows.md` | register the two new flows |
| `.product/RESIDUALS.md`, `.product/DECISIONS.md` | close R2, R13; D-027–D-030 |

## Schema

none.

## Invariants

- **One client request = one rate-limit charge and one budget hold**, however many attempts run.
  Settle happens once, with the usage of the attempt that served, priced at that model.
- **Budget hold** = worst-case estimate priced at the **dearest model in the chain** (D-028). A
  chain model with no price makes the whole chain `model_not_priced` at start-up (config error),
  not at request time.
- **Timeouts per attempt and phase** (closes R2): connect `UPSTREAM_CONNECT_TIMEOUT_MS` (5 s),
  time to response headers `UPSTREAM_HEADERS_TIMEOUT_MS` (120 s; a non-streamed completion only
  sends headers when done), silence mid-body `UPSTREAM_IDLE_TIMEOUT_MS` (30 s). The existing
  `UPSTREAM_MAX_DURATION_MS` bounds the **whole request including every attempt and backoff**;
  no attempt starts if the remaining time is under `RETRY_MIN_REMAINING_MS` (1 s).
- **Retryable** (same model, then next in chain): connect error/refused/reset before any
  response; connect timeout; status 429, 500, 502, 503, 504, 529. A headers timeout is retried on
  the next model only (the provider may still be working and charging; same-model retry would
  double-bill). **Never retried:** any other 4xx (incl. 400, 401 → `provider_auth_failed`, 403,
  404, 413), and anything after reply headers have been written to the client.
- **Streams:** a streamed attempt is retryable until the gateway writes reply headers, which it
  does only after the upstream answers 200. Mid-stream failure ends the stream as today
  (OpenAI-shaped error event); no retry.
- **Backoff:** attempt n (1-based retry) waits `random(0, min(cap, base·4^(n-1)))`, base 200 ms,
  cap 2 s (full jitter). A `retry-after` (seconds or HTTP date) is honoured when it fits in the
  remaining deadline and ≤ `RETRY_AFTER_MAX_MS` (5 s); otherwise skip to the next model.
  `RETRY_MAX_ATTEMPTS_PER_MODEL` = 3 (2 retries, D-030).
- **Breaker per provider target** (`openai`, `anthropic`, `gemini`, each `mock-*`), states:
  - closed: calls allowed; each outcome recorded into a rolling `BREAKER_WINDOW_MS` (10 s)
    window in Redis (`{prefix}breaker:{target}`, hash of buckets, Redis TIME).
  - open when, in the window, failures ≥ `BREAKER_MIN_FAILURES` (5) **and** failure ratio ≥
    `BREAKER_FAILURE_RATIO` (0.5). Stays open `BREAKER_OPEN_MS` (15 s): calls skip straight to
    the next model, no network.
  - half-open after the cooldown: exactly one probe across all processes (`SET NX PX`
    = attempt timeout); others treat it as open. Probe success → closed (window reset); probe
    failure → open for another cooldown.
  - Only retryable failures count; a 400 is the client's fault and never opens a breaker.
  - One Lua script does read-state + record atomically; `breaker.ts` is the only caller.
- **Redis down → local breaker** (D-029): same state machine in memory per process, used while
  Redis calls fail or exceed `BREAKER_REDIS_TIMEOUT_MS` (50 ms); local state is discarded when
  Redis answers again. Never blocks a request on Redis longer than that timeout.
- **All models unavailable** (breakers open or attempts exhausted) → the last attempt's mapped
  error if there was one, else 503 `all_providers_unavailable` with `retry-after` = soonest
  breaker reopen (seconds, rounded up).
- **Response tells the truth:** body `model` is what the serving provider returned; headers
  `x-gateway-model` (serving model) and `x-gateway-attempts` (count) on every reply, success or
  error. Logs one line per attempt (model, target, outcome, ms); never bodies or messages.
- **R13:** translated error replies and the 502 `provider_auth_failed` reply forward the same
  provider header allow-list as pass-through, extended with `anthropic-ratelimit-*`,
  `request-id`, `x-request-id`, plus `server-timing`.

## Tests

`resilience/retry.test.ts`: `retryable statuses and errors are classified exactly`;
`400 401 403 404 413 are never retried`; `backoff stays within full-jitter bounds`;
`retry-after seconds and http-date are honoured and capped`.
`resilience/timeouts.test.ts`: `undici errors map to connect headers body deadline`.
`resilience/breaker.test.ts` (real Redis): `opens at min failures and ratio`;
`does not open below min failures even at 100% failure`; `open skips without a call`;
`half-open lets exactly one probe through across two breaker instances`;
`probe success closes, probe failure reopens`; `4xx outcomes never count`;
`Redis down falls back to the local breaker within the timeout`; `local state dropped when Redis returns`.
`resilience/fallback.test.ts`: `chain parsed in order`; `model without a chain is a chain of one`;
`unpriced chain model fails config load when budgets are on`.
`routes/chat-resilience.test.ts` (two mocks):
- `a 503 then 200 is retried on the same model and settles once`
- `connect refused on A falls back to B; x-gateway-model names B`
- `headers timeout moves to the next model without a same-model retry`
- `a 400 from A is returned unchanged with one attempt`
- `stream: failure before headers is retried; failure after the first chunk is not`
- `retries never exceed UPSTREAM_MAX_DURATION_MS`
- `breaker open on A: request goes to B with no call to A (mock A request count unchanged)`
- `all open returns 503 all_providers_unavailable with retry-after`
- `budget hold priced at the dearest chain model; charge priced at the serving model`
- `rate limit charged once across three attempts`
- `translated 429 forwards anthropic-ratelimit and request-id headers` (closes R13)
`upstream`: `connect, headers and idle timeouts are separate` (closes R2).

## Acceptance proof

1. `bash scripts/gate.sh` → PASS.
2. By hand: two mocks (`:9000`, `:9001`), chain `mock-openai-1>mock-anthropic-1`; `POST /__control
   {"outage":"error"}` on A; curl → 200 from B, `x-gateway-model: mock-anthropic-1`,
   `x-gateway-attempts: 4` (three tries on A, one on B); repeat → breaker opens, `x-gateway-attempts: 1` (A skipped); wait
   15 s, restore A → probe, back to A. Hops: `chat.ts` → `fallback.ts` → `breaker.ts`/`breaker.lua`
   → `retry.ts` → `upstream.ts` → mock.
3. `bash bench/quiet.sh bench/results/pr-7 && bash bench/run-chaos.sh` (orchestrator) → per-phase
   client success % and p95, fallback on vs off, in `summary.md`.

## Adversarial

1. Kill mock A mid-stream: the client's stream ends with an error event, A is not retried for
   that request, budget settles from usage seen (or the estimate), nothing double-charged.
2. 50 concurrent requests the moment a breaker goes half-open: exactly one reaches A.
3. Redis paused (`DEBUG SLEEP` or stop) during an outage: requests still fall back, p95 stays
   within backoff + 50 ms timeout, no request hangs.
4. Chain where B is dearer than A: tenant with budget for A but not B is refused up front
   (`budget_exhausted`), never charged above cap.
5. Retry-after of 3600 s from A: no wait, next model immediately.
6. Every figure in BENCHMARKS.md and docs/resilience traces to `bench/results/pr-7/` (R3).

## Data flows

- Chat completion attempts (retry, breaker, fallback) → `docs/resilience/request-attempts.html` → `packages/gateway/src/{routes/chat.ts,resilience/*.ts}`
- Breaker state → `docs/resilience/breaker.html` → `packages/gateway/src/resilience/{breaker.ts,breaker.lua}`

## Decisions

- **D-027 Fallback chains live in gateway config** (founder): `MODEL_FALLBACKS`, e.g.
  `claude-fable-5-1>gpt-6-astra>gemini-3.1-pro-preview;mock-openai-1>mock-anthropic-1`; default
  empty (no fallback). Apps send nothing new.
- **D-028 Budget hold priced at the dearest model in the chain; settle at the serving model**
  (founder). A tenant near its cap may be refused slightly early; the cap is never overshot.
- **D-029 Redis down → each process uses a local in-memory breaker** (founder).
- **D-030 Up to 3 attempts per model (2 retries)**, full-jitter backoff 200 ms base, 2 s cap,
  honouring `retry-after` ≤ 5 s (founder).
- **Headers timeout is not retried on the same model** (loop default; idempotency: a provider may
  bill a request we gave up on).
- **Config rows:** `MODEL_FALLBACKS`, `UPSTREAM_CONNECT_TIMEOUT_MS=5000`,
  `UPSTREAM_HEADERS_TIMEOUT_MS=120000`, `UPSTREAM_IDLE_TIMEOUT_MS=30000` (replaces
  `UPSTREAM_TIMEOUT_MS`; old name refused at start-up with a message naming the three),
  `RETRY_MAX_ATTEMPTS_PER_MODEL=3`, `RETRY_BASE_MS=200`, `RETRY_CAP_MS=2000`,
  `RETRY_AFTER_MAX_MS=5000`, `RETRY_MIN_REMAINING_MS=1000`, `BREAKER_WINDOW_MS=10000`,
  `BREAKER_MIN_FAILURES=5`, `BREAKER_FAILURE_RATIO=0.5`, `BREAKER_OPEN_MS=15000`,
  `BREAKER_REDIS_TIMEOUT_MS=50`, `MOCK_ANTHROPIC_BASE_URL` / `MOCK_GEMINI_BASE_URL` (default
  `MOCK_BASE_URL`, so the chaos run can kill one mock and keep the other).
- **Chaos run:** 200 req/s non-streamed + 50 req/s streamed for 80 s, mock latency on (realistic);
  A killed with SIGKILL at 20 s, restarted at 50 s; once with chain A>B, once with no chain.
  Reports success % and p50/p95 per phase, and how many requests reached A while its breaker
  was open (should be 0 outside probes). Builders smoke-test only (R4).
- **Docs** (R2): the breaker explainer walks `breaker.lua` line by line; interview Qs incl. "why
  not retry a timed-out POST on the same provider?", "why full jitter?", "what happens to the
  breaker when Redis dies?", "why can't you retry a stream?", "how do fallbacks interact with
  budgets?".
