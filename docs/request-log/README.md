# Request log

Every request gets one row in `request_log`: who (tenant, key), which model asked and which served, provider, status,
error code, streamed or not, tokens, cost and what a cache hit saved (micro-USD), cache result, attempts and whether a
fallback was used, and three timings (total, first byte, time spent upstream). Diagram: [request-log.html](request-log.html).

**No prompt or completion text, ever.** The entry format is a fixed list of typed fields (ids, names, counts, money,
timings); a value that is not the right type does not parse. The log is for operations and billing.

## How it gets there

1. **Collector** (`requestlog/collector.ts`). The first hook of the app starts the clock, so a refused request (401, 429,
   402) is logged too. The route and the plugins add what they know (model, provider, tokens, cost). When the response
   closes, one function (`classifyClose`) decides who ended it: finished, the client left, or the upstream broke. A client
   that leaves is recorded as `client_closed`, not as an upstream failure.
2. **Sink** (`requestlog/sink.ts`). One `XADD` to the Redis stream `{prefix}requestlog`, after the response, off the request
   path, with `MAXLEN ~ LOG_STREAM_MAX` (default 1,000,000) so a stopped worker cannot fill Redis: past the cap the oldest log
   entries go first, and the worker warns at 80%. Spend entries are in their own stream, `{prefix}requestlog:spend`, which is never capped (an entry there is money and leaves only once Postgres has it). While Redis is away entries wait in a bounded in-memory buffer (`LOG_BUFFER_MAX`), in order, and are sent when it
   returns; past the bound they are dropped and counted. On shutdown the buffer is flushed before Redis is released.
3. **Log worker** (`packages/log-worker`, `npm run worker`). A consumer group reads both streams in batches of at most `LOG_BATCH_SIZE` (at least 2; spend entries are read first and the
   log stream fills the rest; waiting at most `LOG_BATCH_WAIT_MS`), writes each batch in **one Postgres transaction**, and only then acknowledges it. An entry
   another worker read and never acknowledged is taken over after `LOG_CLAIM_IDLE_MS`; one delivered more than
   `LOG_MAX_DELIVERIES` times moves to `{prefix}requestlog:dead` so it cannot block the stream. Each stream is trimmed, on an interval, below the
   oldest pending entry, never past it.

## Rollups for the dashboard

The same transaction also adds the batch's counts to the rollup tables, from the log rows the insert actually wrote, so a redelivered entry adds
nothing. The worker's sweep timer folds finished hours from minute to hour rollups (`ROLLUP_FOLD_AFTER_MIN`) and trims folded minutes (`ROLLUP_MINUTE_RETENTION_H`).
Details: [../dashboard/README.md](../dashboard/README.md).

## At-least-once, made safe

An entry can arrive twice (the worker wrote it and died before acknowledging). Every write is idempotent: `request_log`
and `spend_ledger` insert with `ON CONFLICT DO NOTHING` on the request id, and `tenant_spend` grows only by the ledger
rows that were really inserted. A redelivered batch changes nothing.

## Spend goes through the same stream

The Redis settle script (`budget/budget.lua`) appends the spend entry **and** moves the live balance in one call, so a
crash cannot leave one without the other. The worker writes the ledger, adds to `tenant_spend`, drops the hold row, and
then catches the live balances up. If Redis was flushed while an entry was queued, the rebuilt balance still counts that
request's hold at its estimate (never less than the real charge) until the worker has applied it. A hold that lapses with
no settle at all is charged its estimate by the worker's sweeper, on a timer of its own (`LOG_SWEEP_S`) whether or not the
stream is busy, and only once the hold has been lapsed for `LOG_SWEEP_GRACE_S` so that a settle queued before it lapsed has
been applied first (set the grace above your worst worker lag; a settle later than that is overtaken by the estimate, which is
never less than the real cost). The sweep also waits while the spend stream has entries the group has not read or not
acknowledged, so a worker that is behind never has the estimate charged ahead of a settle it is about to apply; if a settle
still arrives after its estimate was charged (it was queued just after the check), applying it replaces the estimate with the
real cost in the ledger and moves `tenant_spend` by the difference, in the same transaction, and a refund removes the charge.
The live balances follow: each remembers the requests it counted at their estimate (`:est`) and takes the same difference
once, while a balance that took the real settle itself has no such entry and ignores it, so Redis and Postgres end equal.
The worker reads the budget epoch from Postgres for every batch it catches up and every sweep, never from a cache. The same timer reconciles Redis against Postgres: a Redis hold more than
`BUDGET_ORPHAN_GRACE_S` past its expiry with no Postgres hold row is released, and charged what Postgres charged if it has a
ledger row. Reconcile finds the live balances in a Redis sorted set the gateway keeps (`{prefix}bud:index`, a member per
balance, scored by the time it expires and added when the balance is built), not by scanning the keyspace. While Redis is down, settles are written to Postgres directly, as before. Details: [../budgets/README.md](../budgets/README.md).

## Shutdown

The gateway on SIGTERM stops accepting, lets requests finish, sends the entries still in memory, then exits. The worker
on SIGTERM stops reading, writes and acknowledges the batch in hand, then exits.

## Measured

At 200 req/s with a realistic mock, inline and stream modes both had 0 failures in 35905 requests and differ by
under 1 ms at p95 (403.4 against 403.1 ms); the worker stayed at most 2 entries behind ([../../BENCHMARKS.md](../../BENCHMARKS.md)).

## Settings

`LOG_MODE` (`stream`; `inline` exists only as the benchmark's "before"), `LOG_GROUP`, `LOG_BATCH_SIZE`, `LOG_BATCH_WAIT_MS`,
`LOG_CLAIM_IDLE_MS`, `LOG_MAX_DELIVERIES`, `LOG_BUFFER_MAX`, `LOG_SWEEP_S`, `LOG_SWEEP_GRACE_S`, `LOG_STREAM_MAX`,
`BUDGET_ORPHAN_GRACE_S`, `WORKER_CONSUMER`: see `.env.example`.

Redis Cluster is not supported: the settle script writes the spend stream and the tenant's balance in one call, and the
stream is not in the tenant's hash slot. The gateway and the worker check `INFO cluster` at start and refuse a cluster. A single Redis (or a primary with replicas) is the supported shape.
Redis runs with an append-only file (`appendfsync everysec`) so the queue survives a restart; at worst about a second of
entries is lost, and the sweeper covers any settle among them.

## Upgrading from a build with one stream

Spend entries used to share the capped request-log stream. Nothing running has that layout, but a deployment that does must
drain its worker before switching: during a mixed deploy the old stream's `MAXLEN ~` trimming can drop a spend entry that was
queued there and not yet applied. After the drain nothing is left in the old layout.
