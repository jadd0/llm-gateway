import { randomBytes, randomUUID } from 'node:crypto';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { testConfig } from '../test-env.ts';
import { periodOf } from './period.ts';
import { createRedisLedger, type RedisLedger } from './redis-ledger.ts';

// A random prefix per run: parallel files and other worktrees never share a key.
const base = testConfig();
const prefix = base.redisKeyPrefix;
const P = periodOf(Date.now()); // only names the keys; the clock below is pinned
const T0 = 1_700_000_000_000;
let now = T0;
let redis: Redis;
const tenant = () => `t-${randomBytes(6).toString('hex')}`;

const ledger = (loadSpent: (t: string, p: string) => Promise<number> = async () => 0): RedisLedger =>
  createRedisLedger({ redis, keyPrefix: prefix, timeoutMs: 30_000, loadSpent, doneTtlS: 600, clock: () => now });

const bal = async (t: string, period = P, epoch = 1) => {
  const h = await redis.hgetall(`${prefix}bud:{${t}}:${period}:${epoch}`);
  return { spent: Number(h.spent), reserved: Number(h.reserved) };
};
const args = (t: string, estimate: number, cap: number, extra: object = {}) => ({
  tenantId: t, period: P, epoch: 1, id: randomUUID(), estimate, cap, ttlMs: 300_000, ...extra,
});

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
    expect(await bal(t)).toEqual({ spent: 0, reserved: 7000 });
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
          await l.settle({ tenantId: t, period: P, epoch: 1, id: a.id, actual: p.actual });
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

  it('settle is idempotent', async () => {
    const l = ledger();
    const t = tenant();
    const a = args(t, 1000, 5000);
    expect((await l.reserve(a)).allowed).toBe(true);
    const s = { tenantId: t, period: P, epoch: 1, id: a.id, actual: 700 };
    expect(await l.settle(s)).toBe('applied');
    expect(await l.settle(s)).toBe('duplicate');
    expect(await l.settle({ ...s, actual: 900 })).toBe('duplicate');
    expect(await bal(t)).toEqual({ spent: 700, reserved: 0 });
  });

  it('a refund releases the hold and charges nothing', async () => {
    const l = ledger();
    const t = tenant();
    const a = args(t, 1000, 1000);
    expect((await l.reserve(a)).allowed).toBe(true);
    expect((await l.reserve(args(t, 1, 1000))).allowed).toBe(false); // full
    await l.settle({ tenantId: t, period: P, epoch: 1, id: a.id, actual: 0 });
    expect(await bal(t)).toEqual({ spent: 0, reserved: 0 });
    expect((await l.reserve(args(t, 1000, 1000))).allowed).toBe(true);
  });

  it('expired reservation is released without a settle', async () => {
    const l = ledger();
    const t = tenant();
    const first = args(t, 600, 1000, { ttlMs: 1000 });
    expect((await l.reserve(first)).allowed).toBe(true);
    expect((await l.reserve(args(t, 600, 1000))).allowed).toBe(false);
    now = T0 + 999;
    expect((await l.reserve(args(t, 600, 1000))).allowed).toBe(false); // still held
    now = T0 + 1001;
    const next = args(t, 600, 1000);
    expect((await l.reserve(next)).allowed).toBe(true);
    // Only the new hold remains; the lapsed one was released, not charged.
    expect(await bal(t)).toEqual({ spent: 0, reserved: 600 });
    // A call that outlives its hold still settles: its real spend is charged, never lost.
    expect(await l.settle({ tenantId: t, period: P, epoch: 1, id: first.id, actual: 400 })).toBe('applied');
    expect(await bal(t)).toEqual({ spent: 400, reserved: 600 });
    now = T0;
  });

  it("missing balance triggers rebuild from Postgres; two concurrent rebuilds don't double it", async () => {
    const calls: Array<[string, string]> = [];
    const loadSpent = async (t: string, p: string) => {
      calls.push([t, p]);
      await new Promise((r) => setTimeout(r, 20)); // both rebuilds are in flight together
      return 4000;
    };
    const t = tenant();
    const a = ledger(loadSpent);
    const b = ledger(loadSpent);
    const [ra, rb] = await Promise.all([a.reserve(args(t, 100, 10_000)), b.reserve(args(t, 100, 10_000))]);
    expect(ra.allowed && rb.allowed).toBe(true);
    // Both read Postgres (the balance was missing for both) but the spend was set once.
    expect(calls).toHaveLength(2);
    expect(await bal(t)).toEqual({ spent: 4000, reserved: 200 });
    // An existing balance is not rebuilt again.
    await a.reserve(args(t, 100, 10_000));
    expect(calls).toHaveLength(2);
  });

  it('rebuilt spend counts against the cap', async () => {
    const l = ledger(async () => 9500);
    const t = tenant();
    expect((await l.reserve(args(t, 600, 10_000))).allowed).toBe(false);
    expect((await l.reserve(args(t, 500, 10_000))).allowed).toBe(true);
  });

  it('period rolls over: a new month starts from its own balance', async () => {
    const seen: string[] = [];
    const l = ledger(async (_t, p) => {
      seen.push(p);
      return 0;
    });
    const t = tenant();
    const [y, m] = P.split('-').map(Number) as [number, number];
    const next = periodOf(Date.UTC(y, m, 1)); // the following month
    expect((await l.reserve(args(t, 1000, 1000))).allowed).toBe(true);
    expect((await l.reserve(args(t, 1, 1000))).allowed).toBe(false);
    expect((await l.reserve(args(t, 1000, 1000, { period: next }))).allowed).toBe(true);
    expect(seen).toEqual([P, next]);
    expect(await bal(t, P)).toEqual({ spent: 0, reserved: 1000 });
    expect(await bal(t, next)).toEqual({ spent: 0, reserved: 1000 });
  });
});
