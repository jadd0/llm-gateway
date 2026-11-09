# PR 5 — Budgets: pre-estimate and reconcile

**CONCERN:** rate limits (PR 4) cap speed, not money; a tenant within its limits can still spend
without bound, and a naive "balance > 0" check lets concurrent requests overdraw the balance.

**ACCEPTANCE:** each tenant has a hard spend cap; cost is reserved atomically before the call from an estimate and reconciled to actual tokens after; a test hammering a tenant with a small cap under concurrency never lets settled spend exceed the cap; exhausted budget returns 402.

**SCOPE GUARD:** spend caps only. Prices are a static table in the repo; no billing, invoices or
payment provider. Real provider prices arrive with the adapters in PR 6; this PR prices the
mock's models only. Settled-spend writes are not queued yet (the queue is PR 10).

**BASE:** main after PR 4 merges (reuses `usage/estimate.ts`, the SSE usage tap and the reconcile
hook); branch `pr-5-budgets` (worktree `.claude/worktrees/pr-5-budgets`); stacked on none;
migration: next free number at generate time. Residuals owned by this PR: none.

## Files
| path | change |
|---|---|
| `packages/gateway/src/db/schema.ts` | `tenants.monthly_budget_micros`; new tables `tenant_spend` (with `charges`), `spend_ledger`, `budget_reservations` (every hold), `budget_epoch` |
| `packages/gateway/drizzle/0002_outstanding_bedlam.sql`, `packages/gateway/drizzle/meta/0002_snapshot.json`, `packages/gateway/drizzle/meta/_journal.json` | generated migration |
| `packages/gateway/src/pricing/prices.ts` | **new**. Price table (micro-USD per 1M input / output tokens) and `costMicros(model, in, out)` |
| `packages/gateway/src/pricing/prices.test.ts` | **new** |
| `packages/gateway/src/budget/budget.lua` | **new**. `reserve`, `settle` and `init` scripts (see Invariants) |
| `packages/gateway/src/budget/redis-ledger.ts` | **new**. Redis path: load scripts, reserve, settle, rebuild from a Postgres snapshot (holds included) |
| `packages/gateway/src/budget/pg-ledger.ts` | **new**. Postgres side: the row-locked reserve, the mirrored hold, the settle transaction, the snapshot, the epoch compare-and-set |
| `packages/gateway/src/budget/budget.ts` | **new**. Chooses the path (Redis, or Postgres while Redis is down), owns the epoch and the outage rule, mirrors every hold and writes every settle to Postgres |
| `packages/gateway/src/budget/*.test.ts` | **new**. Beside each of the three files above |
| `packages/gateway/src/budget/plugin.ts` | **new**. `preHandler` after rate limit: price check, reserve, 402; settle from the reconcile hook |
| `packages/gateway/src/budget/plugin.test.ts` | **new** |
| `packages/gateway/src/ratelimit/plugin.ts` | the reconcile hook hands actual usage to budget settle as well (one hook, two consumers) |
| `packages/gateway/src/auth/key-store.ts` | cached tenant value carries `monthlyBudgetMicros`; `setBudget` overwrites the cache entry |
| `packages/gateway/src/cli/keys.ts` | `set-budget <tenant> --monthly-usd <n>`, `show-spend <tenant> [--period YYYY-MM]` |
| `packages/gateway/src/cli/keys.test.ts` | set-budget / show-spend tests |
| `packages/gateway/src/config.ts`, `.env.example` | new rows (Decisions) |
| `packages/gateway/src/app.ts` | register budget plugin after rate limit |
| `packages/gateway/src/usage/settle.ts`, `packages/gateway/src/usage/settle.test.ts` | **new**. The one shared settle step (used / refund / keep) feeding the rate limiter and the budget |
| `packages/gateway/src/usage/estimate.ts`, `packages/gateway/src/usage/estimate.test.ts` | `estimateWorstCase`: prompt plus max_tokens or the default, no tpm clamp |
| `packages/gateway/src/routes/chat.ts` | settles through the shared step; `keep` on every exit |
| `packages/gateway/src/budget/period.ts`, `packages/gateway/src/budget/period.test.ts` | **new**. UTC month helpers |
| `packages/gateway/src/test-env.ts` | budgets off by default in tests |
| `packages/gateway/src/config.test.ts` | **new**. Budget settings: the TTL-versus-upstream-timeout check, defaults |
| `packages/gateway/src/auth/key-store.test.ts`, `packages/gateway/src/auth/plugin.test.ts` | cached tenant carries the cap |
| `bench/budget-tool.ts` | **new**. Creates and measures the flood tenants |
| `bench/run-baseline.sh`, `bench/run-ratelimit.sh` | budgets off in the older benchmarks |
| `bench/k6/budget-flood.js` | **new**. Concurrent flood at a small-cap tenant |
| `bench/run-budget.sh` | **new**. Overhead run (cap high, nothing refused) vs PR 4; flood runs; Redis-down run |
| `bench/results/pr-5/*.json` | **new**; produced by the orchestrator's quiet run (pending) |
| `BENCHMARKS.md` | "Budgets (PR 5)" section |
| `docs/budgets/README.md` | **new**. Reserve-then-settle in plain English, the Lua annotated, failure modes, numbers, interview Qs |
| `docs/budgets/budget-flow.html` | **new**. Archify diagram: reserve → call → settle, the Postgres fallback and the epoch |
| `docs/gateway/chat-passthrough.html`, `docs/auth/api-key-check.html`, `docs/rate-limiter/token-bucket.html` | redrawn: the settle step, the cap in the key entry |
| `docs/README.md`, `docs/architecture/*`, `docs/gateway/README.md`, `docs/rate-limiter/README.md` | budgets built; request path updated |
| `docs/diagrams/flows.md` | add the flow lines below |

