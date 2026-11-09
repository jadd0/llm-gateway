import { inArray } from 'drizzle-orm';
import type { Redis } from 'ioredis';
import { applySettled, type AppliedSettle } from '../../gateway/src/budget/redis-ledger.ts';
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

// <prefix>bud:{<tenant>}:<period>:<epoch>:res
const RES_KEY = /bud:\{([^}]+)\}:(\d{4}-\d{2}):\d+:res$/;

/**
 * Settles Redis holds Postgres has already decided. A Redis hold that is past its expiry by `graceMs` and has no
 * Postgres hold row is one of two things: a request whose charge Postgres took (the worker applied it, or the
 * sweeper charged its estimate) while Redis never heard, or a phantom (a rebuild imported a hold for a request
 * Postgres then refused). The first is released and charged what Postgres charged; the second is released. A
 * hold in a balance means that balance has not charged the request, so adding the ledger's cost cannot count it
 * twice (see budget.lua). Run on the sweep timer; a balance with nothing old in it costs one ZRANGEBYSCORE.
 */
export async function reconcileHolds(o: ReconcileOptions): Promise<ReconcileResult> {
  const now = (o.now ?? Date.now)();
  const result: ReconcileResult = { dropped: 0, charged: 0 };
  const apply: AppliedSettle[] = [];
  let cursor = '0';
  do {
    const [next, keys] = await o.redis.scan(cursor, 'MATCH', `${o.keyPrefix}bud:{*}:*:${o.epoch}:res`, 'COUNT', 200);
    cursor = next;
    for (const key of keys) {
      const m = RES_KEY.exec(key);
      if (!m) continue;
      const [, tenantId, period] = m as unknown as [string, string, string];
      const ids = await o.redis.zrangebyscore(key, '-inf', now - o.graceMs, 'LIMIT', 0, o.limit ?? 500);
      if (ids.length === 0) continue;
      const held = new Set((await o.db.select({ id: budgetReservations.id }).from(budgetReservations).where(inArray(budgetReservations.id, ids))).map((r) => r.id));
      const gone = ids.filter((id) => !held.has(id));
      if (gone.length === 0) continue;
      const ledger = new Map(
        (await o.db.select({ id: spendLedger.requestId, cost: spendLedger.costMicros }).from(spendLedger).where(inArray(spendLedger.requestId, gone))).map((r) => [r.id, r.cost]),
      );
      for (const id of gone) {
        const cost = ledger.get(id) ?? 0;
        if (ledger.has(id) && cost > 0) result.charged++;
        else result.dropped++;
        apply.push({ tenantId, period, id, costMicros: cost });
      }
    }
  } while (cursor !== '0');
  if (apply.length > 0) await applySettled(o.redis, o.keyPrefix, o.epoch, apply, o.timeoutMs);
  return result;
}
