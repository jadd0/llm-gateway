# Budgets

Diagram: [budget-flow.html](budget-flow.html). Code: `packages/gateway/src/budget/` (`budget.lua`, `redis-ledger.ts`,
`pg-ledger.ts`, `budget.ts`, `plugin.ts`, `period.ts`), `pricing/prices.ts`, and the shared settle step
`usage/settle.ts`.

Rate limits cap speed, not money. Each tenant has a **monthly spend cap** (UTC calendar month, resets on the 1st).
A request is only sent upstream after the gateway has **reserved** its worst-case cost against the cap; when the call
ends, the reservation is replaced by what was really spent. Over the cap the answer is `402`
(`insufficient_quota`, code `budget_exhausted`), not 429: OpenAI SDKs retry 429s, and retrying an empty budget is pointless.

## Reserve, then settle

1. `budget/plugin.ts` runs right after the rate limiter. A body the chat route would reject reserves nothing.
   A model with no price is `400 model_not_priced` (a cap can't be enforced without a price).
2. The worst case is `ceil(prompt chars / 4)` prompt tokens plus `max_tokens` (or `RATE_LIMIT_DEFAULT_MAX_TOKENS`
   when the caller set none), priced from the static table in `pricing/prices.ts`, rounded up in micro-USD.
   Unlike the rate limiter, the output is never trimmed to a per-minute size: money is held for the most the call can cost.
3. The hold is **written to Postgres first** (`budget_reservations`), then `budget.lua` does the check and the hold in
   one atomic Redis script: `spent + reserved + estimate > cap` refuses, otherwise the estimate is added to `reserved`.
   Two gateways can never both see "10 cents left" and both spend it. Postgres goes first so a rebuild or a
   Postgres-path decision running in between already counts the hold; if Redis refuses, the row is deleted before the
   402 is returned. If the Postgres write fails nothing is held anywhere and the answer is `503 budget_unavailable`.
   The response carries `x-budget-remaining-usd` (after this reservation). Holds that a rebuild imported for requests
   not yet decided are decided by arrival order (the script checks everything counted still fits, and drops the
   request's hold if it doesn't), so exactly the money that fits is admitted.
4. When the call ends, one shared step (`usage/settle.ts`) tells the rate limiter and the budget the same thing:
   - **used**: the provider reported usage. The budget charges the actual cost.
   - **refund**: the gateway or the provider did no work (non-2xx before any bytes, upstream unreachable). Nothing is charged.
   - **keep**: no usage was seen (client left, stream cut, a 2xx whose body broke, no usage in the answer). The whole
     reservation is charged and the ledger row is marked `estimated`.
   A request the budget refuses also hands back the tokens the rate limiter had taken for it.
5. The settle is one Postgres transaction after the response: the hold row is deleted, the `spend_ledger` row is
   written (one per request id) and `tenant_spend` is increased, with 3 retries. Then the live Redis balance is
   corrected on the **current** epoch. Each charge is numbered in `tenant_spend.charges` under the row lock and
   carries the running total, and Redis only takes a total that is ahead of the one it has, so a repeated, reordered
   or already-rebuilt settle can never count a charge twice or lose one.

Money is integer micro-USD (1 USD = 1,000,000), never a float; the CLI refuses a budget that isn't a plain USD amount.
`keys set-budget <tenant> --monthly-usd 0.01` and `keys show-spend <tenant> [--period YYYY-MM]`.

**The cost:** one extra Postgres write on every request (the mirrored hold) plus the settle transaction. Its effect on
latency is measured in the pending quiet benchmark (`gateway-*-budget-{off,on}`).

## When Redis is down

The cap stays hard (D-024). Every hold is in Postgres as well as Redis, so when Redis is declared down the decision
moves to Postgres (D-018): one short transaction locks the tenant's `tenant_spend` row, adds up all unexpired
`budget_reservations` (including the holds Redis admitted a moment before it died), checks the cap and inserts a hold.
The lock is held for the check only, never across the provider call. The rate limiter fails open (D-016); the budget does
not, because that would uncap spend. If neither store can decide the answer is `503 budget_unavailable`.

Redis is declared down only when a failed call is followed by a failed PING, or after `BUDGET_OUTAGE_FAILURES` (3) failed
calls in a row: one slow call is retried, it does not move the fleet. The instance goes back to Redis only after the
epoch bump has committed and it has adopted the new epoch; if the bump fails it is retried and the instance stays on
Postgres even though Redis answers (the old epoch's balance missed what Postgres decided). The **epoch** is a number in Postgres that is part
of every Redis balance key. Declaring an outage bumps it with a compare-and-set from the value seen when the failures
began, so of three gateways that see the same outage one bumps and the other two adopt the new number. After recovery
the new epoch's key doesn't exist and the next reserve rebuilds it from Postgres in one snapshot: `spent` and the charge
count from `tenant_spend`, plus every live hold, so the rebuilt balance equals the record and still counts in-flight
requests. A reservation also lapses on its own (`BUDGET_RESERVATION_TTL_S`, which must exceed `UPSTREAM_MAX_DURATION_MS` plus 30 s or
the gateway won't start), so a gateway that crashes mid-request can't hold money forever.

## Other behaviour worth knowing

- **Only priced models are served.** A model with no price gets `400 model_not_priced`: a cap can't be enforced
  without a price. Only `mock-*` models are priced now; real prices arrive in PR 6.
- **A streamed request with a `stream_options` shape the gateway can't rewrite** (not an object) is forwarded untouched,
  so no usage chunk is requested and it can't be reconciled: it is charged the full estimate.
- **A total deadline per upstream call (`UPSTREAM_MAX_DURATION_MS`, default 240 s).** `UPSTREAM_TIMEOUT_MS` only limits
  silence, so a slow stream that keeps trickling could outlive the hold that covers it, and its money would be given to
  other requests. A call past the deadline is cut: non-streamed answers `504 upstream_max_duration`, streamed ends with an
  OpenAI-shaped error event; the estimate stays charged (the provider may have worked). The gateway refuses to start
  unless `BUDGET_RESERVATION_TTL_S` x 1000 exceeds `UPSTREAM_MAX_DURATION_MS` + 30 s, so a hold always outlives its call.
- **At the deadline** the upstream call is aborted at once and the estimate is charged then, not when the response
  finishes. A streamed answer gets the error event only if it is a 2xx event stream (other bodies are just ended); a
  client that does not read what is left within 5 s has its connection destroyed.
- **A client that leaves before the request is sent upstream gets everything back** (limiter tokens and budget);
  after it was sent the estimate stays, because the provider may bill.
- **Lapsed holds** are deleted from Postgres by a bounded sweep (1000 rows every `BUDGET_SWEEP_INTERVAL_S`, 60 s, per
  instance) as well as on the Postgres path; the holds table also goes with its tenant (`on delete cascade`).

- **Why a hold could be left in Redis.** A Redis reserve whose script ran but whose reply was lost leaves a hold that
  nothing else knows of. If the request is then admitted on Postgres its settle releases the hold by id; if it is
  refused (or ends unavailable) the hold is now released straight away, together with the Postgres row. A settle also
  reads the epoch after its transaction commits, so it releases on the balance that a rebuild after the commit would
  have been built at. A rebuild creates the balance only from the Postgres snapshot, so ids without a Postgres row
  cannot survive an epoch change.
- **Epoch bumps are single-flight and back off** (exponentially, at most 2 s): an outage and any number of lost balances
  share one attempt per instance, so a flush that empties many tenants' balances costs one bump. A settle only counts a
  balance as "seen" when it applied to one that exists. The 250 ms refresh is a plain `select` (the epoch row is created
  once when a budget starts), and a failed epoch read right after a settle commits does not fail the settle.
- **A balance Redis lost** (a restart) is noticed when an instance has to rebuild a balance it had been using; it moves
  the epoch with the same compare-and-set, so all instances rebuild together. A new tenant or month, which also needs a
  rebuild, does not.

## Known limits (documented, not closed here)

- **R6, partial outages.** An instance that didn't see the outage keeps using the old epoch's balance for up to
  `BUDGET_EPOCH_REFRESH_MS` (250 ms; it also learns the epoch from every settle, and an instance whose Redis balance
  vanished moves the epoch itself). The Postgres-path instance sees every hold; Redis-path instances see the
  Postgres-path holds only after they move to the new epoch and rebuild. Measured by the verifier: 1.92x the cap with
  Redis-only holds; 0.96x for a partial outage with Postgres holds (5 s refresh); and in 13 steady-flood runs that
  killed and restarted Redis, 11 stayed within the cap and 2 went over by 3101 and 6102 micro-USD (101 and 102 requests
  admitted where 99 fit), with the accounting exact every time. The overshoot comes from the window above, which the
  250 ms refresh and the rebuild bump shrink; PR 12 measures the bound properly with 3 instances.
- **R7, settled-spend writes are in-process.** The Postgres transaction that removes the hold and records the charge
  runs after the response, with 3 retries. If it still fails, or the process dies before it runs, nothing is written:
  the hold stays in Redis and Postgres until its TTL and then the whole charge is lost (the tenant is under-billed,
  never over-capped by this). The durable queue is PR 10.
- **Prompt estimate too low.** The estimate is a heuristic made before the call. If the provider reports more prompt
  tokens than estimated, the actual charge exceeds the hold, so settled spend can pass the cap by about the in-flight
  requests times their estimate error. The verifier measured one concurrent burst with a 10x underestimate reaching
  3.12x the cap. That bound is inherent to estimating before the call; the flood benchmark with the mock cannot show it
  because the mock counts prompt tokens by the same heuristic.
- **A retry of the request's own hold can be refused.** A reserve that is sent again with the same id (after a lost
  reply) is admitted only if everything counted still fits the cap; if the balance went over in between, the retry is
  refused and its hold dropped, although the first attempt would have fitted. That errs towards refusing.
- A call that outlives its reservation TTL still has its real cost added when it settles, but the money it held may
  have been given to another request meanwhile.
- Prices exist for `mock-*` models only (a fictitious $1 in / $3 out per million tokens); real prices arrive with the adapters.

## Numbers

Pending quiet run. See [../../BENCHMARKS.md](../../BENCHMARKS.md); no figure is quoted here until
`bench/results/pr-5/` is committed (R3).

## Likely interview questions

**Why reserve the worst case?** The output length isn't known until the call ends and a slow call can last minutes.
Holding `max_tokens` worth of money means concurrent requests can't jointly outspend the cap, whatever they end up using.
Settling to actual gives the unused part back.

**Why not just check `balance > 0`?** Check-then-spend isn't atomic: 50 concurrent requests all see a positive balance
and all go. The reserve is one Lua script, so the check and the hold can't be separated. Tests fire 50 at once at a cap
that fits 7 and exactly 7 are admitted.

**Why integer micro-dollars?** Floats can't add up cents exactly, and money that drifts can't be audited. Integers add
exactly; costs round up so rounding never favours the tenant.

**What happens if Redis dies mid-month?** The cap still holds. Every hold is also a row in Postgres, so the Postgres
path counts the requests Redis had already admitted; when Redis returns, the balance is rebuilt from Postgres with
those holds in it, and settles from before the outage land on the rebuilt balance exactly once. Tests kill Redis with
holds in flight and flood: exactly the money that fits is admitted.

**What's the epoch for?** Redis keys include it so a balance that missed spend while Redis was unreachable is never
trusted again. It moves once per outage (compare-and-set), not once per gateway.

**Where can the cap still be broken, and by how much?** By a low prompt estimate (about in-flight requests times their
estimate error; one 10x-underestimate burst reached 3.12x), in a partial outage (R6, to be measured in PR 12), and a lost
Postgres settle write under-counts a charge (R7).
