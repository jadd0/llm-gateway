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
| `packages/gateway/src/db/schema.ts` | `tenants.monthly_budget_micros`; new tables `tenant_spend`, `spend_ledger`, `budget_reservations`, `budget_epoch` |
| `packages/gateway/drizzle/` | generated migration |
| `packages/gateway/src/pricing/prices.ts` | **new**. Price table (micro-USD per 1M input / output tokens) and `costMicros(model, in, out)` |
| `packages/gateway/src/pricing/prices.test.ts` | **new** |
| `packages/gateway/src/budget/budget.lua` | **new**. `reserve`, `settle` and `init` scripts (see Invariants) |
| `packages/gateway/src/budget/redis-ledger.ts` | **new**. Redis path: load scripts, reserve, settle, rebuild from Postgres |
| `packages/gateway/src/budget/pg-ledger.ts` | **new**. Postgres fallback path: reserve and settle in short row-locked transactions |
| `packages/gateway/src/budget/budget.ts` | **new**. Chooses the path (Redis, or Postgres while Redis is down), owns the epoch, writes every settle to Postgres |
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
| `packages/gateway/src/auth/key-store.test.ts`, `packages/gateway/src/auth/plugin.test.ts` | cached tenant carries the cap |
| `bench/budget-tool.ts` | **new**. Creates and measures the flood tenants |
| `bench/run-baseline.sh`, `bench/run-ratelimit.sh` | budgets off in the older benchmarks |
| `bench/k6/budget-flood.js` | **new**. Concurrent flood at a small-cap tenant |
| `bench/run-budget.sh` | **new**. Overhead run (cap high, nothing refused) vs PR 4; flood runs; Redis-down run |
| `bench/results/pr-5/*.json` | **new**; produced by the orchestrator's quiet run (pending) |
| `BENCHMARKS.md` | "Budgets (PR 5)" section |
| `docs/budgets/README.md` | **new**. Reserve-then-settle in plain English, the Lua annotated, failure modes, numbers, interview Qs |
| `docs/budgets/budget-flow.html` | **new**. Archify diagram: reserve → call → settle, the Postgres fallback and the epoch |
| `docs/README.md`, `docs/architecture/*`, `docs/gateway/README.md`, `docs/rate-limiter/README.md` | budgets built; request path updated |
| `docs/diagrams/flows.md` | add the flow lines below |

## Schema

```sql
alter table tenants add column monthly_budget_micros bigint;  -- null = BUDGET_DEFAULT_MONTHLY_USD
create table tenant_spend (
  tenant_id uuid not null references tenants(id) on delete cascade,
  period    char(7) not null,                       -- 'YYYY-MM', UTC
  spent_micros bigint not null default 0,
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
create table budget_reservations (                  -- Postgres fallback path only
  id uuid primary key, tenant_id uuid not null, period char(7) not null,
  amount_micros bigint not null, expires_at timestamptz not null
);
create table budget_epoch (id int primary key check (id = 1), epoch bigint not null);
```

## Invariants

- **Money is integer micro-USD (bigint)**, never floats. Cost =
  `ceil(in × inPrice / 1e6) + ceil(out × outPrice / 1e6)`, rounded up so rounding never favours
  the tenant.
- **Reserve (Redis, one atomic script).** Key `bud:{<tenantId>}:<period>:<epoch>` (hash
  `spent`, `reserved`) and `…:res` (zset id → expiry, plus hash id → amount). The script:
  purges expired reservations from `reserved`; if the hash is missing returns `REBUILD`; if
  `spent + reserved + estimate > cap` returns denied with remaining; else adds the reservation
  and returns allowed. Reservation TTL = `BUDGET_RESERVATION_TTL_S` (covers the longest call),
  so a gateway that crashes mid-request cannot hold money forever.
- **Estimate = worst case:** `costMicros(model, promptEstimate, max_tokens ?? default)` using
  PR 4's `estimate.ts`. Output can't exceed `max_tokens`, so the only overshoot source is a low
  prompt estimate; the benchmark measures it.
- **Settle (one atomic script):** remove the reservation (no-op if already gone, so settle is
  idempotent), `spent += actual`. Actual comes from the PR 4 reconcile hook; no usage seen
  (abort, upstream error) → charge the full reservation and mark `estimated = true`. A request
  refused before the call reserves nothing and settles nothing.
