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
3. `budget.lua` does the check and the hold in one atomic Redis script: `spent + reserved + estimate > cap` refuses,
   otherwise the estimate is added to `reserved`. Two gateways can never both see "10 cents left" and both spend it.
   The response carries `x-budget-remaining-usd` (after this reservation).
4. When the call ends, one shared step (`usage/settle.ts`) tells the rate limiter and the budget the same thing:
   - **used**: the provider reported usage. The budget charges the actual cost.
   - **refund**: the gateway or the provider did no work (non-2xx before any bytes, upstream unreachable). Nothing is charged.
   - **keep**: no usage was seen (client left, stream cut, a 2xx whose body broke, no usage in the answer). The whole
     reservation is charged and the ledger row is marked `estimated`.
   A request the budget refuses also hands back the tokens the rate limiter had taken for it.
5. Every charge is written to Postgres after the response (`spend_ledger`, one row per request id, plus `tenant_spend`),
   with 3 retries. Redis holds the live balance; Postgres is the record the balance can be rebuilt from.

Money is integer micro-USD (1 USD = 1,000,000), never a float; the CLI refuses a budget that isn't a plain USD amount.
`keys set-budget <tenant> --monthly-usd 0.01` and `keys show-spend <tenant> [--period YYYY-MM]`.

## When Redis is down

If Redis doesn't answer within `BUDGET_REDIS_TIMEOUT_MS` the decision moves to Postgres (D-018): one short transaction
locks the tenant's `tenant_spend` row, adds up unexpired `budget_reservations`, checks the cap and inserts a hold. The lock
is held for the check only, never across the provider call. The rate limiter fails open (D-016); the budget does not,
because that would uncap spend. If neither store can decide the answer is `503 budget_unavailable`.

The **epoch** is a number in Postgres that is part of every Redis balance key. An instance that falls back to Postgres
bumps it once per outage, and every instance re-reads it every `BUDGET_EPOCH_REFRESH_S`. Spend charged on the
Postgres path never reaches the old Redis balance, so after recovery the new epoch's key doesn't exist and the next
reserve rebuilds it from `tenant_spend`. Rebuilds are safe to race: the `init` script only creates the balance if it is
still missing. A reservation also lapses on its own (`BUDGET_RESERVATION_TTL_S`), so a gateway that crashes mid-request
can't hold money forever.

## Known limits (documented, not closed here)

- **R6, partial outages.** If some instances are on Redis and some on Postgres, neither sees the other's reservations,
  so the cap can be exceeded by up to the in-flight worst cases on the minority path. Owned by PR 12, which measures it
  with 3 instances. The same applies to PG-path holds that are still in flight when an instance returns to Redis.
- **R7, settled-spend writes are in-process.** After the response the gateway writes the ledger row with retries;
  a crash between the Redis settle and the Postgres write loses that record. The durable queue is PR 10.
- **Prompt estimate too low.** The estimate is a heuristic. If the provider reports more prompt tokens than estimated
  the actual charge exceeds the hold, so settled spend can pass the cap by that request's estimate error (in flight
  requests × their error, at most). A test covers it; the flood benchmark with the mock cannot show it because the
  mock counts prompt tokens by the same heuristic.
- A call that outlives its reservation TTL still has its real cost added when it settles, but money it held may have been
  given to another request meanwhile.
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

**What happens if Redis dies mid-month?** Decisions move to a Postgres row-lock path, so the cap still holds; the epoch
bumps; on recovery the Redis balance is rebuilt from `tenant_spend`, which has every charge from both paths.

**What's the epoch for?** Redis keys include it so a balance that missed spend while Redis was unreachable or bypassed is
never trusted again.

**Where can the cap still be broken, and by how much?** R6 (partial outage, bounded by minority-path in-flight worst
cases), a low prompt estimate (bounded by that request's estimate error), and R7 (a lost ledger write after a crash).
