# Dashboard

A read-only admin page: p50 and p95 latency, spend by tenant, cache hit rate and error rate over time, totals for the range, and the
last 50 failed requests. Ranges: 1 hour, 24 hours, 7 days, 30 days. Diagram: [rollups.html](rollups.html). Screens for sign-off:
[screens/](screens/) (login and overview, 1280 and 390 wide, light and dark).

Deploy order when the log already has history: **stop the old log worker, run `npm run db:migrate`, start the new worker**. The backfill
covers the rows in the log when the migration runs; a worker still running the old code would write log rows the new rollups never
see, and one started before the migration finishes would write rollups the backfill then counts again.

Run it: set `DASHBOARD_TOKEN`, `DASHBOARD_SESSION_SECRET` and `DASHBOARD_DATABASE_URL` (see `.env.example`), run `npm run db:migrate`
(it creates the read-only login named in the URL), then `npm run dashboard` and open `http://localhost:3200`.

## Why rollups

A chart over the raw log reads every row in its range, so it gets slower as the log grows. The log worker therefore also keeps
**rollups**: one row per minute (recent) or hour (history) holding counts, spend and a latency histogram. A chart reads buckets, not
requests. `npm run bench:dashboard` measures this: each dashboard query on the rollups against the same answer computed from the raw
log, at 10k to 5M log rows. At 5M rows the 30-day overview takes 23.5 ms on the rollups against 2708 ms from the raw log, with the same
counts and spend ([../../BENCHMARKS.md](../../BENCHMARKS.md)).

## How the rollups are written

The worker adds a batch's counts to the rollups **in the same transaction** as the log rows, and only from the rows the insert actually
wrote (`ON CONFLICT DO NOTHING ... RETURNING`). A redelivered entry inserts nothing, so it adds nothing, and a crash loses rows and
counts together. Four tables: minute and hour, each per tenant and model (who spent what) and as totals (the time series and the
percentiles, one row per bucket). One row, `rollup_state`, holds the **fold mark**: once an hour is 90 minutes old
(`ROLLUP_FOLD_AFTER_MIN`) the worker adds its minutes to the hour tables and moves the mark past it; folded minutes older than 48
hours (`ROLLUP_MINUTE_RETENTION_H`) are deleted, unfolded ones never. The fold holds a row lock on the mark that every batch takes
shared, so a request is counted once in the hour tables whatever the timing. A row that arrives after its hour was folded goes straight
to the hour tables (and, if within a day of the mark, to the minute tables for the minute-grain views).

The migration **backfills** from the existing log: it sets the fold mark where a worker would have it, writes the hour tables from
every log row before the mark and the minute tables from the day before it on, with the worker's own latency buckets, so a log that
already has history shows in every range from the first start. A test runs the migration over a seeded log and compares every range with
the raw aggregate.

## Percentiles from histograms

Latency is stored as counts in 242 fixed buckets: 0 to 1 ms, then each bucket's upper bound 5% above the last, up to about 122 s, and one
open-ended bucket above that. The p50 and p95 of any range are read from the **sum** of its histograms, never from averaging stored
percentiles (the p95 of two halves is not their mean). The reading is the upper bound of the bucket holding the rank, so it is at or
above the exact value and within one bucket (5%) of it; requests slower than the last bound all read as that bound. The buckets are
fixed in code: changing them would invalidate every stored histogram.

## What the page reads

Up to 24 hours: the minute tables. Longer: the hour tables plus the minutes not yet folded. Spend by tenant reads the per-tenant tables,
the series and percentiles the totals tables. The last-failures table reads `request_log` through a partial index on error rows. An
error is a status of 500 or more, or a stream that broke after a 200; a client that left (499) and 4xx refusals are not errors. Cache hit
rate is exact plus semantic hits over all requests. A request with no tenant is "Unauthenticated"; a tenant id whose row was deleted shows as
"Deleted tenant" with the start of its id. Ranges start on a boundary of their step (a minute, 15 minutes, an hour, 6 hours), so the first point is a whole step.

## Read-only role and login

The page connects as a Postgres role that can read the rollup tables, tenant ids and names, and seven columns of `request_log`
(request id, time, tenant, model, status, error code, latency): not the ledger, keys, holds or any other column. A test asks the database
for each refusal. `db:migrate` creates the login, or resets the password of one that already is a pure dashboard login; it refuses (changing nothing) any other existing role: the migrating user, one with a role attribute, memberships, grants or owned objects. The pool is `DASHBOARD_DB_POOL_MAX` connections (default 10; a page load holds three). Login is one admin token (`DASHBOARD_TOKEN`, at least 32 characters, compared in constant time) posted in a form body;
the cookie holds an HMAC, keyed with `DASHBOARD_SESSION_SECRET`, of its issue time and the token, is HttpOnly and SameSite=Strict
(Secure in production), and expires after 12 hours. Every route but the login checks it in the proxy and again in the page. Without a
valid token and secret the server refuses to start. No prompts, responses or keys appear on any screen.

## Versions

Exact current-stable releases, checked against the npm registry on 2026-11-09: Next.js 16.4.6, React 19.3.1, Recharts 3.10.1 (plus
`pg` 8.23.1 for Postgres). No other UI dependency. Next.js 16 calls its request guard `proxy.ts` (it was `middleware.ts`) and runs it on Node.
Recharts draws in the browser, so a chart's server-rendered markup is its frame and a data table; each chart has that table under it.
