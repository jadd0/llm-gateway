import { randomBytes } from 'node:crypto';
import { Redis } from 'ioredis';
import { sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createTenant } from '../cli/keys.ts';
import { createDb, type Db } from '../db/client.ts';
import { cleanup, testConfig } from '../test-env.ts';
import { createBudget, type Budget, type ReserveRequest, type Reservation, type ReserveOutcome } from './budget.ts';
import { periodOf } from './period.ts';
import { createPgLedger, type PgLedger } from './pg-ledger.ts';

const base = testConfig();
const prefix = base.redisKeyPrefix;
const P = periodOf(Date.now());
let handle: Db;
let redis: Redis;
let down = false;
const tenantIds: string[] = [];
const open: Budget[] = [];

// The real client, except that the budget scripts fail while `down` is set: Redis "going away" without
// touching the Redis the other test files share.
const flaky = new Proxy({} as Redis, {
  get(_t, prop) {
    const v = Reflect.get(redis, prop, redis);
    if (down && typeof prop === 'string' && prop.startsWith('bud')) {
      return () => Promise.reject(Object.assign(new Error('Connection is closed.'), { code: 'ECONNRESET' }));
    }
    return typeof v === 'function' ? v.bind(redis) : v;
  },
});

beforeAll(() => {
  handle = createDb({ databaseUrl: base.databaseUrl, poolSize: 12 });
  redis = new Redis(base.redisUrl!);
});
afterEach(async () => {
  down = false;
  for (const b of open.splice(0)) await b.close();
});
afterAll(async () => {
  await cleanup(handle.db, redis, tenantIds, prefix);
  redis.disconnect();
  await handle.close();
});

const newTenant = async () => {
  const t = await createTenant(handle.db, `t-${randomBytes(6).toString('hex')}`);
  tenantIds.push(t.id);
  return t.id;
};
const newBudget = async (extra: Partial<Parameters<typeof createBudget>[0]> = {}) => {
  const b = await createBudget({
    db: handle.db, redis: flaky, keyPrefix: prefix, reservationTtlS: 300, redisTimeoutMs: 5000,
    epochRefreshS: 3600, redisRetryMs: 0, retryDelaysMs: [1, 1, 1], ...extra,
  });
  open.push(b);
  return b;
};
const req = (tenantId: string, estimate: number, cap: number): ReserveRequest => ({
  tenantId, model: 'mock-model', estimate, cap, promptTokens: 10, completionTokens: 20,
});
const allowed = (o: ReserveOutcome): Reservation => {
  if (o.status !== 'allowed') throw new Error(`expected allowed, got ${o.status}`);
  return o.reservation;
};
const charge = (costMicros: number, estimated = false) =>
  ({ kind: 'charge', costMicros, promptTokens: 10, completionTokens: 20, estimated }) as const;
const pgSpent = (t: string) => createPgLedger(handle.db).spent(t, P);
const redisBal = async (t: string, epoch: number) => {
  const h = await redis.hgetall(`${prefix}bud:{${t}}:${P}:${epoch}`);
  return { spent: Number(h.spent), reserved: Number(h.reserved) };
};
const count = async (table: 'spend_ledger' | 'budget_reservations', t: string) =>
  Number((await handle.db.execute(sql.raw(`select count(*) as n from ${table} where tenant_id = '${t}'`))).rows[0]!.n);

