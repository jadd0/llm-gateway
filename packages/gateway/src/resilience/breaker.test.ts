import { randomBytes } from 'node:crypto';
import { Redis } from 'ioredis';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { cleanup, testConfig } from '../test-env.ts';
import { createBreaker, type Breaker, type BreakerSettings } from './breaker.ts';

// The run's own Redis prefix, so parallel files and other worktrees never share a key. A pinned clock makes
// every count exact: the window only moves when a test moves it.
const base = testConfig();
const prefix = base.redisKeyPrefix;
const settings: BreakerSettings = { windowMs: 10_000, minFailures: 5, failureRatio: 0.5, openMs: 15_000 };
const T0 = 1_700_000_000_000;
let now = T0;
let redis: Redis;

const make = (over: { redis?: Redis | null; redisTimeoutMs?: number; redisRetryMs?: number; target?: string } = {}) =>
  createBreaker({
    redis: over.redis === undefined ? redis : over.redis,
    keyPrefix: prefix,
    settings,
    redisTimeoutMs: over.redisTimeoutMs ?? 5_000,
    redisRetryMs: over.redisRetryMs ?? 1000,
    probeTtlMs: 125_000,
    clock: () => now,
  });
let n = 0;
const target = () => `t${++n}-${randomBytes(4).toString('hex')}`;

async function record(b: Breaker, t: string, results: Array<'success' | 'failure' | 'answered'>) {
  for (const r of results) {
    const a = await b.acquire(t);
    if (!a.allowed) throw new Error('breaker was open');
    await b.record(a.permit, r);
  }
}
const fails = (k: number) => Array.from({ length: k }, () => 'failure' as const);

beforeAll(() => {
  redis = new Redis(base.redisUrl!);
});
afterEach(() => {
  now = T0;
});
afterAll(async () => {
  await cleanup({} as never, redis, [], prefix);
  redis.disconnect();
});

describe('breaker (real Redis)', () => {
  it('opens at min failures and ratio', async () => {
    const b = make();
    const t = target();
    // 4 failures, 6 successes: not enough failures, ratio 0.4.
    await record(b, t, [...fails(4), ...Array.from({ length: 6 }, () => 'success' as const)]);
    expect((await b.acquire(t)).allowed).toBe(true);
    // The 5th failure makes 5 of 11: ratio 0.45, under 0.5, stays closed.
    await record(b, t, fails(1));
    expect((await b.acquire(t)).allowed).toBe(true);
    // The 6th: 6 of 12 is exactly the ratio, and 6 >= 5 failures: opens.
    await record(b, t, fails(1));
    const blocked = await b.acquire(t);
    expect(blocked).toEqual({ allowed: false, retryInMs: 15_000 });
  });

  it('does not open below min failures even at 100% failure', async () => {
    const b = make();
    const t = target();
    await record(b, t, fails(4));
    expect((await b.acquire(t)).allowed).toBe(true);
    await record(b, t, fails(1));
    expect((await b.acquire(t)).allowed).toBe(false);
  });

  it('failures that fall out of the rolling window stop counting', async () => {
    const b = make();
    const t = target();
    await record(b, t, fails(4));
    now += 10_000; // the 4 failures are now outside the 10 s window
    await record(b, t, fails(4));
    expect((await b.acquire(t)).allowed).toBe(true);
  });

  it('open skips without a call', async () => {
    const b = make();
    const t = target();
    await record(b, t, fails(5));
    now += 14_000;
    expect(await b.acquire(t)).toEqual({ allowed: false, retryInMs: 1_000 });
    // A different target is its own breaker.
    expect((await b.acquire(target())).allowed).toBe(true);
  });

  it('half-open lets exactly one probe through across two breaker instances', async () => {
    const a = make();
    const b = make();
    const t = target();
    await record(a, t, fails(5));
    now += 15_000;
    const results = await Promise.all(
      Array.from({ length: 40 }, (_, i) => (i % 2 === 0 ? a : b).acquire(t)),
    );
    const allowed = results.filter((r) => r.allowed);
    expect(allowed).toHaveLength(1);
    expect(allowed[0]).toMatchObject({ allowed: true, permit: { probe: true } });
    expect(results.filter((r) => !r.allowed)).toHaveLength(39);
  });

  it('probe success closes, probe failure reopens', async () => {
    const b = make();
    const t = target();
    await record(b, t, fails(5));
    now += 15_000;
    const probe = await b.acquire(t);
    if (!probe.allowed) throw new Error('no probe');
    await b.record(probe.permit, 'failure');
    expect(await b.acquire(t)).toEqual({ allowed: false, retryInMs: 15_000 });

    now += 15_000;
    const second = await b.acquire(t);
    if (!second.allowed) throw new Error('no second probe');
    expect(second.permit.probe).toBe(true);
    await b.record(second.permit, 'success');
    // Closed with a fresh window: four failures no longer carry over to the next.
    expect((await b.acquire(t)).allowed).toBe(true);
    await record(b, t, fails(4));
    expect((await b.acquire(t)).allowed).toBe(true);
  });

  it('an abandoned probe hands the probe to the next caller', async () => {
    const b = make();
    const t = target();
    await record(b, t, fails(5));
    now += 15_000;
    const probe = await b.acquire(t);
    if (!probe.allowed) throw new Error('no probe');
    expect((await b.acquire(t)).allowed).toBe(false);
    await b.record(probe.permit, 'abandoned');
    expect(await b.acquire(t)).toMatchObject({ allowed: true, permit: { probe: true } });
  });

  it('4xx outcomes never count', async () => {
    const b = make();
    const t = target();
    // Twenty answers that were the client's fault between four failures: still closed.
    await record(b, t, [...fails(4), ...Array.from({ length: 20 }, () => 'answered' as const)]);
    expect((await b.acquire(t)).allowed).toBe(true);
    // And they do not dilute the ratio either: the 5th failure opens it.
    await record(b, t, fails(1));
    expect((await b.acquire(t)).allowed).toBe(false);
  });
});