## Schema

```sql
alter table tenants add column monthly_budget_micros bigint;  -- null = BUDGET_DEFAULT_MONTHLY_USD
create table tenant_spend (
  tenant_id uuid not null references tenants(id) on delete cascade,
  period    char(7) not null,                       -- 'YYYY-MM', UTC
  spent_micros bigint not null default 0,
  charges   bigint not null default 0,              -- charges added to spent_micros; orders them
  primary key (tenant_id, period)
);
create table spend_ledger (
  request_id uuid primary key,                      -- idempotent settle
  tenant_id uuid not null references tenants(id) on delete cascade,
  period char(7) not null, model text not null,
  prompt_tokens int not null, completion_tokens int not null,
  cost_micros bigint not null, estimated boolean not null, -- true = no usage seen, estimate charged
  created_at timestamptz not null default now()
);
create table budget_reservations (                  -- every hold, whichever store decided it
  id uuid primary key, tenant_id uuid not null, period char(7) not null,
  amount_micros bigint not null, expires_at timestamptz not null
);
create index budget_reservations_tenant_period_idx on budget_reservations (tenant_id, period);
create table budget_epoch (id int primary key check (id = 1), epoch bigint not null);
```

## Invariants

- **Money is integer micro-USD (bigint)**, never floats. Cost =
  `ceil(in x inPrice / 1e6) + ceil(out x outPrice / 1e6)`, rounded up so rounding never favours
  the tenant.
- **Postgres is the record; the Redis balance is a replica of it.** `tenant_spend.spent_micros` and
  `budget_reservations` hold the truth; the Redis hash (`spent`, `reserved`, `ver`) plus its `res` zset and
  `amt` hash are rebuilt from them whenever they are missing, and corrected after each settle.
- **Estimate = worst case:** `costMicros(model, promptEstimate, max_tokens ?? RATE_LIMIT_DEFAULT_MAX_TOKENS)`,
  from `estimateWorstCase` (never clamped to a key's tpm). Output can't exceed `max_tokens`; a prompt
  estimate below the truth is the one overshoot source, inherent to estimating before the call.
- **Reserve, Redis path** (the normal one). Two steps, in this order:
  1. `budget.lua` `reserve`, atomic: purge expired holds; `REBUILD` if the balance is missing; refuse if
     `spent + reserved + estimate > cap`; else add the hold. Key `bud:{<tenantId>}:<period>:<epoch>`.
  2. INSERT the hold into `budget_reservations` (id = request id, tenant, period, amount,
     `expires_at = now() + BUDGET_RESERVATION_TTL_S`). If that insert fails the Redis hold is released and the
     request is refused with 503 `budget_unavailable` (fail closed, D-023).
  Every hold is therefore in Postgres whichever store decided it.
- **Reserve, Postgres path** (Redis declared down): one transaction locks the `tenant_spend` row (upserted
  first), deletes this tenant's lapsed holds, sums the unexpired `budget_reservations` (Redis-path holds
  included), checks the cap and inserts the hold. The lock is held for the check only, never across the call.
