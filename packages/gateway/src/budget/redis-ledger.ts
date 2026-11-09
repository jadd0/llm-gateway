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
  epoch: number;
  id: string;
  /** Micro-USD to add to spend; 0 releases the hold without a charge. */
  actual: number;
}

/** `applied`: the hold was released and the charge added. `duplicate`: this id was settled before. `rebuild`: the balance is gone. */
export type SettleResult = 'applied' | 'duplicate' | 'rebuild';

export interface RedisLedger {
  /** Throws when Redis does not answer in time or fails. */
  reserve(args: ReserveArgs): Promise<ReserveResult>;
  /** Throws when Redis does not answer in time or fails. */
  settle(args: SettleArgs): Promise<SettleResult>;
}

export interface RedisLedgerOptions {
  redis: Redis;
  keyPrefix: string;
  /** A Redis answer slower than this is an outage for that call. */
  timeoutMs: number;
  /** Settled spend for the period as Postgres has it: what a lost balance is rebuilt from. */
  loadSpent(tenantId: string, period: Period): Promise<number>;
  /** How long a settled id is remembered so a repeat settle is a no-op. */
  doneTtlS: number;
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
  const { redis, keyPrefix, timeoutMs, loadSpent, clock } = opts;
  redis.defineCommand('budReserve', { numberOfKeys: 3, lua: SCRIPTS.reserve });
  redis.defineCommand('budSettle', { numberOfKeys: 4, lua: SCRIPTS.settle });
  redis.defineCommand('budInit', { numberOfKeys: 1, lua: SCRIPTS.init });
  const cmd = redis as Commands;

  // The hash tag {tenantId} puts every key of a tenant's month in one Redis Cluster slot.
  const base = (tenantId: string, period: Period, epoch: number) => `${keyPrefix}bud:{${tenantId}}:${period}:${epoch}`;

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
    const b = base(a.tenantId, a.period, a.epoch);
    const r = await withTimeout(
      cmd.budReserve(`${b}`, `${b}:res`, `${b}:amt`, a.id, a.estimate, a.cap, a.ttlMs, clock ? clock() : '', periodExpiryS(a.period)),
    );
    return [r[0]!, r[1]!];
  };

  return {
    async reserve(a) {
      let [status, remaining] = await reserveOnce(a);
      if (status === -1) {
        // The balance is missing (first request of the month, an epoch change, a flush or an
        // eviction). Rebuild it from Postgres. init creates it only if it is still missing, so two
        // instances rebuilding at once cannot add the spend twice.
        const spent = await loadSpent(a.tenantId, a.period);
        await withTimeout(cmd.budInit(base(a.tenantId, a.period, a.epoch), spent, periodExpiryS(a.period)));
        [status, remaining] = await reserveOnce(a);
        if (status === -1) throw new Error('budget balance missing after rebuild');
      }
      return { allowed: status === 1, remaining };
    },

    async settle(a) {
      const b = base(a.tenantId, a.period, a.epoch);
      const r = await withTimeout(
        cmd.budSettle(`${b}`, `${b}:res`, `${b}:amt`, `${b}:done:${a.id}`, a.id, a.actual, opts.doneTtlS),
      );
      if (r[0] === -1) return 'rebuild';
      return r[0] === 1 ? 'applied' : 'duplicate';
    },
  };
}
