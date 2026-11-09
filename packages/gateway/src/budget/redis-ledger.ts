import { readFileSync } from 'node:fs';
import type { Redis } from 'ioredis';
import { spendKey, toSpendFields, type SpendEntry } from '../requestlog/entry.ts';
import { periodExpiryS, type Period } from './period.ts';

// budget.lua holds five scripts, split on its "@script" markers.
const SCRIPTS = Object.fromEntries(
  readFileSync(new URL('./budget.lua', import.meta.url), 'utf8')
    .split(/^-- @script (\w+)\n/m)
    .slice(1)
    .reduce<Array<[string, string]>>((acc, part, i, all) => (i % 2 === 0 ? [...acc, [part, all[i + 1]!]] : acc), []),
) as Record<'reserve' | 'settle' | 'release' | 'apply' | 'init', string>;

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
  /** What the log worker will write to the ledger. Queued in the same script that moves the balance. */
  entry: SpendEntry;
}

/** One settle the worker has written to Postgres, to catch the live balance up with. */
export interface AppliedSettle {
  tenantId: string;
  period: Period;
  id: string;
  costMicros: number;
  /** True for a charge the sweeper made at the hold's estimate: the balance remembers it, to correct it if the real cost arrives. */
  estimated?: boolean;
}

/** What Postgres knows about a tenant's month: the record a lost balance is rebuilt from. */
export interface Snapshot {
  spent: number;
  /** How many charges `spent` includes (tenant_spend.charges). Informational: the balance does not use it. */
  charges: number;
  /** Every hold row, lapsed ones too (negative time left): a lapsed hold may still have a settle queued, and is charged by the worker's sweeper, not forgotten. */
  holds: Array<{ id: string; amount: number; ttlMs: number }>;
  /** Charges made at their estimate: a balance rebuilt from this counts them, and corrects them if the real cost arrives. */
  estimated: Array<{ id: string; cost: number }>;
}

/** `changed`: the hold was released or the spend moved. `unchanged`: nothing to do. `rebuild`: the balance is gone. */
export type SettleResult = 'changed' | 'unchanged' | 'rebuild';

export interface RedisLedger {
  /** Throws when Redis does not answer in time or fails. */
  reserve(args: ReserveArgs): Promise<ReserveResult>;
  /** Queues the settle for the log worker and moves the balance, in one script. Throws when Redis does not answer in time or fails. */
  settle(args: SettleArgs): Promise<SettleResult>;
  /** Catches the balance up with settles Postgres now has (see `applySettled`). Throws when Redis does not answer in time or fails. */
  apply(epoch: number, settled: AppliedSettle[]): Promise<SettleResult>;
  /** Queues a cache hit's ledger row. Throws when Redis does not answer in time or fails. */
  enqueue(entry: SpendEntry): Promise<void>;
  /** Releases a hold by id if the balance has it. Queues and charges nothing. Best effort and idempotent; never throws. */
  release(tenantId: string, period: Period, epoch: number, id: string): Promise<void>;
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
  /** Called when a reserve finds the balance missing, before it is rebuilt. */
  onRebuild?: (a: { tenantId: string; period: Period; epoch: number }) => void;
  /** Pins the clock the scripts use, in ms. Production leaves it unset so they read Redis TIME. */
  clock?: () => number;
}

type Commands = Redis & {
  budReserve(...args: Array<string | number>): Promise<number[]>;
  budSettle(...args: Array<string | number>): Promise<number[]>;
  budRelease(...args: Array<string | number>): Promise<number>;
  budApply(...args: Array<string | number>): Promise<number>;
  budInit(...args: Array<string | number>): Promise<number>;
};

/**
 * Catches live balances up with settles the log worker has written to Postgres: each pair releases that
 * request's hold and adds its cost, only where the balance still holds it. Used by the gateway (after a direct
 * Postgres settle) and by the worker (after each batch). Returns how many pairs changed a balance. Throws when
 * Redis fails. A balance that is missing is left alone: its rebuild reads Postgres, which has the settle.
 */
export async function applySettled(redis: Redis, keyPrefix: string, epoch: number, settled: AppliedSettle[], timeoutMs: number): Promise<number> {
  const c = commandsOf(redis);
  const groups = new Map<string, { tenantId: string; period: Period; args: Array<string | number> }>();
  for (const s of settled) {
    const g = groups.get(`${s.tenantId}|${s.period}`) ?? { tenantId: s.tenantId, period: s.period, args: [] };
    g.args.push(s.id, s.costMicros, s.estimated ? 1 : 0);
    groups.set(`${s.tenantId}|${s.period}`, g);
  }
  let changed = 0;
  for (const g of groups.values()) {
    const b = balanceKey(keyPrefix, g.tenantId, g.period, epoch);
    const r = await withTimeout(c.budApply(b, `${b}:res`, `${b}:amt`, `${b}:est`, ...g.args), timeoutMs);
    if (r > 0) changed += r;
  }
  return changed;
}

