import type { Redis } from 'ioredis';
import type { Db } from '../src/db/client.ts';
import { applySpendBatch, createPgLedger } from '../src/budget/pg-ledger.ts';
import { applySettled } from '../src/budget/redis-ledger.ts';
import { fromStreamFields, spendKey, type SpendEntry } from '../src/requestlog/entry.ts';

// Stands in for the log worker in the gateway's own tests: applies every spend entry now in the stream to
// Postgres with the same function the worker uses, catches the live balances up, and removes what it applied.
// The real worker (batching, acks, redelivery, shutdown) is tested in packages/log-worker.
export async function drainSpend(db: Db['db'], redis: Redis, keyPrefix: string): Promise<number> {
  const key = spendKey(keyPrefix);
  const rows = await redis.xrange(key, '-', '+');
  const spend: SpendEntry[] = [];
  for (const [, fields] of rows) {
    const e = fromStreamFields(fields);
    if (e.kind === 'spend') spend.push(e.entry);
  }
  if (spend.length === 0) return 0;
  const settled = await db.transaction(async (tx) => (await applySpendBatch(tx, spend)).settled);
  await applySettled(redis, keyPrefix, await createPgLedger(db).readEpoch(), settled, 5000);
  await redis.xdel(key, ...rows.filter(([, f]) => fromStreamFields(f).kind === 'spend').map(([id]) => id));
  return spend.length;
}

// A timer that drains a few times a second, for route tests that wait on the ledger: returns the stop function.
export function standInWorker(db: Db['db'], redis: Redis, keyPrefix: string): () => void {
  let draining = false;
  const timer = setInterval(() => {
    if (draining) return;
    draining = true;
    void drainSpend(db, redis, keyPrefix).catch(() => {}).finally(() => (draining = false));
  }, 15);
  timer.unref();
  return () => clearInterval(timer);
}
