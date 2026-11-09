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
let pgl: PgLedger;
const faults = { down: false, failSettle: 0 };
const tenantIds: string[] = [];
const open: Budget[] = [];

// The real client, except that the budget scripts and PING fail while `down` is set (Redis "killed" without
// touching the Redis the other test files share), and `failSettle` makes the next N settle calls fail
// alone (a settle that timed out while Redis is otherwise fine).
const flaky = new Proxy({} as Redis, {
  get(_t, prop) {
    const v = Reflect.get(redis, prop, redis);
    const gone = () => Promise.reject(Object.assign(new Error('Connection is closed.'), { code: 'ECONNRESET' }));
    if (typeof prop === 'string' && (prop.startsWith('bud') || prop === 'ping')) {
      if (faults.down) return gone;
      if (prop === 'budSettle' && faults.failSettle > 0) {
        return () => {
          faults.failSettle--;
          return gone();
        };
      }
    }
    return typeof v === 'function' ? v.bind(redis) : v;
  },
});

beforeAll(() => {
  handle = createDb({ databaseUrl: base.databaseUrl, poolSize: 16 });
  redis = new Redis(base.redisUrl!);
  pgl = createPgLedger(handle.db);
});
afterEach(async () => {
  faults.down = false;
  faults.failSettle = 0;
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
    epochRefreshS: 3600, outageFailures: 3, redisRetryMs: 0, retryDelaysMs: [1, 1, 1], ...extra,
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
const pgSpent = (t: string) => pgl.spent(t, P);
const redisBal = async (t: string, epoch: number) => {
  const h = await redis.hgetall(`${prefix}bud:{${t}}:${P}:${epoch}`);
  return { spent: Number(h.spent), reserved: Number(h.reserved), ver: Number(h.ver) };
};
const count = async (table: 'spend_ledger' | 'budget_reservations', t: string) =>
  Number((await handle.db.execute(sql.raw(`select count(*) as n from ${table} where tenant_id = '${t}'`))).rows[0]!.n);
const liveHoldSum = async (t: string) =>
  Number(
    (await handle.db.execute(sql`select coalesce(sum(amount_micros), 0) as s from budget_reservations where tenant_id = ${t} and expires_at > now()`))
      .rows[0]!.s,
  );

// Three gateways, one tenant. Some requests settle with Redis up, some are in flight when Redis is
// killed, some are decided and settled on the Postgres path, some are still in flight at recovery.
async function outage() {
  const t = await newTenant();
  const [b1, b2] = [await newBudget(), await newBudget()];
  const h1 = allowed(await b1.reserve(req(t, 1000, 10_000)));
  await b1.settle(h1, charge(800));
  const h2 = allowed(await b2.reserve(req(t, 1500, 10_000))); // in flight across the whole outage
  expect(h2.path).toBe('redis');
  const e0 = b1.epoch();
  faults.down = true;
  const h3 = allowed(await b1.reserve(req(t, 2000, 10_000)));
  expect(h3.path).toBe('postgres');
  await b1.settle(h3, charge(1800));
  const h4 = allowed(await b2.reserve(req(t, 500, 10_000))); // in flight at recovery
  expect(h4.path).toBe('postgres');
  faults.down = false;
  return { t, b1, b2, h1, h2, h3, h4, e0 };
}

describe('budget', { timeout: 120_000 }, () => {
  it('Redis killed with holds in flight, then a flood: the cap holds and exactly the money that fits is admitted', async () => {
    const t = await newTenant();
    const budgets = [await newBudget(), await newBudget(), await newBudget()];
    // 7500 cap, 1000 each: 7 holds fit in all. Three are in flight on Redis when it is killed.
    const inFlight = [];
    for (const b of budgets) inFlight.push(allowed(await b.reserve(req(t, 1000, 7500))));
    expect(inFlight.every((h) => h.path === 'redis')).toBe(true);
    const e0 = budgets[0]!.epoch();
    faults.down = true;
    const flood = await Promise.all(Array.from({ length: 60 }, (_, i) => budgets[i % 3]!.reserve(req(t, 1000, 7500))));
    const floodHolds = flood.filter((r) => r.status === 'allowed').map(allowed);
    // The Postgres path counts the Redis-path holds: 3 in flight + exactly 4 more.
    expect(floodHolds).toHaveLength(4);
    expect(flood.filter((r) => r.status === 'denied')).toHaveLength(56);
    expect(floodHolds.every((h) => h.path === 'postgres')).toBe(true);
    expect(await count('budget_reservations', t)).toBe(7);
    expect(budgets.every((b) => b.mode() === 'postgres' && b.epoch() === e0 + 1)).toBe(true);

    // Everything settles at the worst case. Settled spend is exactly the 7 holds and within the cap.
    const all = [...inFlight, ...floodHolds];
    await Promise.all(all.map((h, i) => budgets[i % 3]!.settle(h, charge(1000))));
    expect(await pgSpent(t)).toBe(7000);
    expect(await pgSpent(t)).toBeLessThanOrEqual(7500);
    expect(await count('budget_reservations', t)).toBe(0);
  });

  it('after recovery the Redis balance equals tenant_spend and its reserved equals the live Postgres holds', async () => {
    const { t, b1, b2, h4 } = await outage();
    expect(await pgSpent(t)).toBe(2600);
    const back = allowed(await b1.reserve(req(t, 700, 10_000)));
    expect(back.path).toBe('redis');
    const epoch = b1.epoch();
    expect(back.epoch).toBe(epoch);
    // Live holds in Postgres: h2 (1500), h4 (500) and the new one (700).
    expect(await liveHoldSum(t)).toBe(2700);
    expect(await redisBal(t, epoch)).toMatchObject({ spent: await pgSpent(t), reserved: await liveHoldSum(t) });
    // The instance that decided h4 on Postgres returns to Redis on its own next request and finds the same balance.
    const next = allowed(await b2.reserve(req(t, 100, 10_000)));
    expect(next.path).toBe('redis');
    expect(b2.epoch()).toBe(epoch);
    expect(await redisBal(t, epoch)).toMatchObject({ spent: await pgSpent(t), reserved: await liveHoldSum(t) });
    // And it is a balance the cap is enforced on: 2600 spent + 2800 held leaves 4600.
    expect((await b2.reserve(req(t, 4601, 10_000))).status).toBe('denied');
    expect(h4.amount).toBe(500);
  });

  it('an old-epoch settle after the rebuild lands on the new key exactly once', async () => {
    const { t, b1, b2, h2 } = await outage();
    allowed(await b1.reserve(req(t, 700, 10_000))); // rebuilds the balance under the new epoch
    const epoch = b1.epoch();
    expect(h2.epoch).toBeLessThan(epoch); // h2 was held under the old epoch
    const before = await redisBal(t, epoch);
    await b2.settle(h2, charge(1200));
    const after = await redisBal(t, epoch);
    expect(after.spent).toBe(before.spent + 1200);
    expect(after.reserved).toBe(before.reserved - 1500);
    expect(after.spent).toBe(await pgSpent(t));
    // Settling it again changes nothing, in Postgres or Redis.
    await b2.settle(h2, charge(1200));
    expect(await redisBal(t, epoch)).toEqual(after);
    expect(await pgSpent(t)).toBe(after.spent);
    // The old key was not touched by it.
    expect((await redisBal(t, h2.epoch)).spent).toBe(800);
  });

  it('a charge recorded before the rebuild is not added to the rebuilt balance a second time', async () => {
    const t = await newTenant();
    const b = await newBudget();
    const h = allowed(await b.reserve(req(t, 1000, 10_000)));
    faults.down = true;
    await b.settle(h, charge(900)); // Postgres has it; Redis could not be told
    expect(await pgSpent(t)).toBe(900);
    faults.down = false;
    const next = allowed(await b.reserve(req(t, 100, 10_000))); // rebuild: spent 900 already in
    expect(await redisBal(t, b.epoch())).toMatchObject({ spent: 900, reserved: 100 });
    await b.settle(h, charge(900)); // a repeat of the same settle
    expect(await redisBal(t, b.epoch())).toMatchObject({ spent: 900, reserved: 100 });
    expect(next.path).toBe('redis');
  });

  it('concurrent outage detection on 3 instances moves the epoch exactly once', async () => {
    const t = await newTenant();
    const budgets = [await newBudget({ outageFailures: 1 }), await newBudget({ outageFailures: 1 }), await newBudget({ outageFailures: 1 })];
    const e0 = await pgl.readEpoch();
    expect(budgets.every((b) => b.epoch() === e0)).toBe(true);
    faults.down = true;
    const results = await Promise.all(budgets.flatMap((b) => [b.reserve(req(t, 10, 100_000)), b.reserve(req(t, 10, 100_000))]));
    expect(results.every((r) => r.status === 'allowed')).toBe(true);
    expect(await pgl.readEpoch()).toBe(e0 + 1);
    expect(budgets.map((b) => b.epoch())).toEqual([e0 + 1, e0 + 1, e0 + 1]);
  });

  it('one timed-out settle does not switch paths', async () => {
    const t = await newTenant();
    const b = await newBudget();
    const e0 = b.epoch();
    const h = allowed(await b.reserve(req(t, 1000, 10_000)));
    faults.failSettle = 1; // one settle call fails; PING and everything else work
    await b.settle(h, charge(600));
    expect(faults.failSettle).toBe(0);
    expect(b.mode()).toBe('redis');
    expect(b.epoch()).toBe(e0);
    expect(await pgl.readEpoch()).toBe(e0);
    // The retry landed: the balance is exact.
    expect(await redisBal(t, e0)).toMatchObject({ spent: 600, reserved: 0 });
  });

  it('consecutive failures switch paths even when PING still answers', async () => {
    const t = await newTenant();
    const b = await newBudget({ outageFailures: 3 });
    const e0 = b.epoch();
    const h = allowed(await b.reserve(req(t, 1000, 10_000)));
    faults.failSettle = 1000; // every settle fails, PING works
    await b.settle(h, charge(600));
    expect(b.mode()).toBe('postgres');
    expect(b.epoch()).toBe(e0 + 1);
    expect(await pgSpent(t)).toBe(600);
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
    expect(await count('budget_reservations', t)).toBe(0);
    expect(await redisBal(t, budget.epoch())).toMatchObject({ spent: expected, reserved: 0 });
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

  it('a failed Postgres settle is retried and lands once', async () => {
    const t = await newTenant();
    let failures = 2;
    const pgLedger: PgLedger = {
      ...pgl,
      settle: async (id, e) => {
        if (failures-- > 0) throw new Error('connection reset');
        return pgl.settle(id, e);
      },
    };
    const budget = await newBudget({ pgLedger });
    const h = allowed(await budget.reserve(req(t, 100, 1000)));
    await budget.settle(h, charge(80));
    expect(failures).toBe(-1);
    expect(await count('spend_ledger', t)).toBe(1);
    expect(await pgSpent(t)).toBe(80);
  });

  it('gives up after the retries and logs the class without the message; the hold stays until it lapses', async () => {
    const t = await newTenant();
    let attempts = 0;
    const pgLedger: PgLedger = {
      ...pgl,
      settle: async () => {
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
    // Nothing was written, so nothing was released: the money stays held in both stores.
    expect(await count('budget_reservations', t)).toBe(1);
    expect((await redisBal(t, h.epoch)).reserved).toBe(100);
  });

  it('a failed Postgres hold insert refuses the request and releases the Redis hold', async () => {
    const t = await newTenant();
    const pgLedger: PgLedger = { ...pgl, hold: () => Promise.reject(new Error('connection reset')) };
    const budget = await newBudget({ pgLedger });
    const e = budget.epoch();
    // The cap fits exactly one hold; if the Redis hold of the failed attempts leaked, the second would be refused.
    expect((await budget.reserve(req(t, 1000, 1000))).status).toBe('unavailable');
    await budget.close(); // waits for the release
    expect(await redisBal(t, e)).toMatchObject({ reserved: 0, spent: 0 });
    expect(await count('budget_reservations', t)).toBe(0);
    const healthy = await newBudget();
    expect((await healthy.reserve(req(t, 1000, 1000))).status).toBe('allowed');
  });

  it('reserve reports unavailable when neither Redis nor Postgres can decide', async () => {
    const budget = await newBudget({ pgLedger: { ...pgl, reserve: () => Promise.reject(new Error('down')) } });
    faults.down = true;
    expect((await budget.reserve(req(await newTenant(), 100, 1000))).status).toBe('unavailable');
  });
});