- **Every settle is also written to Postgres** after the response has been sent (off the
  client's path): one transaction inserts `spend_ledger` (on conflict request_id do nothing)
  and adds to `tenant_spend`. Failure → retry 3× with backoff, then log error (queueing is PR 10).
- **Rebuild:** on `REBUILD`, read `tenant_spend.spent_micros` for the period, then an `init`
  script sets `spent` only if the hash is still missing (two instances rebuilding at once
  can't double it), then retry reserve once.
- **Redis down → Postgres path** (no reply within `BUDGET_REDIS_TIMEOUT_MS`): reserve =
  one transaction that locks the `tenant_spend` row (`select … for update`, upserting it
  first), sums unexpired `budget_reservations`, checks the cap, inserts a reservation;
  settle = one transaction deleting the reservation and adding the spend. Locks are held for
  the check only, never across the provider call.
- **Epoch:** an instance that switches to the Postgres path increments `budget_epoch`; every
  instance reads the epoch at start and every `BUDGET_EPOCH_REFRESH_S`. Redis keys include the
  epoch, so after an outage the Redis balance is rebuilt from Postgres rather than trusting a
  balance that missed the fallback-period spend. Old-epoch keys expire.
- **Period** is the UTC calendar month at reserve time; settle charges the reserve's period.
  Redis budget keys expire 35 days after period start.
- **Unknown model (no price):** 400 `{error:{type:"invalid_request_error",code:"model_not_priced"}}`,
  nothing reserved; a budget can't be enforced without a price.
- **402 body:** `{error:{type:"insufficient_quota",code:"budget_exhausted",message:"…"}}`.
  Every budgeted response carries `x-budget-remaining-usd` (after this reservation).
- Order in the request path: auth → rate limit → budget → route → reconcile (limits + budget).

## Tests

`budget/redis-ledger.test.ts` (real Redis, namespaced keys):
- `50 concurrent reserves against a cap that fits 7 worst cases admit exactly 7`
- `settle releases the reservation and charges actual; settled spend never exceeds the cap over 200 randomised concurrent rounds`
- `settle is idempotent`
- `expired reservation is released without a settle`
- `missing balance triggers rebuild from Postgres; two concurrent rebuilds don't double it`
- `period rolls over at the UTC month boundary`

`budget/pg-ledger.test.ts` (worktree Postgres):
- `50 concurrent reserves on the Postgres path admit exactly 7`
- `row lock is not held across the provider call` (reserve returns before the mock answers)

`budget/budget.test.ts`:
- `Redis down switches to Postgres, bumps the epoch and stays within the cap`
- `after Redis recovers, the next reserve rebuilds from Postgres including fallback-period spend`
- `every settle lands in spend_ledger and tenant_spend exactly once`

`budget/plugin.test.ts`:
- `exhausted budget returns 402 with the insufficient_quota body and does not call upstream`
- `unknown model returns 400 model_not_priced`
- `aborted stream is charged its full reservation and marked estimated`
- `x-budget-remaining-usd reflects the reservation`

`pricing/prices.test.ts`: `cost rounds up in micro-USD`. `cli/keys.test.ts`: `set-budget then show-spend`.

## Acceptance proof

1. `npm run db:migrate`; `npm run keys -- set-budget acme --monthly-usd 0.01`.
2. `bash scripts/gate.sh` → PASS (concurrency tests are the cap proof).
3. `bash bench/run-budget.sh` → flood: 50 concurrent × 100 rounds; `bench/results/pr-5/flood.json`
   records max(settled spend / cap) and max overshoot in micro-USD; overhead vs `bench/results/pr-4/`;
   Redis-down run: cap still holds on the Postgres path, latency recorded.
4. curl until refused → 402 (hop: `budget/plugin.ts` → `budget.ts` → `redis-ledger.ts` → `budget.lua`).

## Adversarial

1. Flood across 3 in-process gateway apps sharing Redis and Postgres: settled spend ≤ cap.
2. Kill Redis mid-flood, restart it: cap holds throughout; post-recovery balance equals
   `tenant_spend` (no lost or double charges).
3. Kill a gateway process mid-request: its reservation expires and the money is released.
4. Prompt estimate low (a prompt of multi-byte characters): measure and report the overshoot;
   it must be bounded by in-flight requests × their estimate error.
5. Every figure in BENCHMARKS.md and docs/budgets traces to `bench/results/pr-5/` (R3).

## Data flows

- Budget reserve and settle → `docs/budgets/budget-flow.html` → `packages/gateway/src/budget/*.ts`
- Spend recorded to Postgres → `docs/budgets/budget-flow.html` → `packages/gateway/src/budget/{budget.ts,pg-ledger.ts}`

## Decisions

- **Live balance in Redis, every charge recorded in Postgres, Redis rebuilt from Postgres**
  (founder, D-017).
- **Redis down → Postgres row-lock path** (founder, D-018): spend stays capped while the rate
  limiter fails open.
- **Monthly budgets, UTC calendar month** (founder, D-019).
- **402, not 429:** OpenAI SDKs auto-retry 429; retrying an empty budget is pointless.
- **Micro-USD integers, round up.**
- **Known limit, documented, not fixed here:** during a *partial* outage (some instances on
  Redis, some on Postgres) the two paths can't see each other's reservations, so the cap can be
  exceeded by up to the in-flight worst cases on the minority path. Becomes residual R6, owned
  by PR 12, which measures it under 3 instances.
- **Settled-spend writes happen after the response, in-process with retries;** moving them onto
  the queue is residual R7, owned by PR 10.
- **Prices:** mock models only (`mock-*` → a clearly labelled fictitious price). Real model prices
  are added in PR 6, taken from the providers' published pricing pages with the date recorded.
- **Config rows:** `BUDGET_DEFAULT_MONTHLY_USD=10`, `BUDGET_RESERVATION_TTL_S=300`,
  `BUDGET_REDIS_TIMEOUT_MS=50`, `BUDGET_EPOCH_REFRESH_S=5`, `BUDGET_ENABLED=true`.
- **Docs** (R2): interview Qs incl. "why reserve the worst case?", "why not just check balance > 0?",
  "why integer micro-dollars?", "what happens if Redis dies mid-month?", "what's the epoch for?",
  "where can the cap still be broken, and by how much?".

## Notes from the build

- The plan predates PR 4 as merged: the reconcile point is `request.rateLimit.settle` called from `routes/chat.ts`, not an
  onResponse hook. Budget settle follows the same refund/keep rules through `usage/settle.ts`.
- Settle is idempotent per request id through a short-lived `done` key in Redis, so a settle that arrives after its
  reservation lapsed still charges, and a repeat never does.
- Redis-path settle writes Postgres first, then Redis; a failed Redis settle moves the budget to the Postgres path and bumps the epoch.
- Budget unreachable on both stores: `503 budget_unavailable` (fail closed). The plan did not say.
- A request refused by the budget (402, 400 model_not_priced, 503) returns the tokens the limiter had taken.
