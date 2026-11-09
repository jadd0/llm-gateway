import { inArray } from 'drizzle-orm';
import type { Redis } from 'ioredis';
import { applySettled, indexKey, type AppliedSettle } from '../../gateway/src/budget/redis-ledger.ts';
import type { Db } from '../../gateway/src/db/client.ts';
import { budgetReservations, spendLedger } from '../../gateway/src/db/schema.ts';

export interface ReconcileOptions {
  db: Db['db'];
  redis: Redis;
  keyPrefix: string;
  epoch: number;
  /** A Redis hold is looked at only once it is this far past its expiry. */
  graceMs: number;
  timeoutMs: number;
  /** Holds looked at per balance per pass. */
  limit?: number;
  now?: () => number;
}

export interface ReconcileResult {
  /** Holds dropped: Redis had them, Postgres has neither the hold row nor a charge for them. */
  dropped: number;
  /** Holds released and charged: Postgres has the charge, Redis never took it. */
  charged: number;
}

// <prefix>bud:{<tenant>}:<period>:<epoch>
const BALANCE_KEY = /bud:\{([^}]+)\}:(\d{4}-\d{2}):(\d+)$/;
const CHUNK = 500;

const chunks = <T>(xs: T[], n: number): T[][] => Array.from({ length: Math.ceil(xs.length / n) }, (_, i) => xs.slice(i * n, (i + 1) * n));

/**
 * Settles Redis holds Postgres has already decided. A Redis hold that is past its expiry by `graceMs` and has no
 * Postgres hold row is one of two things: a request whose charge Postgres took (the worker applied it, or the
 * sweeper charged its estimate) while Redis never heard, or a phantom (a rebuild imported a hold for a request
 * Postgres then refused). The first is released and charged what Postgres charged; the second is released. A
 * hold in a balance means that balance has not charged the request, so adding the ledger's cost cannot count it
 * twice (see budget.lua). Run on the sweep timer. The balances come from the index the gateway keeps (see
 * `indexKey`), never from a scan of the keyspace; the hold lists are read in pipelines and the Postgres checks
 * are one query per few hundred holds, not one per balance.
 */
export async function reconcileHolds(o: ReconcileOptions): Promise<ReconcileResult> {
  const now = (o.now ?? Date.now)();
  const result: ReconcileResult = { dropped: 0, charged: 0 };
  const index = indexKey(o.keyPrefix);
  await o.redis.zremrangebyscore(index, '-inf', String(Math.floor(now / 1000))); // balances past their expiry
  const balances: Array<{ key: string; tenantId: string; period: string }> = [];
  for (const key of await o.redis.zrange(index, '0', '-1')) {
    const m = BALANCE_KEY.exec(key);
    if (m && Number(m[3]) === o.epoch) balances.push({ key, tenantId: m[1]!, period: m[2]! });
  }

  // Every old hold, with the balance it was found in.
  const old: Array<{ id: string; tenantId: string; period: string }> = [];
  for (const group of chunks(balances, CHUNK)) {
    const pipe = o.redis.pipeline();
    for (const b of group) pipe.zrangebyscore(`${b.key}:res`, '-inf', String(now - o.graceMs), 'LIMIT', 0, o.limit ?? 500);
    const res = await pipe.exec();
    group.forEach((b, i) => {
      for (const id of (res?.[i]?.[1] as string[] | undefined) ?? []) old.push({ id, tenantId: b.tenantId, period: b.period });
    });
  }

  const apply: AppliedSettle[] = [];
  for (const group of chunks(old, CHUNK)) {
    const ids = group.map((h) => h.id);
    const held = new Set((await o.db.select({ id: budgetReservations.id }).from(budgetReservations).where(inArray(budgetReservations.id, ids))).map((r) => r.id));
    const gone = group.filter((h) => !held.has(h.id));
    if (gone.length === 0) continue;
    const ledger = new Map(
      (
        await o.db
          .select({ id: spendLedger.requestId, cost: spendLedger.costMicros, estimated: spendLedger.estimated })
          .from(spendLedger)
          .where(inArray(spendLedger.requestId, gone.map((h) => h.id)))
      ).map((r) => [r.id, r]),
    );
    for (const h of gone) {
      const row = ledger.get(h.id);
      if (row && row.cost > 0) result.charged++;
      else result.dropped++;
      apply.push({ tenantId: h.tenantId, period: h.period, id: h.id, costMicros: row?.cost ?? 0, estimated: row?.estimated ?? false });
    }
  }
  if (apply.length > 0) await applySettled(o.redis, o.keyPrefix, o.epoch, apply, o.timeoutMs);
  return result;
}
