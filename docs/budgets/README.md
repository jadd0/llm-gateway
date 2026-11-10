# Budgets

Diagram: [budget-flow.html](budget-flow.html). Code: `packages/gateway/src/budget/` (`budget.lua`, `redis-ledger.ts`,
`pg-ledger.ts`, `budget.ts`, `plugin.ts`, `period.ts`), `pricing/prices.ts`, and the shared settle step
`usage/settle.ts`.

Rate limits cap speed, not money. Each tenant has a **monthly spend cap** (UTC calendar month, resets on the 1st).
A request is only sent upstream after the gateway has **reserved** its worst-case cost against the cap; when the call
ends, the reservation is replaced by what was really spent. Over the cap the answer is `402`
(`insufficient_quota`, code `budget_exhausted`), not 429: OpenAI SDKs retry 429s, and retrying an empty budget is pointless.

## Cache hits

The response cache runs before the budget step, so a hit reserves nothing and is served even when the cap is spent. It
writes one `spend_ledger` row with `cached = true`, `cost_micros = 0` and `saved_micros`; `tenant_spend` is not touched,
so the balance is exactly what it was. A hit found by meaning has the same row with `cache_kind = 'semantic'`; `keys show-spend` splits the two. See [../cache/README.md](../cache/README.md) and [../semantic-cache/README.md](../semantic-cache/README.md).

## Reserve, then settle

