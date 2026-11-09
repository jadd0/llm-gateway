import { randomBytes, randomUUID } from 'node:crypto';
import { Redis } from 'ioredis';
import { sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createTenant } from '../cli/keys.ts';
import { drainSpend } from '../../test/drain.ts';
import { createDb, type Db } from '../db/client.ts';
import { cleanup, testConfig } from '../test-env.ts';
import { createBudget, type Budget, type ReserveRequest, type Reservation, type ReserveOutcome } from './budget.ts';
import { periodOf } from './period.ts';
import { chargeExpiredHolds, createPgLedger, type PgLedger } from './pg-ledger.ts';
import { applySettled } from './redis-ledger.ts';

const base = testConfig();
const prefix = base.redisKeyPrefix;
const P = periodOf(Date.now());
let handle: Db;
let redis: Redis;
let pgl: PgLedger;
type Faults = { down: boolean; failSettle: number; failApply: number; beforeReserve: (() => Promise<void>) | null; reserveRunsThenFails: boolean };
const newFaults = (): Faults => ({ down: false, failSettle: 0, failApply: 0, beforeReserve: null, reserveRunsThenFails: false });
const faults = newFaults();
const faultsA = newFaults(); // a second "network path" to Redis, so one instance can lose it while another keeps it
const tenantIds: string[] = [];
const open: Budget[] = [];

// The real client, except that the budget scripts and PING fail while `down` is set (Redis "killed" without
// touching the Redis the other test files share), and `failSettle` makes the next N settle calls fail
// alone (a settle that timed out while Redis is otherwise fine).
const proxyFor = (f: Faults) =>
  new Proxy({} as Redis, {
    get(_t, prop) {
      const v = Reflect.get(redis, prop, redis);
      const gone = () => Promise.reject(Object.assign(new Error('Connection is closed.'), { code: 'ECONNRESET' }));
      if (typeof prop === 'string' && (prop.startsWith('bud') || prop === 'ping' || prop === 'xadd')) {
        if (f.down) return gone;
        if (prop === 'budSettle' && f.failSettle > 0) {
          return () => {
            f.failSettle--;
            return gone();
          };
        }
        if (prop === 'budApply' && f.failApply > 0) {
          return () => {
            f.failApply--;
            return gone();
          };
        }
        if (prop === 'budReserve' && (f.beforeReserve || f.reserveRunsThenFails)) {
          return async (...a: unknown[]) => {
            await f.beforeReserve?.();
            const out = await (v as (...x: unknown[]) => Promise<unknown>).apply(redis, a);
            // The script ran, but the client gives up on the answer (a timeout): the hold exists in Redis.
            if (f.reserveRunsThenFails) return gone();
            return out;
          };
        }
      }
      return typeof v === 'function' ? v.bind(redis) : v;
    },
  });
const flaky = proxyFor(faults);
const flakyA = proxyFor(faultsA);

