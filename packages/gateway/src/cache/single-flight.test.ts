import { randomBytes } from 'node:crypto';
import { Redis } from 'ioredis';
import { afterAll, describe, expect, it } from 'vitest';
import { testConfig } from '../test-env.ts';
import type { CachedCompletion } from './replay.ts';
import { createSingleFlight, type Acquired, type SingleFlight } from './single-flight.ts';
import { createCacheStore } from './store.ts';

const config = testConfig();
const redis = new Redis(config.redisUrl!);
const prefix = `${config.redisKeyPrefix}sf-${randomBytes(4).toString('hex')}:`;
const store = createCacheStore({ redis, ttlS: 60, maxEntryBytes: 10_000, timeoutMs: 500 });
const flights: SingleFlight[] = [];
const make = (over: { lockMs?: number; waitMs?: number } = {}) => {
  const sf = createSingleFlight({ redis, lockMs: 5_000, waitMs: 2_000, timeoutMs: 500, ...over });
  flights.push(sf);
  return sf;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let n = 0;
const freshKey = () => `${prefix}k${n++}`;

afterAll(async () => {
  await Promise.all(flights.map((f) => f.close()));
  const keys = await redis.keys(`${prefix}*`);
  if (keys.length) await redis.del(...keys);
  redis.disconnect();
});

const answer = (content: string): CachedCompletion => ({ content, finishReason: 'stop', usage: null, model: 'mock-1' });
const read = async (key: string) => {
  const r = await store.get(key);
  return r.status === 'hit' ? r.entry : undefined;
};

// One request as the cache plugin treats a non-streamed miss: look, then lead, follow or go alone. `upstream`
// is the provider call; it returns what the leader fills.
async function request(sf: SingleFlight, key: string, upstream: () => Promise<string>, roles: string[] = []) {
  const first = await read(key);
  if (first) return first.content;
  const got: Acquired = await sf.acquire(key);
  roles.push(got.role);
  if (got.role === 'follower') {
    const served = await got.wait(() => read(key));
    if (served) return served.content;
  }
  const content = await upstream();
  if (got.role === 'leader') {
    await store.set(key, answer(content));
    got.finish('filled');
  }
  return content;
}

describe('single flight', () => {
  it('50 concurrent identical misses make one upstream call', async () => {
    const sf = make();
    const key = freshKey();
    let upstreamCalls = 0;
    const upstream = async () => {
      upstreamCalls++;
      await sleep(150);
      return 'the answer';
    };
    const roles: string[] = [];
    const results = await Promise.all(Array.from({ length: 50 }, () => request(sf, key, upstream, roles)));
    expect(upstreamCalls).toBe(1);
    expect(results).toHaveLength(50);
    expect(results.every((r) => r === 'the answer')).toBe(true);
    expect(roles.filter((r) => r === 'leader')).toHaveLength(1);
    expect(roles.filter((r) => r === 'follower')).toHaveLength(49);
    await sf.idle();
    expect(await redis.exists(`${key}:lock`)).toBe(0); // the lock is released when the fill is done
  });

  it('waiters across two plugin instances are served from the leader', async () => {
    const a = make();
    const b = make();
    const key = freshKey();
    let upstreamCalls = 0;
    const upstream = async () => {
      upstreamCalls++;
      await sleep(300);
      return 'from the leader';
    };
    const leader = request(a, key, upstream);
    await sleep(50); // the leader holds the lock before anyone in the other process asks
    const rolesB: string[] = [];
    const followers = await Promise.all(Array.from({ length: 10 }, () => request(b, key, upstream, rolesB)));
    expect(await leader).toBe('from the leader');
    expect(upstreamCalls).toBe(1);
    expect(rolesB).toEqual(Array(10).fill('follower'));
    expect(followers.every((r) => r === 'from the leader')).toBe(true);
  });

  it('a follower that subscribes after the fill landed still gets it', async () => {
    const a = make();
    const b = make();
    const key = freshKey();
    const lead = await a.acquire(key);
    expect(lead.role).toBe('leader');
    const follow = await b.acquire(key);
    expect(follow.role).toBe('follower');
    // The fill and its notification happen before the follower has started listening to anything.
    await store.set(key, answer('early'));
    if (lead.role === 'leader') lead.finish('filled');
    await a.idle();
    const started = performance.now();
    if (follow.role !== 'follower') throw new Error('unreachable');
    expect((await follow.wait(() => read(key)))?.content).toBe('early');
    expect(performance.now() - started).toBeLessThan(1000); // by the first read, not by running out the wait
  });

  it('leader failure lets waiters go upstream', async () => {
    for (const where of ['same process', 'other process']) {
      const a = make();
      const b = where === 'same process' ? a : make();
      const key = freshKey();
      let upstreamCalls = 0;
      let leaderFails = true;
      const upstream = async () => {
        upstreamCalls++;
        await sleep(100);
        if (leaderFails && upstreamCalls === 1) throw new Error('upstream 500');
        return 'recovered';
      };
      const lead = await a.acquire(key);
      expect(lead.role).toBe('leader');
      const waiting = Array.from({ length: 5 }, () => request(b, key, upstream));
      await sleep(50);
      // The leader's request fails: nothing is stored.
      if (lead.role === 'leader') lead.finish('failed');
      leaderFails = false;
      const results = await Promise.all(waiting);
      // Each waiter made its own upstream call and none inherited the leader's failure.
      expect(results, where).toEqual(Array(5).fill('recovered'));
      expect(upstreamCalls, where).toBeGreaterThanOrEqual(5);
    }
  });

  it('wait timeout falls through to upstream', async () => {
    const a = make({ waitMs: 150 });
    const key = freshKey();
    const lead = await a.acquire(key); // never finishes
    expect(lead.role).toBe('leader');
    for (const sf of [a, make({ waitMs: 150 })]) {
      const follow = await sf.acquire(key);
      expect(follow.role).toBe('follower');
      const started = performance.now();
      if (follow.role !== 'follower') throw new Error('unreachable');
      expect(await follow.wait(() => read(key))).toBeUndefined();
      const waited = performance.now() - started;
      expect(waited).toBeGreaterThanOrEqual(140);
      expect(waited).toBeLessThan(1000);
    }
    // A fill that landed without any notification is found by the read made when the wait runs out.
    const late = await make({ waitMs: 300 }).acquire(key);
    if (late.role !== 'follower') throw new Error('expected a follower');
    const waiting = late.wait(() => read(key));
    await sleep(50);
    await store.set(key, answer('quiet fill'));
    expect((await waiting)?.content).toBe('quiet fill');
  });

  it('a leader that never reports is dropped when its lock would have lapsed', async () => {
    const sf = make({ lockMs: 100, waitMs: 50 });
    const key = freshKey();
    expect((await sf.acquire(key)).role).toBe('leader');
    expect((await sf.acquire(key)).role).toBe('follower');
    await sleep(250);
    await sf.idle();
    expect((await sf.acquire(key)).role).toBe('leader'); // the next burst gets a leader of its own
  });

  it('a lock that lapsed and was taken by another leader is not deleted by the old one', async () => {
    const a = make({ lockMs: 100 });
    const key = freshKey();
    const old = await a.acquire(key);
    if (old.role !== 'leader') throw new Error('expected a leader');
    await sleep(150); // the lock lapsed
    await redis.set(`${key}:lock`, 'someone-else', 'PX', 5_000);
    old.finish('failed');
    await a.idle();
    expect(await redis.get(`${key}:lock`)).toBe('someone-else');
  });

  it('redis down means no leader: the request goes upstream alone', async () => {
    const dead = new Redis('redis://127.0.0.1:1', { enableOfflineQueue: false, lazyConnect: true, retryStrategy: () => null });
    dead.on('error', () => {});
    const sf = createSingleFlight({ redis: dead, lockMs: 5_000, waitMs: 2_000, timeoutMs: 50 });
    expect((await sf.acquire(freshKey())).role).toBe('solo');
    await sf.close();
    dead.disconnect();
  });
});