describe('breaker with Redis down', () => {
  it('Redis down falls back to the local breaker within the timeout', async () => {
    // A Redis that never answers: the script call hangs.
    const hung = { defineCommand() {}, brk: () => new Promise<number[]>(() => {}) } as unknown as Redis;
    const b = make({ redis: hung, redisTimeoutMs: 40 });
    const t = target();
    const started = performance.now();
    const first = await b.acquire(t);
    const waited = performance.now() - started;
    expect(first.allowed).toBe(true);
    expect(waited).toBeLessThan(400);
    // The local breaker is a working breaker: five failures open it.
    for (let i = 0; i < 5; i++) {
      const a = await b.acquire(t);
      if (!a.allowed) throw new Error('opened early');
      await b.record(a.permit, 'failure');
    }
    const blocked = await b.acquire(t);
    expect(blocked.allowed).toBe(false);
    // Redis is left alone after its failure, so these calls cost no further waiting.
    const t2 = performance.now();
    for (let i = 0; i < 20; i++) await b.acquire(t);
    expect(performance.now() - t2).toBeLessThan(200);
  });

  it('local state dropped when Redis returns', async () => {
    let broken = true;
    const flaky = {
      defineCommand: (name: string, def: object) => (redis as any).defineCommand(name, def),
      brk: (...a: unknown[]) => (broken ? Promise.reject(new Error('down')) : (redis as any).brk(...a)),
    } as unknown as Redis;
    const b = make({ redis: flaky, redisRetryMs: 0 });
    const t = target();
    for (let i = 0; i < 5; i++) {
      const a = await b.acquire(t);
      if (!a.allowed) throw new Error('opened early');
      await b.record(a.permit, 'failure');
    }
    expect((await b.acquire(t)).allowed).toBe(false); // the local breaker is open
    broken = false;
    // Redis answers and knows nothing of those failures: closed again, and the local state is gone.
    const back = await b.acquire(t);
    expect(back).toMatchObject({ allowed: true, permit: { source: 'redis' } });
    broken = true;
    expect(await b.acquire(t)).toMatchObject({ allowed: true, permit: { source: 'local' } });
  });
});