beforeAll(() => {
  handle = createDb({ databaseUrl: base.databaseUrl, poolSize: 16 });
  redis = new Redis(base.redisUrl!);
  pgl = createPgLedger(handle.db);
});
afterEach(async () => {
  Object.assign(faults, newFaults());
  Object.assign(faultsA, newFaults());
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
    epochRefreshMs: 3_600_000, outageFailures: 3, redisRetryMs: 0, bumpBackoffBaseMs: 0, retryDelaysMs: [1, 1, 1], ...extra,
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
// The log worker's part: writes every queued settle to Postgres and catches the live balances up.
const drain = () => drainSpend(handle.db, redis, prefix);
const pgSpent = (t: string) => pgl.spent(t, P);
const redisBal = async (t: string, epoch: number) => {
  const h = await redis.hgetall(`${prefix}bud:{${t}}:${P}:${epoch}`);
  return { spent: Number(h.spent), reserved: Number(h.reserved) };
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
  await drain(); // the worker applies h1's queued settle
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
    await drain();
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
    await drain();
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
    const holds = [];
    for (let i = 0; i < 3; i++) holds.push(allowed(await b.reserve(req(t, 1000, 10_000))));
    faults.failSettle = 1000; // every settle fails, and so does catching the balance up; PING works
    faults.failApply = 1000;
    for (const h of holds) await b.settle(h, charge(600)); // each is written straight to Postgres instead
    expect(b.mode()).toBe('postgres');
    expect(b.epoch()).toBe(e0 + 1);
    expect(await pgSpent(t)).toBe(1800);
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
    await drain();
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
    await drain();
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
    faults.failSettle = 1; // the queue script fails once, so the ledger is written here
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
    faults.failSettle = 1; // the queue script fails once, so the ledger is written here
    await budget.settle(h, charge(80));
    expect(attempts).toBe(4); // the first try and 3 retries
    expect(errors).toEqual([[{ errClass: 'Error', code: 'ECONNRESET' }, 'budget settle could not be written to postgres']]);
    expect(JSON.stringify(errors)).not.toContain('secret');
    // Nothing was written, so nothing was released: the money stays held in both stores.
    expect(await count('budget_reservations', t)).toBe(1);
    expect((await redisBal(t, h.epoch)).reserved).toBe(100);
  });

  it('a failed Postgres hold insert refuses the request before Redis is asked, so nothing is held anywhere', async () => {
    const t = await newTenant();
    const pgLedger: PgLedger = { ...pgl, hold: () => Promise.reject(new Error('connection reset')) };
    const budget = await newBudget({ pgLedger });
    const e = budget.epoch();
    expect((await budget.reserve(req(t, 1000, 1000))).status).toBe('unavailable');
    await budget.close();
    expect(await redis.exists(`${prefix}bud:{${t}}:${P}:${e}`)).toBe(0);
    expect(await count('budget_reservations', t)).toBe(0);
    // The cap fits exactly one hold, and a healthy instance gets it.
    const healthy = await newBudget();
    expect((await healthy.reserve(req(t, 1000, 1000))).status).toBe('allowed');
  });

  it('the Postgres hold is written before Redis decides: a snapshot taken in between includes it', async () => {
    const t = await newTenant();
    const budget = await newBudget();
    let seen: Awaited<ReturnType<PgLedger['snapshot']>> | null = null;
    faults.beforeReserve = async () => {
      seen = await pgl.snapshot(t, P);
    };
    const h = allowed(await budget.reserve(req(t, 1000, 5000)));
    expect(seen).not.toBeNull();
    expect(seen!.holds).toEqual([expect.objectContaining({ id: h.id, amount: 1000 })]);
  });

  it('a hold Redis refuses is removed from Postgres before the refusal is returned', async () => {
    const t = await newTenant();
    const budget = await newBudget();
    allowed(await budget.reserve(req(t, 1000, 1500)));
    expect((await budget.reserve(req(t, 1000, 1500))).status).toBe('denied');
    expect((await budget.reserve(req(t, 1000, 1500))).status).toBe('denied');
    expect(await count('budget_reservations', t)).toBe(1);
  });

  it('a request decided on Postgres after its hold was written is counted once', async () => {
    const t = await newTenant();
    const budget = await newBudget({ outageFailures: 1 });
    faults.down = true;
    // Two holds of 1000 fill a 2000 cap exactly; if the first were counted twice the second would be refused.
    const first = allowed(await budget.reserve(req(t, 1000, 2000)));
    const second = allowed(await budget.reserve(req(t, 1000, 2000)));
    expect([first.path, second.path]).toEqual(['postgres', 'postgres']);
    expect((await budget.reserve(req(t, 1, 2000))).status).toBe('denied');
    expect(await count('budget_reservations', t)).toBe(2);
  });

  it('while the epoch bump is failing or pending, reserves stay on Postgres even though Redis answers; the first one after the bump rebuilds the new key', async () => {
    const t = await newTenant();
    let failing = true;
    let gate: Promise<void> | null = null;
    const pgLedger: PgLedger = {
      ...pgl,
      bumpEpoch: async (observed) => {
        if (failing) throw new Error('connection reset');
        if (gate) await gate;
        return pgl.bumpEpoch(observed);
      },
    };
    const budget = await newBudget({ pgLedger, outageFailures: 1 });
    const e0 = budget.epoch();
    const keyAt = (e: number) => `${prefix}bud:{${t}}:${P}:${e}`;
    faults.down = true;
    const first = allowed(await budget.reserve(req(t, 100, 100_000)));
    expect(first.path).toBe('postgres'); // outage declared, the bump fails
    faults.down = false; // Redis is back, but the new epoch is not in place
    await budget.settle(first, { kind: 'refund' }); // a Redis call that succeeds does not bring the instance back either
    expect(budget.mode()).toBe('postgres');
    for (let i = 0; i < 3; i++) {
      expect(allowed(await budget.reserve(req(t, 100, 100_000))).path).toBe('postgres');
      expect(budget.mode()).toBe('postgres');
      expect(budget.epoch()).toBe(e0);
    }
    expect(await redis.exists(keyAt(e0), keyAt(e0 + 1))).toBe(0); // Redis was not used at all
    // The bump now works, but slowly: the reserve waits for it and does not touch the old epoch meanwhile.
    failing = false;
    let release!: () => void;
    gate = new Promise<void>((r) => (release = r));
    let done = false;
    const next = budget.reserve(req(t, 100, 100_000)).then((r) => ((done = true), r));
    for (let i = 0; i < 30; i++) await new Promise((r) => setImmediate(r));
    expect(done).toBe(false);
    expect(await redis.exists(keyAt(e0), keyAt(e0 + 1))).toBe(0);
    release();
    const back = allowed(await next);
    expect(back.path).toBe('redis');
    expect(budget.mode()).toBe('redis');
    expect(budget.epoch()).toBe(e0 + 1);
    // The new key was rebuilt from Postgres: the four live holds, counted once each.
    expect(await redisBal(t, e0 + 1)).toMatchObject({ spent: 0, reserved: 400 });
    expect(await redis.exists(keyAt(e0))).toBe(0);
  });

  it('a settle whose first reply was lost still corrects the live balance when it is retried', async () => {
    const t = await newTenant();
    let calls = 0;
    const pgLedger: PgLedger = {
      ...pgl,
      settle: async (id, e) => {
        const r = await pgl.settle(id, e); // committed
        if (calls++ === 0) throw new Error('connection reset before the reply'); // ...but the answer is lost
        return r;
      },
    };
    const budget = await newBudget({ pgLedger });
    const h = allowed(await budget.reserve(req(t, 1000, 10_000)));
    faults.failSettle = 1; // the queue script fails once, so the ledger is written here
    await budget.settle(h, charge(700));
    expect(calls).toBe(2);
    expect(await count('spend_ledger', t)).toBe(1);
    expect(await pgSpent(t)).toBe(700);
    expect(await redisBal(t, budget.epoch())).toMatchObject({ spent: 700, reserved: 0 });
  });

  it('a Redis reserve that times out but still runs leaves no phantom hold once the request settles', async () => {
    const t = await newTenant();
    const budget = await newBudget({ outageFailures: 10 }); // one timeout is not an outage
    const e = budget.epoch();
    await budget.settle(allowed(await budget.reserve(req(t, 10, 10_000))), { kind: 'refund' }); // the balance exists
    await drain();
    faults.reserveRunsThenFails = true;
    const h = allowed(await budget.reserve(req(t, 1000, 10_000)));
    faults.reserveRunsThenFails = false;
    expect(h.path).toBe('postgres'); // decided on Postgres for this request
    expect(budget.mode()).toBe('redis');
    expect((await redisBal(t, e)).reserved).toBe(1000); // the script did run: a hold nothing else knows of
    await budget.settle(h, charge(400));
    expect(await redisBal(t, e)).toMatchObject({ spent: 400, reserved: 0 });
    await drain();
    expect(await pgSpent(t)).toBe(400);
    expect(await redisBal(t, e)).toMatchObject({ spent: 400, reserved: 0 }); // the worker's catch-up changed nothing
  });

  const flush = async (t: string) => {
    const keys = await redis.keys(`${prefix}bud:{${t}}:*`);
    if (keys.length) await redis.del(...keys);
  };

  it('a rebuild with settles still queued counts their estimate; once the worker has applied them the balance is exact', async () => {
    const t = await newTenant();
    const b = await newBudget();
    const e0 = b.epoch();
    const h = allowed(await b.reserve(req(t, 1000, 1500)));
    await b.settle(h, charge(700)); // queued; Postgres has neither the charge nor the release yet
    expect(await count('spend_ledger', t)).toBe(0);
    expect(await count('budget_reservations', t)).toBe(1);
    await flush(t); // Redis restarted empty
    await b.reserve(req(t, 1, 1500)).then(async (r) => void (r.status === 'allowed' && (await b.settle(r.reservation, { kind: 'refund' })))); // notices the loss, moves the epoch
    const until = Date.now() + 10_000;
    while ((await pgl.readEpoch()) === e0 && Date.now() < until) await new Promise((r) => setTimeout(r, 5));
    await b.refreshEpoch();
    expect(b.epoch()).toBeGreaterThan(e0);
    // The balance is rebuilt from Postgres, which still holds the 1000 estimate and not the 700 charge:
    // 1000 + 600 does not fit under 1500 although 700 + 600 would. The estimate is the safe side.
    expect((await b.reserve(req(t, 600, 1500))).status).toBe('denied');
    expect(await redisBal(t, b.epoch())).toMatchObject({ spent: 0, reserved: 1001 }); // plus the 1 held by the request that noticed
    // The worker applies the queued settle (and the refund): the rebuilt balance releases the estimate and takes the charge once.
    await drain();
    expect(await pgSpent(t)).toBe(700);
    expect(await liveHoldSum(t)).toBe(0);
    expect(await redisBal(t, b.epoch())).toMatchObject({ spent: 700, reserved: 0 });
    // Applying again changes nothing, in Postgres or Redis.
    await drain();
    expect(await pgSpent(t)).toBe(700);
    expect(await redisBal(t, b.epoch())).toMatchObject({ spent: 700, reserved: 0 });
    expect((await b.reserve(req(t, 800, 1500))).status).toBe('allowed');
    expect((await b.reserve(req(t, 1, 1500))).status).toBe('denied');
  });

  // Notices the loss of a flushed balance (moving the epoch) and waits until this instance has adopted the new one.
  const rebuildAfterFlush = async (t: string, b: Budget, cap: number) => {
    const e0 = b.epoch();
    await flush(t);
    const r = await b.reserve(req(t, 1, cap));
    if (r.status === 'allowed') await b.settle(r.reservation, { kind: 'refund' });
    const until = Date.now() + 10_000;
    while ((await pgl.readEpoch()) === e0 && Date.now() < until) await new Promise((x) => setTimeout(x, 5));
    await b.refreshEpoch();
    expect(b.epoch()).toBeGreaterThan(e0);
  };
  const lapse = () => new Promise((r) => setTimeout(r, 1200)); // past a 1 s reservation TTL

  it('the worker down for longer than the TTL with settles queued: a rebuild still counts them, the cap holds, and after the drain the balance is exact', async () => {
    const t = await newTenant();
    const b = await newBudget({ reservationTtlS: 1 });
    const h = allowed(await b.reserve(req(t, 1000, 1500)));
    await b.settle(h, charge(700)); // queued; the worker is "down"
    await lapse(); // the hold row is past its expiry and its settle is still queued
    expect(await count('budget_reservations', t)).toBe(1);
    await rebuildAfterFlush(t, b, 1500);
    // The rebuilt balance has the lapsed hold's 1000 (the estimate), not 0: 1000 + 600 does not fit under 1500.
    expect((await b.reserve(req(t, 600, 1500))).status).toBe('denied');
    expect(await redisBal(t, b.epoch())).toMatchObject({ spent: 0, reserved: 1001 }); // plus the 1 held by the request that noticed the loss
    await drain();
    expect(await pgSpent(t)).toBe(700);
    expect(await count('budget_reservations', t)).toBe(0);
    expect(await redisBal(t, b.epoch())).toMatchObject({ spent: 700, reserved: 0 });
    expect((await b.reserve(req(t, 800, 1500))).status).toBe('allowed');
    expect((await b.reserve(req(t, 1, 1500))).status).toBe('denied');
  });

  it('a hold swept at its estimate, then a rebuild, then the worker catching Redis up: the estimate is counted once', async () => {
    const t = await newTenant();
    const b = await newBudget({ reservationTtlS: 1 });
    allowed(await b.reserve(req(t, 1000, 10_000))); // the gateway dies: never settled
    await lapse();
    const charged = (await chargeExpiredHolds(handle.db, 1000)).filter((c) => c.tenantId === t);
    expect(charged).toHaveLength(1);
    expect(await pgSpent(t)).toBe(1000);
    await rebuildAfterFlush(t, b, 10_000);
    await drain();
    const r = allowed(await b.reserve(req(t, 1, 10_000))); // the balance at the new epoch is built from Postgres here
    await b.settle(r, { kind: 'refund' });
    await drain();
    // Spent already has the sweeper's estimate and no hold is left for it.
    expect(await redisBal(t, b.epoch())).toMatchObject({ spent: 1000, reserved: 0 });
    await applySettled(redis, prefix, b.epoch(), charged, 5000); // the sweeper's catch-up arrives late
    expect(await redisBal(t, b.epoch())).toMatchObject({ spent: 1000, reserved: 0 });
  });

  it('a settle whose entry was dead-lettered: Redis kept the real cost, and the sweeper charging the estimate adds nothing to it', async () => {
    const t = await newTenant();
    const b = await newBudget({ reservationTtlS: 1 });
    const e = b.epoch();
    const h = allowed(await b.reserve(req(t, 1000, 10_000)));
    await b.settle(h, charge(400));
    expect(await redisBal(t, e)).toMatchObject({ spent: 400, reserved: 0 });
    const spendKey = `${prefix}requestlog:spend`;
    const queued = (await redis.xrange(spendKey, '-', '+')).filter(([, f]) => f.includes(h.id));
    expect(queued).toHaveLength(1);
    await redis.xdel(spendKey, queued[0]![0]); // the entry is dead-lettered: Postgres never gets the charge
    await lapse();
    const charged = (await chargeExpiredHolds(handle.db, 1000)).filter((c) => c.tenantId === t);
    expect(charged).toEqual([{ tenantId: t, period: P, id: h.id, costMicros: 1000 }]);
    await applySettled(redis, prefix, e, charged, 5000);
    expect(await redisBal(t, e)).toMatchObject({ spent: 400, reserved: 0 }); // not 1400
  });

  it('a hold a rebuild imported at a newer epoch is released there when the request is then refused on Postgres', async () => {
    const t = await newTenant();
    const b = await newBudget({ outageFailures: 10 });
    const other = await newBudget({ redis }); // a second instance with its own, unfaulted, path to Redis
    const e = b.epoch();
    await b.settle(allowed(await b.reserve(req(t, 10, 1500))), { kind: 'refund' }); // the balance exists
    await drain();
    await pgl.hold({ id: randomUUID(), tenantId: t, period: P, estimate: 600, ttlMs: 300_000 }); // makes Postgres refuse 1000
    faults.beforeReserve = async () => {
      // Between this request's Postgres hold and its Redis reserve another instance moves the epoch and rebuilds
      // the tenant's balance, importing this request's hold row.
      faults.beforeReserve = null;
      await pgl.bumpEpoch(e);
      await other.refreshEpoch();
      await other.reserve(req(t, 1, 1500));
    };
    faults.reserveRunsThenFails = true;
    expect((await b.reserve(req(t, 1000, 1500))).status).toBe('denied');
    faults.reserveRunsThenFails = false;
    expect(await redisBal(t, e + 1)).toMatchObject({ spent: 0, reserved: 600 }); // only the other hold: no phantom for the refused request
    expect(await count('budget_reservations', t)).toBe(1);
  });

  it('a balance Redis lost moves the epoch once however many instances notice; a new tenant does not', async () => {
    const t = await newTenant();
    const [b, c] = [await newBudget(), await newBudget()];
    const e0 = b.epoch();
    for (const x of [b, c]) await x.settle(allowed(await x.reserve(req(t, 100, 100_000))), { kind: 'refund' });
    await flush(t); // Redis restarted empty
    await Promise.all([b.reserve(req(t, 100, 100_000)), c.reserve(req(t, 100, 100_000))]);
    await b.close();
    await c.close(); // waits for the bumps
    expect(await pgl.readEpoch()).toBe(e0 + 1);
    await b.refreshEpoch();
    await c.refreshEpoch();
    expect([b.epoch(), c.epoch()]).toEqual([e0 + 1, e0 + 1]);
    // A tenant nobody has used before is a rebuild too, but nothing was lost.
    const d = await newBudget();
    allowed(await d.reserve(req(await newTenant(), 100, 100_000)));
    await d.close();
    expect(await pgl.readEpoch()).toBe(e0 + 1);
  });

  it('an instance that rebuilt after a flush counts what another admitted on Postgres once it has refreshed its epoch', async () => {
    const t = await newTenant();
    const a = await newBudget({ redis: flakyA, outageFailures: 1 });
    const b = await newBudget();
    const e0 = b.epoch();
    await b.settle(allowed(await b.reserve(req(t, 100, 2500))), { kind: 'refund' }); // B has used the balance
    await drain();
    await flush(t); // Redis restarted empty
    expect(allowed(await b.reserve(req(t, 500, 2500))).path).toBe('redis'); // B rebuilds at e0 and admits 500
    // The rebuild moved the epoch on (in the background).
    const waitUntil = Date.now() + 10_000;
    while ((await pgl.readEpoch()) === e0 && Date.now() < waitUntil) await new Promise((r) => setTimeout(r, 5));
    expect(await pgl.readEpoch()).toBeGreaterThan(e0);
    // A loses Redis and decides on Postgres, which counts B's 500: 500 + 1000 + 1000 fills the 2500 cap.
    faultsA.down = true;
    expect(allowed(await a.reserve(req(t, 1000, 2500))).path).toBe('postgres');
    expect(allowed(await a.reserve(req(t, 1000, 2500))).path).toBe('postgres');
    // B moved to the new epoch with its own bump, so its next decision is made on a balance rebuilt from
    // Postgres after A's admissions, not on the one it rebuilt before them.
    await b.refreshEpoch();
    expect(b.epoch()).toBe(e0 + 1);
    expect((await b.reserve(req(t, 1000, 2500))).status).toBe('denied');
  });

  it('a stale instance adopts the newer epoch on its next refresh and then decides on the rebuilt balance', async () => {
    const t = await newTenant();
    const b = await newBudget();
    const other = await newBudget();
    const e0 = b.epoch();
    await b.settle(allowed(await b.reserve(req(t, 100, 2500))), { kind: 'refund' });
    await drain();
    // Another instance moves the epoch on and holds 2000 that B's balance never saw.
    expect((await pgl.bumpEpoch(e0)).bumped).toBe(true);
    await other.refreshEpoch();
    allowed(await other.reserve(req(t, 2000, 2500)));
    // Before its refresh B is still on the old balance and would admit 1000 (0 + 1000 <= 2500) ...
    expect(b.epoch()).toBe(e0);
    // ... after one refresh it decides on the new epoch's balance, rebuilt from Postgres: 2000 + 1000 > 2500.
    await b.refreshEpoch();
    expect(b.epoch()).toBe(e0 + 1);
    expect((await b.reserve(req(t, 1000, 2500))).status).toBe('denied');
  });

  it('a hold left by a Redis reserve that ran but whose reply was lost is released when the request is then refused', async () => {
    const t = await newTenant();
    const budget = await newBudget({ outageFailures: 10 });
    const e = budget.epoch();
    await budget.settle(allowed(await budget.reserve(req(t, 10, 1500))), { kind: 'refund' }); // the balance exists
    await drain();
    // A hold Redis doesn't know of makes Postgres refuse what Redis admitted.
    await pgl.hold({ id: randomUUID(), tenantId: t, period: P, estimate: 600, ttlMs: 300_000 });
    faults.reserveRunsThenFails = true;
    expect((await budget.reserve(req(t, 1000, 1500))).status).toBe('denied');
    faults.reserveRunsThenFails = false;
    expect(await redisBal(t, e)).toMatchObject({ spent: 0, reserved: 0 }); // no phantom
    expect(await count('budget_reservations', t)).toBe(1); // only the other hold
  });

  it('a request that ends unavailable after its Postgres hold was written leaves no row behind', async () => {
    const t = await newTenant();
    const budget = await newBudget({ pgLedger: { ...pgl, reserve: () => Promise.reject(new Error('down')) } });
    faults.down = true;
    expect((await budget.reserve(req(t, 100, 1000))).status).toBe('unavailable');
    expect(await count('budget_reservations', t)).toBe(0);
  });

  it('failed epoch bumps are retried with a back-off, not on every request', async () => {
    const t = await newTenant();
    let calls = 0;
    const pgLedger: PgLedger = { ...pgl, bumpEpoch: () => (calls++, Promise.reject(new Error('connection reset'))) };
    const budget = await newBudget({ pgLedger, outageFailures: 1, bumpBackoffBaseMs: 60_000 });
    faults.down = true;
    for (let i = 0; i < 20; i++) allowed(await budget.reserve(req(t, 10, 100_000)));
    expect(calls).toBe(1); // the first attempt; the next is a minute away
    expect(budget.mode()).toBe('postgres');
  });

  it('settles that find no balance at the new epoch do not make the next rebuild look like a lost balance', async () => {
    const t = await newTenant();
    const budget = await newBudget();
    const e0 = budget.epoch();
    const inFlight = allowed(await budget.reserve(req(t, 100, 100_000))); // held at e0
    await flush(t); // Redis restarted empty
    allowed(await budget.reserve(req(t, 100, 100_000))); // rebuilds at e0, and that moves the epoch on
    const waitUntil = Date.now() + 10_000;
    while (budget.epoch() === e0 && Date.now() < waitUntil) await new Promise((r) => setTimeout(r, 5));
    expect(budget.epoch()).toBe(e0 + 1);
    // Its settle lands at the new epoch, where no balance exists yet ...
    await budget.settle(inFlight, charge(50));
    // ... and the next reserve builds that balance for the first time. Nothing was lost: no second bump.
    allowed(await budget.reserve(req(t, 100, 100_000)));
    await budget.close(); // waits for any bump
    expect(await pgl.readEpoch()).toBe(e0 + 1);
  });

  it('a flush that takes the balances of many tenants costs one bump attempt, not one per tenant', async () => {
    let attempts = 0;
    const pgLedger: PgLedger = { ...pgl, bumpEpoch: (o) => (attempts++, pgl.bumpEpoch(o)) };
    const budget = await newBudget({ pgLedger });
    const e0 = budget.epoch();
    const tenants = await Promise.all(Array.from({ length: 20 }, () => newTenant()));
    for (const t of tenants) await budget.settle(allowed(await budget.reserve(req(t, 10, 100_000))), { kind: 'refund' });
    await Promise.all(tenants.map(flush));
    await Promise.all(tenants.map((t) => budget.reserve(req(t, 10, 100_000))));
    await budget.close();
    expect(attempts).toBe(1);
    expect(await pgl.readEpoch()).toBe(e0 + 1);
  });

  it('a settle whose charge committed is not treated as failed when the epoch read after it fails', async () => {
    const t = await newTenant();
    let settleCalls = 0;
    const pgLedger: PgLedger = { ...pgl, settle: (id, e) => (settleCalls++, pgl.settle(id, e)) };
    const budget = await newBudget({ pgLedger });
    const h = allowed(await budget.reserve(req(t, 1000, 10_000)));
    faults.failSettle = 1; // the queue script fails once, so the ledger is written here
    // Only the select of the epoch fails, once: the one right after the settle transaction commits.
    const query = handle.pool.query.bind(handle.pool) as (...a: unknown[]) => Promise<unknown>;
    let failed = false;
    const spy = vi.spyOn(handle.pool, 'query').mockImplementation(((...a: unknown[]) => {
      const text = String((a[0] as { text?: string })?.text ?? a[0]);
      if (!failed && /from "budget_epoch"/.test(text)) {
        failed = true;
        return Promise.reject(new Error('connection reset'));
      }
      return query(...a);
    }) as never);
    try {
      await budget.settle(h, charge(700));
    } finally {
      spy.mockRestore();
    }
    expect(failed).toBe(true);
    expect(settleCalls).toBe(1); // not retried
    expect(await pgSpent(t)).toBe(700);
    expect(await count('spend_ledger', t)).toBe(1);
    // Redis was still corrected, at the instance's own epoch.
    expect(await redisBal(t, budget.epoch())).toMatchObject({ spent: 700, reserved: 0 });
  });

  it('reserve reports unavailable when neither Redis nor Postgres can decide', async () => {
    const budget = await newBudget({ pgLedger: { ...pgl, reserve: () => Promise.reject(new Error('down')) } });
    faults.down = true;
    expect((await budget.reserve(req(await newTenant(), 100, 1000))).status).toBe('unavailable');
  });
});
