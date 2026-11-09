import { randomBytes } from 'node:crypto';
import net from 'node:net';
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
const make = (over: { lockMs?: number; waitMs?: number; pollMs?: number; timeoutMs?: number; redis?: Redis } = {}) => {
  const sf = createSingleFlight({ redis, lockMs: 5_000, waitMs: 2_000, pollMs: 100, timeoutMs: 500, ...over });
  flights.push(sf);
  return sf;
};

// A TCP forwarder in front of Redis whose traffic can be held back, as a Redis that stopped answering would.
async function freezable() {
  const url = new URL(config.redisUrl!);
  let frozen = false;
  const held: Array<() => void> = [];
  const sockets = new Set<net.Socket>();
  const server = net.createServer((client) => {
    const upstream = net.connect(Number(url.port || 6379), url.hostname);
    sockets.add(client).add(upstream);
    const pipe = (from: net.Socket, to: net.Socket) =>
      from.on('data', (d) => {
        const send = () => to.write(d);
        if (frozen) held.push(send);
        else send();
      });
    pipe(client, upstream);
    pipe(upstream, client);
    for (const s of [client, upstream]) s.on('error', () => {}).on('close', () => (client.destroy(), upstream.destroy()));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as net.AddressInfo).port;
  const clients: Redis[] = [];
  return {
    async client() {
      const c = new Redis({ host: '127.0.0.1', port, enableOfflineQueue: false, maxRetriesPerRequest: 1 });
      c.on('error', () => {});
      clients.push(c);
      await new Promise<void>((r) => (c.status === 'ready' ? r() : c.once('ready', () => r())));
      return c;
    },
    freeze: () => void (frozen = true),
    async close() {
      held.length = 0;
      for (const c of clients) c.disconnect();
      for (const s of sockets) s.destroy();
      await new Promise((r) => server.close(r));
    },
  };
}
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
const look = (key: string, from = store) => from.get(key);
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
    const served = await got.wait(() => look(key));
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
    expect((await follow.wait(() => look(key)))?.content).toBe('early');
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
    const lead = make({ waitMs: 5_000 });
    const key = freshKey();
    expect((await lead.acquire(key)).role).toBe('leader'); // never finishes, keeps renewing
    const follow = await make({ waitMs: 150, pollMs: 50 }).acquire(key);
    expect(follow.role).toBe('follower');
    const started = performance.now();
    if (follow.role !== 'follower') throw new Error('unreachable');
    expect(await follow.wait(() => look(key))).toBeUndefined();
    const waited = performance.now() - started;
    expect(waited).toBeGreaterThanOrEqual(140);
    expect(waited).toBeLessThan(1000);
  });

  it('a fill that landed without any notification is found by the next look', async () => {
    const lead = make({ waitMs: 5_000 });
    const key = freshKey();
    expect((await lead.acquire(key)).role).toBe('leader');
    const late = await make({ waitMs: 2_000, pollMs: 50 }).acquire(key);
    if (late.role !== 'follower') throw new Error('expected a follower');
    const waiting = late.wait(() => look(key));
    await sleep(60);
    const started = performance.now();
    await store.set(key, answer('quiet fill'));
    expect((await waiting)?.content).toBe('quiet fill');
    expect(performance.now() - started).toBeLessThan(500);
  });

  it('a leader whose request closed without a fill stops renewing, and is dropped within a few lock lifetimes', async () => {
    const sf = make({ lockMs: 300, waitMs: 20_000 });
    const key = freshKey();
    const lead = await sf.acquire(key);
    if (lead.role !== 'leader') throw new Error('expected a leader');
    expect((await sf.acquire(key)).role).toBe('follower');
    await sleep(500); // still open: renewed well past one lock lifetime
    expect(await redis.exists(`${key}:lock`)).toBe(1);
    lead.closed(); // the reply is over; finish is never called
    await sleep(450); // one lock lifetime and a margin
    expect(await redis.exists(`${key}:lock`)).toBe(0); // nobody renewed it: it lapsed on its own
    await sleep(400); // twice the lock lifetime in all
    await sf.idle();
    expect((await sf.acquire(key)).role).toBe('leader'); // the in-process flight is gone too
  });

  it('a request that is still open keeps its lock far past the longest wait', async () => {
    const sf = make({ lockMs: 150, waitMs: 200 });
    const key = freshKey();
    expect((await sf.acquire(key)).role).toBe('leader');
    await sleep(700); // three waits
    expect(await redis.exists(`${key}:lock`)).toBe(1);
    expect((await sf.acquire(key)).role).toBe('follower');
  });

  it('followers in the leader\'s process wait on it without reading Redis', async () => {
    const sf = make({ pollMs: 30, waitMs: 5_000 });
    const key = freshKey();
    const lead = await sf.acquire(key);
    if (lead.role !== 'leader') throw new Error('expected a leader');
    const f = await sf.acquire(key);
    if (f.role !== 'follower') throw new Error('expected a follower');
    let reads = 0;
    const waiting = f.wait(async () => {
      reads++;
      return { status: 'unavailable' } as const; // a slow or failed GET must not end a local flight early
    });
    await sleep(400);
    expect(reads).toBe(0);
    await store.set(key, answer('local'));
    lead.finish('filled');
    expect(await waiting).toBeUndefined(); // its one look after the fill is the unavailable one
    expect(reads).toBe(1);
  });

  it('a remote poller\'s unavailable read ends only that remote flight, which is then gone', async () => {
    const a = make({ lockMs: 5_000, waitMs: 5_000, pollMs: 40 });
    const b = make({ lockMs: 5_000, waitMs: 5_000, pollMs: 40 });
    const key = freshKey();
    const lead = await a.acquire(key);
    if (lead.role !== 'leader') throw new Error('expected a leader');
    const local = await a.acquire(key);
    const remote = await b.acquire(key);
    if (local.role !== 'follower' || remote.role !== 'follower') throw new Error('expected followers');
    const localWait = local.wait(() => look(key));
    let reads = 0;
    const remoteResult = await remote.wait(async () => (reads++ === 0 ? { status: 'miss' } : { status: 'unavailable' }));
    expect(remoteResult).toBeUndefined(); // the early look missed, the first poll was unavailable
    await store.set(key, answer('for the local one'));
    lead.finish('filled');
    expect((await localWait)?.content).toBe('for the local one'); // the other process's failure did not reach it
    await a.idle();
    expect((await b.acquire(key)).role).toBe('leader'); // b's flight was removed when it settled
  });

  it('what the poller finds is handed to the waiter, not read again', async () => {
    const a = make({ lockMs: 5_000, waitMs: 5_000, pollMs: 40 });
    const b = make({ lockMs: 5_000, waitMs: 5_000, pollMs: 40 });
    const key = freshKey();
    expect((await a.acquire(key)).role).toBe('leader');
    const f = await b.acquire(key);
    if (f.role !== 'follower') throw new Error('expected a follower');
    const found = answer('found by the poller');
    let reads = 0;
    const got = await f.wait(async () => {
      reads++;
      if (reads === 1) return { status: 'miss' } as const; // before anything landed
      if (reads === 2) return { status: 'hit', entry: found } as const; // the poller's look
      return { status: 'miss' } as const; // any read after that would lose the entry
    });
    expect(got).toBe(found);
    expect(reads).toBe(2);
  });

  it('a lock that is someone else\'s by the time the old leader finishes is not deleted or renewed by it', async () => {
    const a = make({ lockMs: 150 });
    const key = freshKey();
    const old = await a.acquire(key);
    if (old.role !== 'leader') throw new Error('expected a leader');
    await redis.set(`${key}:lock`, 'someone-else', 'PX', 5_000); // the lock was lost and taken
    await sleep(120); // several renewal ticks
    expect(await redis.pttl(`${key}:lock`)).toBeGreaterThan(4_000); // not shortened by a renewal
    old.finish('failed');
    await a.idle();
    expect(await redis.get(`${key}:lock`)).toBe('someone-else');
  });

  it('the leader renews its lock while its call is in flight, and releases it when done', async () => {
    const sf = make({ lockMs: 300, waitMs: 5_000 });
    const key = freshKey();
    const lead = await sf.acquire(key);
    if (lead.role !== 'leader') throw new Error('expected a leader');
    await sleep(1_000); // more than three lock lifetimes
    expect(await redis.exists(`${key}:lock`)).toBe(1);
    expect(await redis.pttl(`${key}:lock`)).toBeGreaterThan(0);
    lead.finish('failed');
    await sf.idle();
    expect(await redis.exists(`${key}:lock`)).toBe(0);
  });

  it('a call far longer than the lock still makes one upstream call for 50 identical requests across two processes', async () => {
    const a = make({ lockMs: 400, waitMs: 20_000, pollMs: 100 });
    const b = make({ lockMs: 400, waitMs: 20_000, pollMs: 100 });
    const key = freshKey();
    let upstreamCalls = 0;
    const upstream = async () => {
      upstreamCalls++;
      await sleep(2_000); // five lock lifetimes
      return 'slow answer';
    };
    const leader = request(a, key, upstream);
    await sleep(50);
    const rest = Array.from({ length: 49 }, (_, i) => request(i % 2 ? a : b, key, upstream));
    const results = await Promise.all([leader, ...rest]);
    expect(upstreamCalls).toBe(1);
    expect(results).toHaveLength(50);
    expect(results.every((r) => r === 'slow answer')).toBe(true);
  }, 15_000);

  it('a leader that stops renewing (killed) frees its followers within the lock lifetime', async () => {
    const dying = make({ lockMs: 600, waitMs: 20_000, pollMs: 100 });
    const b = make({ lockMs: 600, waitMs: 20_000, pollMs: 100 });
    const key = freshKey();
    expect((await dying.acquire(key)).role).toBe('leader');
    const started = performance.now();
    const followers = await Promise.all(
      Array.from({ length: 5 }, async () => {
        const f = await b.acquire(key);
        if (f.role !== 'follower') throw new Error('expected a follower');
        return f;
      }),
    );
    const waiting = Promise.all(followers.map((f) => f.wait(() => look(key))));
    await dying.close(); // the process is gone: nothing renews, nothing releases
    expect(await waiting).toEqual(Array(5).fill(undefined));
    const waited = performance.now() - started;
    expect(waited).toBeGreaterThan(200); // not before the lock had lapsed
    expect(waited).toBeLessThan(600 + 100 + 500); // lock lifetime + one look + latency
  });

  it('Redis freezing mid-stampede sends the other process\'s followers upstream within a timeout and a look, and the leader\'s own process waits on the leader', async () => {
    const proxy = await freezable();
    try {
      const timeoutMs = 100;
      const pollMs = 100;
      const ra = await proxy.client();
      const rb = await proxy.client();
      const a = make({ redis: ra, lockMs: 5_000, waitMs: 60_000, pollMs, timeoutMs });
      const b = make({ redis: rb, lockMs: 5_000, waitMs: 60_000, pollMs, timeoutMs });
      const storeA = createCacheStore({ redis: ra, ttlS: 60, maxEntryBytes: 10_000, timeoutMs });
      const storeB = createCacheStore({ redis: rb, ttlS: 60, maxEntryBytes: 10_000, timeoutMs });
      const key = freshKey();
      const lead = await a.acquire(key);
      expect(lead.role).toBe('leader');
      const waits: Promise<number>[] = [];
      const local: Promise<number>[] = [];
      let frozenAt = 0;
      const join = async (sf: SingleFlight, from: typeof storeA) => {
        const f = await sf.acquire(key);
        if (f.role !== 'follower') throw new Error(`expected a follower, got ${f.role}`);
        const entry = await f.wait(() => look(key, from));
        expect(entry).toBeUndefined();
        return performance.now() - frozenAt;
      };
      for (let i = 0; i < 20; i++) (i % 2 ? local : waits).push(join(i % 2 ? a : b, i % 2 ? storeA : storeB));
      await sleep(300); // everyone is waiting on a healthy Redis, the leader's call still in flight
      proxy.freeze();
      frozenAt = performance.now();
      const took = await Promise.all(waits);
      expect(took).toHaveLength(10);
      // A command times out after timeoutMs, and the look that finds out comes at most pollMs after the freeze.
      expect(Math.max(...took)).toBeLessThan(timeoutMs + pollMs + 400);
      // The leader's own process does not look at Redis: its followers go when the leader reports.
      let released = false;
      void Promise.all(local).then(() => (released = true));
      await sleep(300);
      expect(released).toBe(false);
      if (lead.role === 'leader') lead.finish('failed');
      expect(await Promise.all(local)).toHaveLength(10);
    } finally {
      await proxy.close();
    }
  }, 15_000);

  it('a lock whose SET reply timed out is taken back, and the request goes upstream alone', async () => {
    // The command reaches Redis and takes effect; the reply is what arrives too late.
    const slowReply = new Proxy(redis, {
      get(target, prop) {
        if (prop === 'set') {
          return async (...args: Parameters<Redis['set']>) => {
            const reply = await (target.set as (...a: unknown[]) => Promise<unknown>)(...args);
            await sleep(400);
            return reply;
          };
        }
        const v = Reflect.get(target, prop, target);
        return typeof v === 'function' ? v.bind(target) : v;
      },
    });
    const sf = make({ redis: slowReply, timeoutMs: 100 });
    const key = freshKey();
    expect((await sf.acquire(key)).role).toBe('solo');
    await sf.idle();
    expect(await redis.exists(`${key}:lock`)).toBe(0); // not left behind for the whole lock lifetime
    await sleep(500); // the late reply has come in
    expect(await redis.exists(`${key}:lock`)).toBe(0);
  });

  it('a subscriber that never became ready is tried again by a later call', async () => {
    let calls = 0;
    const flaky = new Proxy(redis, {
      get(target, prop) {
        if (prop === 'duplicate') {
          return (...args: unknown[]) => {
            if (calls++ === 0) {
              const dead = new Redis('redis://127.0.0.1:1', { enableOfflineQueue: false, retryStrategy: () => null });
              dead.on('error', () => {});
              return dead;
            }
            return (target.duplicate as (...a: unknown[]) => Redis)(...args);
          };
        }
        const v = Reflect.get(target, prop, target);
        return typeof v === 'function' ? v.bind(target) : v;
      },
    });
    const leaderSide = make();
    // pollMs is far longer than the test: only the leader's notification can wake the second follower early.
    const follower = make({ redis: flaky, pollMs: 30_000, waitMs: 30_000 });
    const k1 = freshKey();
    expect((await leaderSide.acquire(k1)).role).toBe('leader');
    const first = await follower.acquire(k1);
    if (first.role !== 'follower') throw new Error('expected a follower');
    expect(await first.wait(() => look(k1))).toBeUndefined(); // no subscriber: straight upstream

    const k2 = freshKey();
    const lead2 = await leaderSide.acquire(k2);
    if (lead2.role !== 'leader') throw new Error('expected a leader');
    const second = await follower.acquire(k2);
    if (second.role !== 'follower') throw new Error('expected a follower');
    const waiting = second.wait(() => look(k2));
    await sleep(100);
    const started = performance.now();
    await store.set(k2, answer('woken'));
    lead2.finish('filled');
    expect((await waiting)?.content).toBe('woken');
    expect(performance.now() - started).toBeLessThan(1_000);
  });

  it('a subscriber that ended later is replaced by the next call', async () => {
    const made: Redis[] = [];
    const spying = new Proxy(redis, {
      get(target, prop) {
        if (prop === 'duplicate') {
          return (...args: unknown[]) => {
            const d = (target.duplicate as (...a: unknown[]) => Redis)(...args);
            made.push(d);
            return d;
          };
        }
        const v = Reflect.get(target, prop, target);
        return typeof v === 'function' ? v.bind(target) : v;
      },
    });
    const leaderSide = make();
    const follower = make({ redis: spying, pollMs: 30_000, waitMs: 30_000 });
    const k1 = freshKey();
    expect((await leaderSide.acquire(k1)).role).toBe('leader');
    const first = await follower.acquire(k1);
    if (first.role !== 'follower') throw new Error('expected a follower');
    void first.wait(() => look(k1)); // makes the subscriber
    await sleep(100);
    expect(made).toHaveLength(1);
    made[0]!.disconnect(); // the subscriber's connection ends after it was ready

    const k2 = freshKey();
    const lead2 = await leaderSide.acquire(k2);
    if (lead2.role !== 'leader') throw new Error('expected a leader');
    const second = await follower.acquire(k2);
    if (second.role !== 'follower') throw new Error('expected a follower');
    const waiting = second.wait(() => look(k2));
    await sleep(100);
    expect(made).toHaveLength(2);
    const started = performance.now();
    await store.set(k2, answer('woken again'));
    lead2.finish('filled');
    expect((await waiting)?.content).toBe('woken again');
    expect(performance.now() - started).toBeLessThan(1_000);
  });

  it('redis down means no leader: the request goes upstream alone', async () => {
    const dead = new Redis('redis://127.0.0.1:1', { enableOfflineQueue: false, lazyConnect: true, retryStrategy: () => null });
    dead.on('error', () => {});
    const sf = createSingleFlight({ redis: dead, lockMs: 5_000, waitMs: 2_000, pollMs: 100, timeoutMs: 50 });
    expect((await sf.acquire(freshKey())).role).toBe('solo');
    await sf.close();
    dead.disconnect();
  });
});
