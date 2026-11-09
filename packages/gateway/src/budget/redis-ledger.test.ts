import { randomBytes, randomUUID } from 'node:crypto';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { testConfig } from '../test-env.ts';
import { periodOf } from './period.ts';
import { createRedisLedger, type RedisLedger, type Snapshot } from './redis-ledger.ts';

// A random prefix per run: parallel files and other worktrees never share a key.
const base = testConfig();
const prefix = base.redisKeyPrefix;
const P = periodOf(Date.now()); // only names the keys; the clock below is pinned
const T0 = 1_700_000_000_000;
let now = T0;
let redis: Redis;
const tenant = () => `t-${randomBytes(6).toString('hex')}`;
const EMPTY: Snapshot = { spent: 0, charges: 0, holds: [] };

const ledger = (loadSnapshot: (t: string, p: string) => Promise<Snapshot> = async () => EMPTY): RedisLedger =>
  createRedisLedger({ redis, keyPrefix: prefix, timeoutMs: 30_000, loadSnapshot, clock: () => now });

const bal = async (t: string, period = P, epoch = 1) => {
  const h = await redis.hgetall(`${prefix}bud:{${t}}:${period}:${epoch}`);
  return { spent: Number(h.spent), reserved: Number(h.reserved), ver: Number(h.ver) };
};
const args = (t: string, estimate: number, cap: number, extra: object = {}) => ({
  tenantId: t, period: P, epoch: 1, id: randomUUID(), estimate, cap, ttlMs: 300_000, ...extra,
});
const release = (t: string, id: string) => ({ tenantId: t, period: P, epoch: 1, id, charges: 0, spentAfter: 0 });

// Stands in for tenant_spend: charges are numbered one at a time, as Postgres does under the row lock, and
// each carries the running total. The order they reach Redis in is up to the test.
function pgCounter() {
  let charges = 0;
  let spent = 0;
  return (actual: number) => {
    charges++;
    spent += actual;
    return { charges, spentAfter: spent };
  };
}