describe('budget', { timeout: 120_000 }, () => {
  it('Redis down switches to Postgres, bumps the epoch and stays within the cap', async () => {
    const t = await newTenant();
    const budget = await newBudget();
    const e0 = budget.epoch();
    // One request settled while Redis is healthy.
    const first = allowed(await budget.reserve(req(t, 1000, 7500)));
    expect(first.path).toBe('redis');
    await budget.settle(first, charge(1000));
    expect(await pgSpent(t)).toBe(1000);

    down = true;
    const results = await Promise.all(Array.from({ length: 50 }, () => budget.reserve(req(t, 1000, 7500))));
    const held = results.filter((r) => r.status === 'allowed').map(allowed);
    // 7500 cap, 1000 already spent: exactly 6 more worst cases fit.
    expect(held).toHaveLength(6);
    expect(results.filter((r) => r.status === 'denied')).toHaveLength(44);
    expect(held.every((h) => h.path === 'postgres')).toBe(true);
    expect(budget.mode()).toBe('postgres');
    expect(budget.epoch()).toBeGreaterThan(e0);
    expect(await count('budget_reservations', t)).toBe(6);

    await Promise.all(held.map((h) => budget.settle(h, charge(1000))));
    expect(await count('budget_reservations', t)).toBe(0);
    expect(await pgSpent(t)).toBe(7000);
    expect(await pgSpent(t)).toBeLessThanOrEqual(7500);
  });

  it('after Redis recovers, the next reserve rebuilds from Postgres including fallback-period spend', async () => {
    const t = await newTenant();
    const budget = await newBudget();
    const first = allowed(await budget.reserve(req(t, 1000, 5000)));
    await budget.settle(first, charge(1000));
    const oldEpoch = budget.epoch();
    expect(await redisBal(t, oldEpoch)).toEqual({ spent: 1000, reserved: 0 });

    down = true;
    const during = allowed(await budget.reserve(req(t, 2000, 5000)));
    expect(during.path).toBe('postgres');
    await budget.settle(during, charge(1800));
    expect(await pgSpent(t)).toBe(2800);
    // The old balance never saw the 1800.
    expect(await redisBal(t, oldEpoch)).toEqual({ spent: 1000, reserved: 0 });

    down = false;
    const after = allowed(await budget.reserve(req(t, 2200, 5000)));
    expect(after.path).toBe('redis');
    expect(after.epoch).toBeGreaterThan(oldEpoch);
    expect(budget.mode()).toBe('redis');
    // Rebuilt from Postgres (2800) plus this hold: 2800 + 2200 fills the cap.
    expect(await redisBal(t, after.epoch)).toEqual({ spent: 2800, reserved: 2200 });
    expect((await budget.reserve(req(t, 1, 5000))).status).toBe('denied');
  });

  it('every settle lands in spend_ledger and tenant_spend exactly once', async () => {
    const t = await newTenant();
    const budget = await newBudget();
    const holds = [];
    for (let i = 0; i < 30; i++) holds.push(allowed(await budget.reserve(req(t, 100, 1_000_000))));
    // Each settled twice at once, and one of them a refund.
    const costs = holds.map((_, i) => 10 + i);
    await Promise.all(
      holds.flatMap((h, i) => {
        const outcome = i === 0 ? ({ kind: 'refund' } as const) : charge(costs[i]!);
        return [budget.settle(h, outcome), budget.settle(h, outcome)];
      }),
    );
    const expected = costs.slice(1).reduce((a, b) => a + b, 0);
    expect(await count('spend_ledger', t)).toBe(29);
    expect(await pgSpent(t)).toBe(expected);
    expect(await redisBal(t, budget.epoch())).toEqual({ spent: expected, reserved: 0 });
    const est = await handle.db.execute(sql`select count(*) as n from spend_ledger where tenant_id = ${t} and estimated`);
    expect(Number(est.rows[0]!.n)).toBe(0);
  });

  it('a charge made from the estimate is recorded as estimated', async () => {
    const t = await newTenant();
    const budget = await newBudget();
    const h = allowed(await budget.reserve(req(t, 300, 1000)));
    await budget.settle(h, charge(300, true));
    const rows = await handle.db.execute(sql`select cost_micros, estimated from spend_ledger where tenant_id = ${t}`);
    expect(rows.rows.map((r) => [Number(r.cost_micros), r.estimated])).toEqual([[300, true]]);
  });

  it('a failed Postgres write is retried and lands once', async () => {
    const t = await newTenant();
    const real = createPgLedger(handle.db);
    let failures = 2;
    const pgLedger: PgLedger = {
      ...real,
      record: async (e) => {
        if (failures-- > 0) throw new Error('connection reset');
        return real.record(e);
      },
    };
    const budget = await newBudget({ pgLedger });
    const h = allowed(await budget.reserve(req(t, 100, 1000)));
    await budget.settle(h, charge(80));
    expect(failures).toBe(-1);
    expect(await count('spend_ledger', t)).toBe(1);
    expect(await pgSpent(t)).toBe(80);
  });

  it('gives up after the retries, logs the class without the message, and still releases the hold', async () => {
    const t = await newTenant();
    const real = createPgLedger(handle.db);
    let attempts = 0;
    const pgLedger: PgLedger = {
      ...real,
      record: async () => {
        attempts++;
        throw Object.assign(new Error('secret customer detail'), { code: 'ECONNRESET' });
      },
    };
    const errors: Array<[object, string]> = [];
    const log = { warn() {}, info() {}, error: (o: object, m: string) => void errors.push([o, m]) };
    const budget = await newBudget({ pgLedger, log });
    const h = allowed(await budget.reserve(req(t, 100, 1000)));
    await budget.settle(h, charge(80));
    expect(attempts).toBe(4); // the first try and 3 retries
    expect(errors).toEqual([[{ errClass: 'Error', code: 'ECONNRESET' }, 'budget settle could not be written to postgres']]);
    expect(JSON.stringify(errors)).not.toContain('secret');
    expect((await redisBal(t, h.epoch)).reserved).toBe(0);
  });

  it('reserve reports unavailable when neither Redis nor Postgres can decide', async () => {
    const real = createPgLedger(handle.db);
    const budget = await newBudget({ pgLedger: { ...real, reserve: () => Promise.reject(new Error('down')) } });
    down = true;
    expect((await budget.reserve(req(await newTenant(), 100, 1000))).status).toBe('unavailable');
  });

  it('a Redis that fails only the settle is abandoned so the balance is rebuilt', async () => {
    const t = await newTenant();
    const budget = await newBudget();
    const e0 = budget.epoch();
    const h = allowed(await budget.reserve(req(t, 500, 5000)));
    down = true;
    await budget.settle(h, charge(450));
    down = false;
    expect(await pgSpent(t)).toBe(450);
    // The failed settle sent the budget to Postgres and moved the epoch; the next Redis reserve is
    // therefore a rebuild that already counts the 450.
    const next = allowed(await budget.reserve(req(t, 100, 5000)));
    expect(next.epoch).toBeGreaterThan(e0);
    expect(await redisBal(t, next.epoch)).toEqual({ spent: 450, reserved: 100 });
  });
});
