import { readFileSync } from 'node:fs';
import type { Redis } from 'ioredis';
import { periodExpiryS, type Period } from './period.ts';

// budget.lua holds three scripts, split on its "@script" markers.
const SCRIPTS = Object.fromEntries(
  readFileSync(new URL('./budget.lua', import.meta.url), 'utf8')
    .split(/^-- @script (\w+)\n/m)
    .slice(1)
    .reduce<Array<[string, string]>>((acc, part, i, all) => (i % 2 === 0 ? [...acc, [part, all[i + 1]!]] : acc), []),
) as Record<'reserve' | 'settle' | 'init', string>;

export interface ReserveArgs {
  tenantId: string;
  period: Period;
  epoch: number;
  /** Unique per request; reserving the same id twice holds the money once. */
  id: string;
  /** Worst-case cost of the call, micro-USD. */
  estimate: number;
  /** The tenant's cap for the period, micro-USD. */
  cap: number;
  /** How long the hold lasts if never settled. */
  ttlMs: number;
}

export interface ReserveResult {
  allowed: boolean;
  /** Micro-USD left after this reservation (allowed) or before it (refused). */
  remaining: number;
}

export interface SettleArgs {
  tenantId: string;
  period: Period;
  /** The epoch in force now, whatever epoch the request reserved under. */
  epoch: number;
  id: string;
  /**
   * 0 releases the hold and charges nothing. Otherwise the tenant_spend.charges value right after this
   * request's charge was recorded in Postgres, with `spentAfter` the spent_micros then.
   */
  charges: number;
  spentAfter: number;
}

/** What Postgres knows about a tenant's month: the record a lost balance is rebuilt from. */
export interface Snapshot {
  spent: number;
  charges: number;
  /** Every unexpired hold, with the time it has left. */
  holds: Array<{ id: string; amount: number; ttlMs: number }>;
}

/** `changed`: the hold was released or the spend moved. `unchanged`: nothing to do. `rebuild`: the balance is gone. */
export type SettleResult = 'changed' | 'unchanged' | 'rebuild';

export interface RedisLedger {
  /** Throws when Redis does not answer in time or fails. */
  reserve(args: ReserveArgs): Promise<ReserveResult>;
  /** Throws when Redis does not answer in time or fails. Safe to repeat and to reorder. */
  settle(args: SettleArgs): Promise<SettleResult>;
  /** Resolves if Redis answers a PING in time. */
  ping(): Promise<void>;
}

export interface RedisLedgerOptions {
  redis: Redis;
  keyPrefix: string;
  /** A Redis answer slower than this is an outage for that call. */
  timeoutMs: number;
  /** Postgres's view of the tenant's period, read in one consistent snapshot. */
  loadSnapshot(tenantId: string, period: Period): Promise<Snapshot>;
  /** Pins the clock the scripts use, in ms. Production leaves it unset so they read Redis TIME. */
  clock?: () => number;
}

type Commands = Redis & {
  budReserve(...args: Array<string | number>): Promise<number[]>;
  budSettle(...args: Array<string | number>): Promise<number[]>;
  budInit(...args: Array<string | number>): Promise<number>;
};

export class RedisTimeout extends Error {
  override name = 'RedisTimeout';
}

export function createRedisLedger(opts: RedisLedgerOptions): RedisLedger {
  const { redis, keyPrefix, timeoutMs, loadSnapshot, clock } = opts;
  redis.defineCommand('budReserve', { numberOfKeys: 3, lua: SCRIPTS.reserve });
  redis.defineCommand('budSettle', { numberOfKeys: 3, lua: SCRIPTS.settle });
  redis.defineCommand('budInit', { numberOfKeys: 3, lua: SCRIPTS.init });
  const cmd = redis as Commands;

  // The hash tag {tenantId} puts every key of a tenant's month in one Redis Cluster slot.
  const keys = (tenantId: string, period: Period, epoch: number) => {
    const b = `${keyPrefix}bud:{${tenantId}}:${period}:${epoch}`;
    return [b, `${b}:res`, `${b}:amt`] as const;
  };

  const withTimeout = <T>(p: Promise<T>): Promise<T> =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new RedisTimeout('no reply in time')), timeoutMs);
      p.then(
        (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        (e: unknown) => {
          clearTimeout(timer);
          reject(e);
        },
      );
    });

  const reserveOnce = async (a: ReserveArgs): Promise<[number, number]> => {
    const r = await withTimeout(
      cmd.budReserve(...keys(a.tenantId, a.period, a.epoch), a.id, a.estimate, a.cap, a.ttlMs, clock ? clock() : '', periodExpiryS(a.period)),
    );
    return [r[0]!, r[1]!];
  };

  return {
    async reserve(a) {
      let [status, remaining] = await reserveOnce(a);
      if (status === -1) {
        // The balance is missing (first request of the month, an epoch change, a flush or an
        // eviction). Rebuild it from Postgres, holds included. init creates it only if it is still
        // missing, so two instances rebuilding at once cannot add anything twice.
        const snap = await loadSnapshot(a.tenantId, a.period);
        const holds = snap.holds.flatMap((h) => [h.id, h.amount, h.ttlMs]);
        await withTimeout(
          cmd.budInit(...keys(a.tenantId, a.period, a.epoch), snap.spent, snap.charges, periodExpiryS(a.period), clock ? clock() : '', ...holds),
        );
        [status, remaining] = await reserveOnce(a);
        if (status === -1) throw new Error('budget balance missing after rebuild');
      }
      return { allowed: status === 1, remaining };
    },

    async settle(a) {
      const r = await withTimeout(cmd.budSettle(...keys(a.tenantId, a.period, a.epoch), a.id, a.charges, a.spentAfter));
      if (r[0] === -1) return 'rebuild';
      return r[0] === 1 ? 'changed' : 'unchanged';
    },

    async ping() {
      await withTimeout(redis.ping());
    },
  };
}
