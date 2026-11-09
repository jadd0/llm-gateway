import { randomUUID } from 'node:crypto';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { testConfig } from '../test-env.ts';
import { periodOf } from './period.ts';
import { fromStreamFields } from '../requestlog/entry.ts';
import { assertNotCluster, createRedisLedger, type RedisLedger, type SettleArgs, type Snapshot } from './redis-ledger.ts';

// A random prefix per run: parallel files and other worktrees never share a key.
const base = testConfig();
const prefix = base.redisKeyPrefix;
const P = periodOf(Date.now()); // only names the keys; the clock below is pinned
const T0 = 1_700_000_000_000;
let now = T0;
let redis: Redis;
const tenant = () => randomUUID();
const EMPTY: Snapshot = { spent: 0, charges: 0, holds: [] };

const ledger = (loadSnapshot: (t: string, p: string) => Promise<Snapshot> = async () => EMPTY): RedisLedger =>
  createRedisLedger({ redis, keyPrefix: prefix, timeoutMs: 30_000, loadSnapshot, clock: () => now });

const bal = async (t: string, period = P, epoch = 1) => {
  const h = await redis.hgetall(`${prefix}bud:{${t}}:${period}:${epoch}`);
  return { spent: Number(h.spent), reserved: Number(h.reserved) };
};
const args = (t: string, estimate: number, cap: number, extra: object = {}) => ({
  tenantId: t, period: P, epoch: 1, id: randomUUID(), estimate, cap, ttlMs: 300_000, ...extra,
});
// A settle as the budget sends it: a charge of `cost`, or a refund when cost is 0.
const settleArgs = (t: string, id: string, cost: number, extra: Partial<SettleArgs> = {}): SettleArgs => ({
  tenantId: t, period: P, epoch: 1,
  entry: {
    kind: cost > 0 ? 'charge' : 'refund', id, tenantId: t, period: P, model: 'mock-ok', promptTokens: 1,
    completionTokens: 2, costMicros: cost, estimated: false, savedMicros: 0,
  },
  ...extra,
});
const queued = async () => (await redis.xrange(`${prefix}requestlog:spend`, '-', '+')).map(([, f]) => fromStreamFields(f));

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
          await yieldSome();
          await l.settle(settleArgs(t, a.id, p.actual));
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

  it('settles land on the same balance in any order, and each queues exactly one entry', async () => {
    const l = ledger();
    const t = tenant();
    const [a, b] = [args(t, 1000, 5000), args(t, 1000, 5000)];
    expect((await l.reserve(a)).allowed && (await l.reserve(b)).allowed).toBe(true);
    expect(await l.settle(settleArgs(t, b.id, 300))).toBe('changed');
    expect(await bal(t)).toMatchObject({ spent: 300, reserved: 1000 });
    expect(await l.settle(settleArgs(t, a.id, 700))).toBe('changed');
    expect(await bal(t)).toMatchObject({ spent: 1000, reserved: 0 });
    const entries = (await queued()).filter((e) => e.kind === 'spend' && ([a.id, b.id] as string[]).includes(e.entry.id));
    expect(entries.map((e) => (e.kind === 'spend' ? [e.entry.id, e.entry.kind, e.entry.costMicros] : null))).toEqual([
      [b.id, 'charge', 300],
      [a.id, 'charge', 700],
    ]);
  });

  it('settle and its stream entry are one script: when the entry cannot be written, the balance and the hold are untouched', async () => {
    const l = ledger();
    const t = tenant();
    const a = args(t, 1000, 5000);
    expect((await l.reserve(a)).allowed).toBe(true);
    const key = `${prefix}requestlog:spend`;
    const before = await redis.xlen(key).catch(() => 0);
    // A string where the stream should be makes XADD fail (WRONGTYPE) inside the script.
    await redis.del(key);
    await redis.set(key, 'not a stream');
    await expect(l.settle(settleArgs(t, a.id, 700))).rejects.toThrow(/WRONGTYPE/);
    expect(await bal(t)).toMatchObject({ spent: 0, reserved: 1000 });
    expect(await redis.hget(`${prefix}bud:{${t}}:${P}:1:amt`, a.id)).toBe('1000');
    // With the stream back, the same settle goes through and queues once.
    await redis.del(key);
    expect(await l.settle(settleArgs(t, a.id, 700))).toBe('changed');
    expect(await bal(t)).toMatchObject({ spent: 700, reserved: 0 });
    expect(await redis.xlen(key)).toBe(1);
    expect(before).toBeGreaterThanOrEqual(0);
  });

  it('a settle for a balance that is gone is still queued, and reports a rebuild', async () => {
    const l = ledger();
    const t = tenant();
    const id = randomUUID();
    const n = (await queued()).length;
    expect(await l.settle(settleArgs(t, id, 50))).toBe('rebuild');
    expect((await queued()).length).toBe(n + 1);
  });

  it('apply releases a hold the balance still has and adds its cost once; a balance that already took the settle ignores it', async () => {
    const l = ledger();
    const t = tenant();
    const [a, b] = [args(t, 1000, 5000), args(t, 1000, 5000)];
    await l.reserve(a);
    await l.reserve(b);
    // b settled on this balance (hold gone, spent includes it); a was queued while the balance was rebuilt, so its
    // hold is still here and its cost is not in spent.
    await l.settle(settleArgs(t, b.id, 300));
    const both = [
      { tenantId: t, period: P, id: a.id, costMicros: 700 },
      { tenantId: t, period: P, id: b.id, costMicros: 300 },
    ];
    expect(await l.apply(1, both)).toBe('changed');
    expect(await bal(t)).toMatchObject({ spent: 1000, reserved: 0 });
    // Repeating it, or running it from a second worker, adds nothing.
    expect(await l.apply(1, both)).toBe('unchanged');
    expect(await bal(t)).toMatchObject({ spent: 1000, reserved: 0 });
    // A charge for a request this balance holds no hold for is never added: with no hold there is no proof the
    // balance has not charged it already (its own settle, or a rebuild that counted it).
    expect(await l.apply(1, [{ tenantId: t, period: P, id: randomUUID(), costMicros: 40 }])).toBe('unchanged');
    expect(await bal(t)).toMatchObject({ spent: 1000, reserved: 0 });
    // No balance, nothing to catch up.
    expect(await l.apply(1, [{ tenantId: tenant(), period: P, id: randomUUID(), costMicros: 5 }])).toBe('unchanged');
  });

  it('a Redis Cluster is refused (the settle script spans the balance and the spend stream); a single Redis is not', async () => {
    const reply = (info: string) => ({ info: async () => info }) as unknown as Redis;
    await expect(assertNotCluster(reply('# Cluster\r\ncluster_enabled:1\r\n'))).rejects.toThrow(/Cluster is not supported/);
    await expect(assertNotCluster(reply('# Cluster\r\ncluster_enabled:0\r\n'))).resolves.toBeUndefined();
    await expect(assertNotCluster(redis)).resolves.toBeUndefined();
    // A Redis that does not answer is not a reason to refuse to start.
    await expect(assertNotCluster({ info: () => Promise.reject(new Error('down')) } as unknown as Redis)).resolves.toBeUndefined();
  });

  it('a refund releases the hold and charges nothing', async () => {
    const l = ledger();
    const t = tenant();
    const a = args(t, 1000, 1000);
    expect((await l.reserve(a)).allowed).toBe(true);
    expect((await l.reserve(args(t, 1, 1000))).allowed).toBe(false); // full
    await l.settle(settleArgs(t, a.id, 0));
    expect(await bal(t)).toMatchObject({ spent: 0, reserved: 0 });
    expect((await l.reserve(args(t, 1000, 1000))).allowed).toBe(true);
  });

  it('a hold is not released by time: it stays until a settle, so a settle still queued cannot be outrun', async () => {
    const l = ledger();
    const t = tenant();
    const first = args(t, 600, 1000, { ttlMs: 1000 });
    expect((await l.reserve(first)).allowed).toBe(true);
    now = T0 + 1_000_000; // far past its expiry
    expect((await l.reserve(args(t, 600, 1000))).allowed).toBe(false); // still held
    expect(await bal(t)).toMatchObject({ spent: 0, reserved: 600 });
    // Its settle (or the sweeper's apply) is what releases it, and the real spend is charged.
    await l.settle(settleArgs(t, first.id, 400));
    expect(await bal(t)).toMatchObject({ spent: 400, reserved: 0 });
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
    await b.settle(settleArgs(t, mine.id, 60));
    expect(await bal(t)).toMatchObject({ spent: 4060, reserved: 0 });
    // A's stale rebuild now lands. It must find the balance there and leave it alone.
    release();
    expect((await stuck).allowed).toBe(true);
    expect(await bal(t)).toMatchObject({ spent: 4060, reserved: 100 });
    expect(calls).toEqual({ slow: 1, fast: 1 });
    // An existing balance is not rebuilt again.
    await a.reserve(args(t, 100, 10_000));
    expect(calls.slow).toBe(1);
  });

  it('a rebuilt balance counts the live holds and releases them on settle', async () => {
    const t = tenant();
    const live = randomUUID();
    const l = ledger(async () => ({ spent: 4000, charges: 7, holds: [{ id: live, amount: 3000, ttlMs: 60_000 }] }));
    // 4000 settled + 3000 held leaves 3000 under a 10000 cap.
    expect((await l.reserve(args(t, 3001, 10_000))).allowed).toBe(false);
    expect((await l.reserve(args(t, 3000, 10_000))).allowed).toBe(true);
    expect(await bal(t)).toMatchObject({ spent: 4000, reserved: 6000 });
    // The rebuilt hold settles like any other: released, its charge added.
    await l.settle(settleArgs(t, live, 200));
    expect(await bal(t)).toMatchObject({ spent: 4200, reserved: 3000 });
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