/**
 * The zset of live balance keys, scored by the unix second each expires. The worker's reconcile walks it instead of
 * scanning the keyspace; a balance adds itself when it is built, and members past their score are dropped.
 */
export const indexKey = (keyPrefix: string): string => `${keyPrefix}bud:index`;

/** The key of a tenant's balance for a month. Its hold zset is `<key>:res`, its hold amounts `<key>:amt` and its estimated charges `<key>:est`. The tag {tenantId} keeps them in one slot. */
export const balanceKey = (keyPrefix: string, tenantId: string, period: string, epoch: number): string =>
  `${keyPrefix}bud:{${tenantId}}:${period}:${epoch}`;

/**
 * Refuses a Redis Cluster. The settle script writes the spend stream and the tenant's balance in one call, and
 * the stream key is not in the tenant's hash slot, so on a cluster the call fails with CROSSSLOT. Budgets support a
 * single Redis (or a primary with replicas). Throws when the server reports cluster mode; a Redis that does not
 * answer is not a reason to refuse to start (budgets fall back to Postgres while it is away).
 */
export async function assertNotCluster(redis: Redis): Promise<void> {
  const info = await redis.info('cluster').catch(() => '');
  if (/^cluster_enabled:1\s*$/m.test(info)) {
    throw new Error('Redis Cluster is not supported: the budget settle script writes the spend stream and the balance in one call (see docs/budgets/README.md)');
  }
}

// Defines the scripts on the client once; asking again for a client that has them changes nothing.
function commandsOf(redis: Redis): Commands {
  const c = redis as Partial<Commands> & Redis;
  if (!c.budReserve) {
    redis.defineCommand('budReserve', { numberOfKeys: 3, lua: SCRIPTS.reserve });
    redis.defineCommand('budSettle', { numberOfKeys: 5, lua: SCRIPTS.settle });
    redis.defineCommand('budRelease', { numberOfKeys: 3, lua: SCRIPTS.release });
    redis.defineCommand('budApply', { numberOfKeys: 4, lua: SCRIPTS.apply });
    redis.defineCommand('budInit', { numberOfKeys: 5, lua: SCRIPTS.init });
  }
  return redis as Commands;
}

function withTimeout<T>(p: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise((resolve, reject) => {
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
}

export class RedisTimeout extends Error {
  override name = 'RedisTimeout';
}

export function createRedisLedger(opts: RedisLedgerOptions): RedisLedger {
  const { redis, keyPrefix, timeoutMs, loadSnapshot, clock, onRebuild } = opts;
  const cmd = commandsOf(redis);

  // The hash tag {tenantId} puts every key of a tenant's month in one Redis Cluster slot.
  const keys = (tenantId: string, period: Period, epoch: number) => {
    const b = balanceKey(keyPrefix, tenantId, period, epoch);
    return [b, `${b}:res`, `${b}:amt`] as const;
  };
  const estKey = (k: readonly [string, string, string]) => `${k[0]}:est`;

  const within = <T>(p: Promise<T>): Promise<T> => withTimeout(p, timeoutMs);

  const reserveOnce = async (a: ReserveArgs): Promise<[number, number]> => {
    const r = await within(
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
        onRebuild?.({ tenantId: a.tenantId, period: a.period, epoch: a.epoch });
        const snap = await loadSnapshot(a.tenantId, a.period);
        const holds = snap.holds.flatMap((h) => [h.id, h.amount, h.ttlMs]);
        const estimated = snap.estimated.flatMap((e) => [e.id, e.cost]);
        const k = keys(a.tenantId, a.period, a.epoch);
        await within(
          cmd.budInit(...k, estKey(k), indexKey(keyPrefix), snap.spent, periodExpiryS(a.period), clock ? clock() : '', snap.holds.length, ...holds, ...estimated),
        );
        [status, remaining] = await reserveOnce(a);
        if (status === -1) throw new Error('budget balance missing after rebuild');
      }
      return { allowed: status === 1, remaining };
    },

    async settle(a) {
      const k = keys(a.tenantId, a.period, a.epoch);
      const r = await within(
        cmd.budSettle(...k, estKey(k), spendKey(keyPrefix), a.entry.id, a.entry.kind === 'charge' ? a.entry.costMicros : 0, ...toSpendFields(a.entry)),
      );
      if (r[0] === -1) return 'rebuild';
      return r[0] === 1 ? 'changed' : 'unchanged';
    },

    async enqueue(entry) {
      await within(redis.xadd(spendKey(keyPrefix), '*', ...toSpendFields(entry)));
    },

    async apply(epoch, settled) {
      const n = await applySettled(redis, keyPrefix, epoch, settled, timeoutMs);
      return n > 0 ? 'changed' : 'unchanged';
    },

    async release(tenantId, period, epoch, id) {
      try {
        await within(cmd.budRelease(...keys(tenantId, period, epoch), id));
      } catch {
        // A hold that can't be released here is dropped by the worker's reconcile once it is past its expiry.
      }
    },

    async ping() {
      await within(redis.ping());
    },
  };
}