1. `budget/plugin.ts` runs right after the rate limiter. A body the chat route would reject reserves nothing.
   A model with no price is `400 model_not_priced` (a cap can't be enforced without a price).
2. The worst case is `ceil(prompt chars / 4)` prompt tokens plus `max_tokens` (or the model's default output cap, else
   `RATE_LIMIT_DEFAULT_MAX_TOKENS`, when the caller set none; for an OpenAI-format model, which is sent no limit of the
   gateway's, the model's documented maximum output (`maxOutputTokens` in `pricing/prices.ts`: 128,000 for gpt-6-astra and
   gpt-5-nano, read 2026-11-09 from https://developers.openai.com/api/docs/models/gpt-6-astra and `.../gpt-5-nano`; mock-* models
   use `MOCK_MAX_OUTPUT_TOKENS`, 4096). A tenant who cannot cover that hold gets a 402 that suggests setting `max_tokens`), at the model's long-context rates when the prompt is past its threshold, priced from the static table in `pricing/prices.ts`, rounded up in micro-USD.
   Unlike the rate limiter, the output is never trimmed to a per-minute size: money is held for the most the call can cost.
   With a fallback chain (see [../resilience/](../resilience/README.md)) the hold is priced at the **dearest model in the chain**, so a
   fallback can never push a tenant past its cap; the final charge is at the price of the model that served, and the ledger row names it.
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
5. The settle runs after the response. With Redis up, one `budget.lua` call appends the spend entry to the request-log
   stream and moves the live balance on the **current** epoch; the log worker then writes Postgres (the `spend_ledger`
   row, one per request id, `tenant_spend` and the hold row's deletion; see [../request-log/README.md](../request-log/README.md)).
   If the script cannot run, or Redis is down, the gateway writes that Postgres transaction itself (3 retries) and then
   corrects the live balance. Each charge is numbered in `tenant_spend.charges` under the row lock and carries the
   running total, and Redis only takes a total that is ahead of the one it has, so a repeated, reordered or
   already-rebuilt settle can never count a charge twice or lose one.

Money is integer micro-USD (1 USD = 1,000,000), never a float; the CLI refuses a budget that isn't a plain USD amount.
`keys set-budget <tenant> --monthly-usd 0.01` and `keys show-spend <tenant> [--period YYYY-MM]`.

**The cost:** one extra Postgres write on every request (the mirrored hold) plus the settle transaction. The hold
write's own cost is not measured separately: the final suite measured overhead with budgets off, and the throughput
and steady-load runs have them on (see [../../BENCHMARKS.md](../../BENCHMARKS.md)).

## When Redis is down

The cap stays hard (D-024). Every hold is in Postgres as well as Redis, so when Redis is declared down the decision
moves to Postgres (D-018): one short transaction locks the tenant's `tenant_spend` row, adds up all
`budget_reservations` (lapsed rows too: a lapsed hold may have a settle queued) (including the holds Redis admitted a moment before it died), checks the cap and inserts a hold.
The lock is held for the check only, never across the provider call. The rate limiter fails open (D-016); the budget does
not, because that would uncap spend. If neither store can decide the answer is `503 budget_unavailable`.

Redis is declared down only when a failed call is followed by a failed PING, or after `BUDGET_OUTAGE_FAILURES` (3) failed
calls in a row: one slow call is retried, it does not move the fleet. The instance goes back to Redis only after the
epoch bump has committed and it has adopted the new epoch; if the bump fails it is retried and the instance stays on
Postgres even though Redis answers (the old epoch's balance missed what Postgres decided). The **epoch** is a number in Postgres that is part
of every Redis balance key. Declaring an outage bumps it with a compare-and-set from the value seen when the failures
began, so of three gateways that see the same outage one bumps and the other two adopt the new number. After recovery
the new epoch's key doesn't exist and the next reserve rebuilds it from Postgres in one snapshot: `spent` and the charge
count from `tenant_spend`, plus every hold row, lapsed ones included, so the rebuilt balance equals the record and still counts
in-flight requests and settles the worker has not applied yet (a worker down for longer than the TTL cannot make the cap
leak). **A hold never leaves a Redis balance by time**, only by its settle, by the worker applying a charge, or by the
reconcile; a hold present in a balance therefore means that balance has not charged that request, which is what keeps a late
catch-up from counting spend twice. `BUDGET_RESERVATION_TTL_S` (which must exceed `UPSTREAM_MAX_DURATION_MS` plus 30 s or the
gateway won't start) is when a never-settled hold becomes eligible for the worker's sweeper, which charges its estimate, so a
gateway that crashes mid-request holds the money until then and then pays for it.

## Other behaviour worth knowing

- **Only priced models are served.** A model with no price gets `400 model_not_priced`: a cap can't be enforced
  without a price. `mock-*` models and six real models (the current flagship and smallest text model of Anthropic, OpenAI and Gemini) are priced, each real row with its read date and pricing page; see [../providers/README.md](../providers/README.md).
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
- **Settle goes through the request-log stream.** With Redis up, the settle script (`budget.lua`) appends the spend entry and
  moves the live balance in one call; the log worker writes the ledger row, adds to `tenant_spend` (only for rows it really
  inserted, so a redelivery changes nothing) and drops the hold row. Until it has, Postgres still holds the hold, so a balance
  rebuilt from Postgres counts the estimate and the worker then releases it and adds the real charge. If the script cannot run,
  or Redis is down, the settle is written to Postgres directly as before. See [../request-log/README.md](../request-log/README.md).
- **Lapsed holds** are not deleted: the log worker charges each one its estimate (recorded as `estimated`, model `unknown`),
  on its own timer once the hold has been lapsed for `LOG_SWEEP_GRACE_S`, so a gateway that dies mid-request can never make money vanish. The holds table also goes with its
  tenant (`on delete cascade`).

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
  250 ms refresh and the rebuild bump shrink. The final suite then ran 10 budget floods on 3 instances with Redis restarted
  mid-run: 0 tenants over the cap, largest overshoot 0 micro-USD. The mechanism remains, bounded and not seen there.
- **R7, settled spend is recorded after the response.** With Redis up the settle is a queued stream entry the log worker
  writes to Postgres, so it survives the gateway dying after the script ran. Only the Redis-down path writes Postgres
  in-process, with 3 retries. If that still fails, or the process dies before it runs, nothing is recorded for that
  request: the hold stays in Postgres until it lapses and the worker's sweeper then charges its estimate (recorded
  `estimated`), so the money is not lost, but the charge is the estimate and not the real cost, which can be higher or
  lower.
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

- **R24, a gateway killed between its two hold writes.** The hold is written to Postgres, then reserved in Redis. A gateway
  killed between the two leaves a Postgres hold Redis never counted; the sweeper charges its estimate, so `tenant_spend` can
  pass the cap by one estimate per request killed in that window (seen once: 10008 against a cap of 10000) until the next
  Redis rebuild. The chaos runs kill a provider, not a gateway, so this window was not exercised.
- **R25, no Postgres pool connection timeout.** The main pool has none: exhausted connections would surface as
  `503 budget_unavailable` on the hold write instead of queuing. No such 503 appeared in any final-suite run (0 failures in
  216003 steady requests and in every correctness run); accepted as is.

## Numbers

From the final suite ([../../BENCHMARKS.md](../../BENCHMARKS.md), `bench/results/final/`): 3 instances behind nginx, 10 runs of a budget flood
(20000 requests): 0 tenants whose settled spend passed the cap, a ledger row for every admitted request, largest
overshoot 0 micro-USD; the same with Redis restarted mid-run. Under load past 4000 req/s on one instance, budget
balance rebuilds are where the gateway's CPU goes (R29).

- **Redis Cluster is not supported.** The settle script writes the spend stream and the tenant's keys in one call; on a
  cluster that fails with CROSSSLOT. The gateway and the worker refuse to start when `INFO cluster` says `cluster_enabled:1`.
  Sharding the spend stream per tenant would fix it and is not built: it would make the worker read a stream per tenant.
- **A refused request's hold row** is dropped straight away; if that delete fails it is retried in the background and
  marked `refused`, so it counts against no cap and the sweeper deletes it instead of charging its estimate. A row that
  cannot be reached at all, with its gateway gone, is charged like any lapsed hold once Postgres is back.
- **Redis holds with no Postgres row** (a rebuild imported the hold of a request Postgres then refused, or a catch-up was
  lost) are released by the worker's reconcile once `BUDGET_ORPHAN_GRACE_S` past their expiry, and charged what Postgres charged
  if it has a ledger row. A refused request also releases its hold at the newest epoch straight away.