- **Rebuild.** A missing balance (first request of a month, a new epoch, a flush) is rebuilt from one
  repeatable-read snapshot of Postgres: `spent = tenant_spend.spent_micros`, `ver = tenant_spend.charges`,
  and every unexpired hold goes into the `res`/`amt` structures (expiry = now + time left) with `reserved` =
  their sum. The `init` script creates the balance only if it is still missing, so racing rebuilds can't add
  anything twice, and a stale rebuild cannot overwrite a live balance. The snapshot is consistent because a
  settle commits the hold's removal and its charge in one transaction.
- **Settle** (the same for a hold decided on either store), always in this order:
  1. One Postgres transaction: delete the `budget_reservations` row; insert `spend_ledger` (on conflict
     `request_id` do nothing); if that was new, add the cost to `tenant_spend` and increment `charges`
     (returning both values, taken under the row lock); read the budget epoch. Retried 3x with backoff. If it
     still fails, nothing was written: the hold stays (in both stores) until its TTL, then the charge is lost
     (residual R7). A refund deletes the hold and writes no ledger row.
  2. The Redis correction on the **current** epoch's key (the epoch read in step 1, adopted if newer than the
     local one, whatever epoch the request reserved under): release the hold if its id is present; if
     `charges > ver`, set `spent = spentAfter` and `ver = charges`.
  Why this is exact: Postgres numbers charges in commit order (each updates the row under its lock) and
  `spentAfter` is the running total, so `(ver, spent)` in Redis is always a value Postgres has had. A repeated
  settle, or settles arriving in any order, leave the maximum; a balance rebuilt after a charge already holds
  it (`ver >= charges`) so the late settle changes nothing; a charge numbered above `ver` carries every
  earlier charge with it. No epoch appears in the rule, so an epoch change can neither lose nor double a
  charge. Releasing a hold is idempotent because only a present id is subtracted. A failed Redis settle is
  retried (it is safe to repeat).
- **Actual cost** comes from the shared settle step in `usage/settle.ts` (used / refund / keep, identical for
  the rate limiter and the budget). No usage seen (keep) charges the full hold and marks `estimated = true`.
  A request refused before the call reserves nothing and settles nothing.
- **Outage.** One failed or timed-out Redis call is not an outage. Redis is declared down when a call fails
  and a PING then fails too, or after `BUDGET_OUTAGE_FAILURES` (default 3) consecutive failed calls; any
  success resets the count. Until Redis is declared down a failed call is retried (settle) or decided on
  Postgres for that request alone (reserve); the instance stays on the Redis path.
- **Epoch.** The epoch is part of every Redis balance key. Declaring an outage bumps it with
  `UPDATE budget_epoch SET epoch = epoch + 1 WHERE epoch = <epoch seen when the failures began>`: of every
  instance that saw the same outage exactly one bumps and the rest adopt the new value (also adopted from the
  epoch read in each settle and every `BUDGET_EPOCH_REFRESH_S`). No decision is taken until the bump has
  landed. After recovery the first reserve at the new epoch finds no balance and rebuilds it from Postgres.
  Old-epoch keys expire.
- **Recovery.** While on the Postgres path an instance tries Redis again at most once a second; a success
  returns it to the Redis path.
- **Period** is the UTC calendar month at reserve time; settle charges the reserve's period. Redis budget
  keys expire 35 days after period start.
- **Startup check:** `BUDGET_RESERVATION_TTL_S * 1000` must exceed `UPSTREAM_TIMEOUT_MS` or the config fails
  to load, naming both settings.
- **Unknown model (no price):** 400 `{error:{type:"invalid_request_error",code:"model_not_priced"}}`,
  nothing reserved; a budget can't be enforced without a price.