// Small deterministic generator, so a failing round can be replayed.
function mulberry32(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

beforeAll(() => {
  redis = new Redis(base.redisUrl!);
});
afterAll(async () => {
  const keys = await redis.keys(`${prefix}*`);
  if (keys.length) await redis.del(...keys);
  redis.disconnect();
});

describe('redis ledger', { timeout: 120_000 }, () => {
  it('50 concurrent reserves against a cap that fits 7 worst cases admit exactly 7', async () => {
    const l = ledger();
    const t = tenant();
    // 7 x 1000 fits in 7500; the 8th would reach 8000.
    const results = await Promise.all(Array.from({ length: 50 }, () => l.reserve(args(t, 1000, 7500))));
    expect(results.filter((r) => r.allowed)).toHaveLength(7);
    expect(results.filter((r) => !r.allowed)).toHaveLength(43);
    expect(await bal(t)).toMatchObject({ spent: 0, reserved: 7000 });
    // Every refusal reports the same remaining room: what was left, not what was asked.
    expect(new Set(results.filter((r) => !r.allowed).map((r) => r.remaining))).toEqual(new Set([500]));
  });

  it('settle releases the reservation and charges actual; settled spend never exceeds the cap over 200 randomised concurrent rounds', async () => {
    const l = ledger();
    const rand = mulberry32(20261109);
    const yieldSome = async () => {
      for (let i = Math.floor(rand() * 4); i > 0; i--) await new Promise((r) => setImmediate(r));
    };
    let admittedTotal = 0;
    for (let round = 0; round < 200; round++) {
      const t = tenant();
      const pg = pgCounter();
      const cap = 3000 + Math.floor(rand() * 7000);
      const plans = Array.from({ length: 20 }, () => {
        const estimate = 500 + Math.floor(rand() * 1500);
        return { estimate, actual: Math.floor(estimate * (0.3 + rand() * 0.7)) };
      });
      const charged = await Promise.all(
        plans.map(async (p) => {
          const a = args(t, p.estimate, cap);
          await yieldSome();
          const r = await l.reserve(a);
          if (!r.allowed) return 0;
          await yieldSome();
          // Postgres numbers the charge, then it reaches Redis in whatever order the tasks interleave.
          const rec = pg(p.actual);
          await yieldSome();
          await l.settle({ tenantId: t, period: P, epoch: 1, id: a.id, ...rec });
          return p.actual;
        }),
      );
      const settled = charged.reduce((s, c) => s + c, 0);
      const b = await bal(t);
      expect(b.spent).toBe(settled);
      expect(b.reserved).toBe(0);
      expect(b.spent).toBeLessThanOrEqual(cap);
      admittedTotal += charged.filter((c) => c > 0).length;
    }
    // Not vacuous: money really was admitted and charged.
    expect(admittedTotal).toBeGreaterThan(200);
  });

  it('settle is idempotent and order-independent', async () => {
    const l = ledger();
    const t = tenant();
    const pg = pgCounter();
    const [a, b] = [args(t, 1000, 5000), args(t, 1000, 5000)];
    expect((await l.reserve(a)).allowed && (await l.reserve(b)).allowed).toBe(true);
    const first = pg(700);
    const second = pg(300);
    // The later charge arrives first and already includes the earlier one.
    expect(await l.settle({ tenantId: t, period: P, epoch: 1, id: b.id, ...second })).toBe('changed');
    expect(await bal(t)).toMatchObject({ spent: 1000, reserved: 1000, ver: 2 });
    expect(await l.settle({ tenantId: t, period: P, epoch: 1, id: a.id, ...first })).toBe('changed');
    expect(await bal(t)).toMatchObject({ spent: 1000, reserved: 0, ver: 2 });
    // Repeats change nothing.
    expect(await l.settle({ tenantId: t, period: P, epoch: 1, id: a.id, ...first })).toBe('unchanged');
    expect(await l.settle({ tenantId: t, period: P, epoch: 1, id: b.id, ...second })).toBe('unchanged');
    expect(await bal(t)).toMatchObject({ spent: 1000, reserved: 0, ver: 2 });
  });

  it('a refund releases the hold and charges nothing', async () => {
    const l = ledger();
    const t = tenant();
    const a = args(t, 1000, 1000);
    expect((await l.reserve(a)).allowed).toBe(true);
    expect((await l.reserve(args(t, 1, 1000))).allowed).toBe(false); // full
    await l.settle(release(t, a.id));
    expect(await bal(t)).toMatchObject({ spent: 0, reserved: 0 });
    expect((await l.reserve(args(t, 1000, 1000))).allowed).toBe(true);
  });

  it('expired reservation is released without a settle', async () => {
    const l = ledger();
    const t = tenant();
    const pg = pgCounter();
    const first = args(t, 600, 1000, { ttlMs: 1000 });
    expect((await l.reserve(first)).allowed).toBe(true);
    expect((await l.reserve(args(t, 600, 1000))).allowed).toBe(false);
    now = T0 + 999;
    expect((await l.reserve(args(t, 600, 1000))).allowed).toBe(false); // still held
    now = T0 + 1001;
    expect((await l.reserve(args(t, 600, 1000))).allowed).toBe(true);
    // Only the new hold remains; the lapsed one was released, not charged.
    expect(await bal(t)).toMatchObject({ spent: 0, reserved: 600 });
    // A call that outlives its hold still settles: its real spend is charged, never lost.
    await l.settle({ tenantId: t, period: P, epoch: 1, id: first.id, ...pg(400) });
    expect(await bal(t)).toMatchObject({ spent: 400, reserved: 600 });
    now = T0;
  });

  it("missing balance triggers rebuild from Postgres; two concurrent rebuilds don't double it", async () => {
    const t = tenant();
    let release!: () => void;
    const slow = new Promise<void>((r) => (release = r));
    const calls = { slow: 0, fast: 0 };
    const snap = { spent: 4000, charges: 7, holds: [] };
    // Instance A reads Postgres (4000) and is then held up before it can write the balance.
    const a = ledger(async () => {
      calls.slow++;
      await slow;
      return snap;
    });
    const b = ledger(async () => {
      calls.fast++;
      return snap;
    });
    const stuck = a.reserve(args(t, 100, 10_000));
    // Meanwhile B rebuilds, reserves and settles a real charge on the new balance.
    const mine = args(t, 100, 10_000);
    expect((await b.reserve(mine)).allowed).toBe(true);
    await b.settle({ tenantId: t, period: P, epoch: 1, id: mine.id, charges: 8, spentAfter: 4060 });
    expect(await bal(t)).toMatchObject({ spent: 4060, reserved: 0, ver: 8 });
    // A's stale rebuild now lands. It must find the balance there and leave it alone.
    release();
    expect((await stuck).allowed).toBe(true);
    expect(await bal(t)).toMatchObject({ spent: 4060, reserved: 100, ver: 8 });
    expect(calls).toEqual({ slow: 1, fast: 1 });
    // An existing balance is not rebuilt again.
    await a.reserve(args(t, 100, 10_000));
    expect(calls.slow).toBe(1);
  });

  it('a rebuilt balance counts the live holds, releases them on settle, and does not count a charge it already holds twice', async () => {
    const t = tenant();
    const live = randomUUID();
    const l = ledger(async () => ({ spent: 4000, charges: 7, holds: [{ id: live, amount: 3000, ttlMs: 60_000 }] }));
    // 4000 settled + 3000 held leaves 3000 under a 10000 cap.
    expect((await l.reserve(args(t, 3001, 10_000))).allowed).toBe(false);
    expect((await l.reserve(args(t, 3000, 10_000))).allowed).toBe(true);
    expect(await bal(t)).toMatchObject({ spent: 4000, reserved: 6000, ver: 7 });
    // The charge numbered 7 was recorded before the snapshot: the balance already holds it.
    await l.settle({ tenantId: t, period: P, epoch: 1, id: randomUUID(), charges: 7, spentAfter: 4000 });
    expect(await bal(t)).toMatchObject({ spent: 4000, reserved: 6000, ver: 7 });
    // The rebuilt hold settles like any other: released once, its charge (number 8) added once.
    const settle = { tenantId: t, period: P, epoch: 1, id: live, charges: 8, spentAfter: 4200 };
    await l.settle(settle);
    await l.settle(settle);
    expect(await bal(t)).toMatchObject({ spent: 4200, reserved: 3000, ver: 8 });
    // And it lapses on its own clock: 60 s after the rebuild.
    now = T0 + 61_000;
    expect((await l.reserve(args(t, 1, 10_000))).allowed).toBe(true);
    now = T0;
  });

  it('holds a rebuild imported for requests not yet decided are decided by arrival: exactly the money that fits is admitted', async () => {
    // 30 requests wrote their hold to Postgres first (61 each) and none has reached Redis yet. The first of
    // them rebuilds the balance, which imports all 30. The cap fits three.
    const t = tenant();
    const ids = Array.from({ length: 30 }, () => randomUUID());
    const l = ledger(async () => ({ spent: 0, charges: 0, holds: ids.map((id) => ({ id, amount: 61, ttlMs: 60_000 })) }));
    const results = await Promise.all(ids.map((id) => l.reserve({ tenantId: t, period: P, epoch: 1, id, estimate: 61, cap: 190, ttlMs: 60_000 })));
    expect(results.filter((r) => r.allowed)).toHaveLength(3);
    expect(await bal(t)).toMatchObject({ spent: 0, reserved: 183 });
    // A retry of one that was admitted is admitted again without being held twice.
    const admitted = ids[results.findIndex((r) => r.allowed)]!;
    expect((await l.reserve({ tenantId: t, period: P, epoch: 1, id: admitted, estimate: 61, cap: 190, ttlMs: 60_000 })).allowed).toBe(true);
    expect(await bal(t)).toMatchObject({ reserved: 183 });
  });

  it('rebuilt spend counts against the cap', async () => {
    const l = ledger(async () => ({ spent: 9500, charges: 3, holds: [] }));
    const t = tenant();
    expect((await l.reserve(args(t, 600, 10_000))).allowed).toBe(false);
    expect((await l.reserve(args(t, 500, 10_000))).allowed).toBe(true);
  });

  it('period rolls over: a new month starts from its own balance', async () => {
    const seen: string[] = [];
    const l = ledger(async (_t, p) => {
      seen.push(p);
      return EMPTY;
    });
    const t = tenant();
    const [y, m] = P.split('-').map(Number) as [number, number];
    const next = periodOf(Date.UTC(y, m, 1)); // the following month
    expect((await l.reserve(args(t, 1000, 1000))).allowed).toBe(true);
    expect((await l.reserve(args(t, 1, 1000))).allowed).toBe(false);
    expect((await l.reserve(args(t, 1000, 1000, { period: next }))).allowed).toBe(true);
    expect(seen).toEqual([P, next]);
    expect(await bal(t, P)).toMatchObject({ spent: 0, reserved: 1000 });
    expect(await bal(t, next)).toMatchObject({ spent: 0, reserved: 1000 });
  });
});