- **402 body:** `{error:{type:"insufficient_quota",code:"budget_exhausted",message:"..."}}`; **503**
  `{error:{type:"gateway_error",code:"budget_unavailable"}}` when no store can decide or the hold cannot be
  mirrored. A request refused for budget hands back the rate-limit tokens it took. Every budgeted response
  carries `x-budget-remaining-usd` (after this reservation).
- Order in the request path: auth -> rate limit -> budget -> route -> settle (limits + budget, one step).
- **Known bounds, documented not closed:** (a) a prompt estimated below the truth: settled spend can pass the
  cap by about the in-flight requests times their estimate error (measured: one burst with a 10x underestimate
  reached 3.12x the cap); (b) a partial outage (some instances on Redis, some on Postgres): the Postgres-path
  instance sees every hold, Redis-path instances see Postgres-path holds only at the next rebuild / epoch
  refresh; the remaining bound is measured in PR 12 (R6; with Redis-only holds the verifier measured 1.92x);
  (c) a lost Postgres settle write loses that charge (R7).

## Tests

`budget/redis-ledger.test.ts` (real Redis, namespaced keys):
- `50 concurrent reserves against a cap that fits 7 worst cases admit exactly 7`
- `settle releases the reservation and charges actual; settled spend never exceeds the cap over 200 randomised concurrent rounds`
- `settle is idempotent and order-independent`
- `expired reservation is released without a settle`
- `missing balance triggers rebuild from Postgres; two concurrent rebuilds don't double it`
- `a rebuilt balance counts the live holds, releases them on settle, and does not count a charge it already holds twice`
- `period rolls over`

`budget/pg-ledger.test.ts` (worktree Postgres):
- `50 concurrent reserves on the Postgres path admit exactly 7`; `row lock is not held across the provider call`
- `a hold written for Redis counts against the Postgres path and settles like any other`
- `the snapshot has spend, charge count and only the live holds`; `charges are numbered in order under concurrency`
- settle / refund / repeat recording; expired holds; a bump from a stale epoch changes nothing

`budget/budget.test.ts` (three in-process instances, a Redis whose budget commands and PING fail on demand):
- `Redis killed with holds in flight, then a flood: the cap holds and exactly the money that fits is admitted`
  (3 holds in flight on Redis, 60 concurrent reserves after the kill: exactly 4 admitted, settled spend 7000 <= 7500)
- `after recovery the Redis balance equals tenant_spend and its reserved equals the live Postgres holds`
- `an old-epoch settle after the rebuild lands on the new key exactly once`
- `a charge recorded before the rebuild is not added to the rebuilt balance a second time`
- `concurrent outage detection on 3 instances moves the epoch exactly once`
- `one timed-out settle does not switch paths`; `consecutive failures switch paths even when PING still answers`
- `every settle lands in spend_ledger and tenant_spend exactly once`; retries; give-up logging
- `a failed Postgres hold insert refuses the request and releases the Redis hold`
- `reserve reports unavailable when neither Redis nor Postgres can decide`

`budget/plugin.test.ts`: 402 body and no upstream call; `model_not_priced`; `aborted stream is charged its full
reservation and marked estimated`; `x-budget-remaining-usd`; default allowance not clamped; used / refund / keep
match the rate limiter; `503 budget_unavailable when the Postgres copy of a hold cannot be written`; exactly the
requests that fit are admitted under a 30-request flood.

`pricing/prices.test.ts`: `cost rounds up in micro-USD`. `cli/keys.test.ts`: `set-budget then show-spend`.
`config.test.ts`: `a reservation TTL that does not outlast the upstream timeout stops the gateway starting`; defaults.

## Acceptance proof

1. `npm run db:migrate`; `npm run keys -- set-budget acme --monthly-usd 0.01`.
2. `bash scripts/gate.sh` → PASS (concurrency tests are the cap proof).
3. `bash bench/run-budget.sh` → flood: 50 concurrent × 100 rounds; `bench/results/pr-5/flood.json`
   records max(settled spend / cap) and max overshoot in micro-USD; overhead vs `bench/results/pr-4/`;
   Redis-down run: cap still holds on the Postgres path, latency recorded.
4. curl until refused → 402 (hop: `budget/plugin.ts` → `budget.ts` → `redis-ledger.ts` → `budget.lua`).

## Adversarial

1. Flood across 3 in-process gateway apps sharing Redis and Postgres: settled spend <= cap.
2. Kill Redis mid-flood, restart it: cap holds throughout; post-recovery balance equals `tenant_spend`
   and its reserved equals the live Postgres holds (no lost or double charges). The verifier's harness
   (3 gateway processes, Redis stopped and restarted) is the live proof.
3. Kill a gateway process mid-request: its hold expires in both stores and the money is released.
4. Prompt estimate low (multi-byte prompt): measure and report the overshoot; it is bounded by in-flight
   requests x their estimate error.
5. Every figure in BENCHMARKS.md and docs/budgets traces to `bench/results/pr-5/` (R3).

## Data flows

- Budget reserve and settle → `docs/budgets/budget-flow.html` → `packages/gateway/src/budget/*.ts`
- Spend recorded to Postgres → `docs/budgets/budget-flow.html` → `packages/gateway/src/budget/{budget.ts,pg-ledger.ts}`

## Decisions

- **Live balance in Redis, every charge recorded in Postgres, Redis rebuilt from Postgres** (founder, D-017).
- **Redis down -> Postgres row-lock path** (founder, D-018), **hard through an outage** (founder, D-024):
  every hold is mirrored in Postgres, the Postgres path and every rebuild count unexpired holds, settles land
  on the current balance. Costs one extra Postgres write per request, measured in the pending quiet benchmark.
- **Both stores down -> 503, fail closed** (loop default, D-023).
- **Monthly budgets, UTC calendar month** (founder, D-019).
- **402, not 429:** OpenAI SDKs auto-retry 429; retrying an empty budget is pointless.
- **Micro-USD integers, round up.**
- **Settle is exact by construction, not by a done-key:** a per-tenant charge counter assigned under the row
  lock, carried to Redis with the running total (see Invariants). Chosen over an epoch-scoped idempotency key,
  which would double count a charge a rebuild had already included.
- **Outage needs a failed PING or N consecutive failures** (loop default; `BUDGET_OUTAGE_FAILURES=3`), and the
  epoch bump is compare-and-set, so one slow call cannot move the whole fleet and one outage moves it once.
- **Known limits, documented, not fixed here:** the partial-outage bound (R6, PR 12 measures it), the
  low-prompt-estimate overshoot (inherent), and settled-spend writes in-process after the response (R7, the
  queue is PR 10).
- **Prices:** mock models only (`mock-*`, a clearly labelled fictitious price). Real model prices are added in
  PR 6, from the providers' pricing pages with the date recorded.
- **Config rows:** `BUDGET_DEFAULT_MONTHLY_USD=10`, `BUDGET_RESERVATION_TTL_S=300` (must exceed
  `UPSTREAM_TIMEOUT_MS`), `BUDGET_REDIS_TIMEOUT_MS=50`, `BUDGET_EPOCH_REFRESH_S=5`, `BUDGET_OUTAGE_FAILURES=3`,
  `BUDGET_ENABLED=true`.
- **Docs** (R2): interview Qs incl. "why reserve the worst case?", "why not just check balance > 0?",
  "why integer micro-dollars?", "what happens if Redis dies mid-month?", "what's the epoch for?",
  "where can the cap still be broken, and by how much?".

## Notes from the build

- The plan predates PR 4 as merged: the reconcile point is `request.rateLimit.settle` called from `routes/chat.ts`, not an
  onResponse hook. Budget settle follows the same refund/keep rules through `usage/settle.ts`.
- Fix round 1 (D-024) replaced the original Redis-only holds, the per-request `done` key, the per-instance
  epoch bump and the single-failure outage rule. The verifier measured 1.12-1.13x the cap (steady flood) and
  2.10x (burst) with Redis killed, a Redis balance left below `tenant_spend`, and 3 epoch bumps for one outage.
- A request refused by the budget (402, 400 model_not_priced, 503) returns the tokens the limiter had taken.
- `testConfig()` turns budgets off by default; the budget tests turn them on. Tests that read a tenant's
  spend read Postgres, because another test file may move the shared epoch while they run.
