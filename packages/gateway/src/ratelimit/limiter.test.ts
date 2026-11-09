import { randomBytes } from 'node:crypto';
import http, { type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Redis } from 'ioredis';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../app.ts';
import { createDb, type Db } from '../db/client.ts';
import { createRedis } from '../redis.ts';
import { cleanup, seedKey, testConfig } from '../test-env.ts';
import { createLimiter, type Limiter } from './limiter.ts';

// Everything here uses the run's own Redis prefix, so parallel files and other worktrees never share a key.
const base = testConfig();
const prefix = base.redisKeyPrefix;
let redis: Redis;
const extra: Redis[] = [];

// Pinned clock: a bucket refills only when a test moves time, so counts are exact on any machine.
const T0 = 1_700_000_000_000;
let now = T0;
const clock = () => now;

const newLimiter = (opts: { pinned?: boolean; log?: object; client?: Redis; timeoutMs?: number } = {}): Limiter =>
  createLimiter({
    redis: opts.client ?? redis,
    keyPrefix: prefix,
    timeoutMs: opts.timeoutMs ?? 30_000,
    ...(opts.pinned === false ? {} : { clock }),
    ...(opts.log ? { log: opts.log as { warn(): void; info(): void } } : {}),
  });
const id = () => `k-${randomBytes(6).toString('hex')}`;
const field = async (keyId: string, bucket: 'req' | 'tok') =>
  Number(await redis.hget(`${prefix}rl:{${keyId}}:${bucket}`, 'tokens'));

beforeAll(() => {
  redis = new Redis(base.redisUrl!);
});
afterEach(() => {
  now = T0;
  vi.restoreAllMocks();
});
afterAll(async () => {
  await cleanup(createDbForCleanup().db, redis, [], prefix);
  redis.disconnect();
  for (const r of extra) r.disconnect();
});
// cleanup() wants a Db handle only to delete tenants; none are created here.
const createDbForCleanup = () => ({ db: null as unknown as Db['db'] });

describe('limiter against real Redis', { timeout: 60_000 }, () => {
  it('1000 concurrent takes at 100 rpm admit exactly 100', async () => {
    const limiter = newLimiter();
    const keyId = id();
    const results = await Promise.all(Array.from({ length: 1000 }, () => limiter.take(keyId, 100, 10_000_000, 1)));
    const count = (s: string) => results.filter((r) => r.status === s).length;
    expect(count('skipped')).toBe(0);
    expect(count('allowed')).toBe(100);
    expect(count('denied')).toBe(900);
    expect(await field(keyId, 'req')).toBe(0);
  });

  it('bucket refills at limit/60 per second', async () => {
    const limiter = newLimiter();
    const keyId = id();
    for (let i = 0; i < 60; i++) expect((await limiter.take(keyId, 60, 1_000_000, 1)).status).toBe('allowed');
    expect((await limiter.take(keyId, 60, 1_000_000, 1)).status).toBe('denied');
    now += 1100; // 1.1 s at 1 token per second
    expect((await limiter.take(keyId, 60, 1_000_000, 1)).status).toBe('allowed');
    expect((await limiter.take(keyId, 60, 1_000_000, 1)).status).toBe('denied');
    now += 60_000 * 5; // a long idle never banks more than one minute
    const results = await Promise.all(Array.from({ length: 100 }, () => limiter.take(keyId, 60, 1_000_000, 1)));
    expect(results.filter((r) => r.status === 'allowed')).toHaveLength(60);
  });

  it('refills against Redis time, not the caller clock', async () => {
    const limiter = newLimiter({ pinned: false });
    const keyId = id();
    vi.spyOn(Date, 'now').mockReturnValue(0); // a gateway whose clock is wildly off
    for (let i = 0; i < 60; i++) await limiter.take(keyId, 60, 1_000_000, 1);
    expect((await limiter.take(keyId, 60, 1_000_000, 1)).status).toBe('denied');
    await new Promise((r) => setTimeout(r, 1200));
    // At least one token came back after 1.2 real seconds (a loaded machine may have waited longer).
    expect((await limiter.take(keyId, 60, 1_000_000, 1)).status).toBe('allowed');
    const [redisSec] = await redis.time();
    const stored = Number(await redis.hget(`${prefix}rl:{${keyId}}:req`, 'ts'));
    expect(Math.abs(stored - Number(redisSec) * 1000)).toBeLessThan(30_000);
  });

  it('denied by the token bucket consumes no request token, and vice versa', async () => {
    const limiter = newLimiter();
    const a = id();
    expect((await limiter.take(a, 10, 100, 100)).status).toBe('allowed'); // tokens now 0, requests 9
    const byTokens = await limiter.take(a, 10, 100, 50);
    expect(byTokens).toMatchObject({ status: 'denied', limited: 'tokens' });
    expect(await field(a, 'req')).toBe(9);
    expect(await field(a, 'tok')).toBe(0);

    const b = id();
    expect((await limiter.take(b, 1, 1000, 500)).status).toBe('allowed'); // requests now 0, tokens 500
    const byRequests = await limiter.take(b, 1, 1000, 1);
    expect(byRequests).toMatchObject({ status: 'denied', limited: 'requests' });
    expect(await field(b, 'req')).toBe(0);
    expect(await field(b, 'tok')).toBe(500);
  });

  it('refund after a smaller actual usage restores tokens, capped at capacity', async () => {
    const limiter = newLimiter();
    const keyId = id();
    await limiter.take(keyId, 100, 1000, 800);
    expect(await field(keyId, 'tok')).toBe(200);
    await limiter.adjust(keyId, 1000, 800 - 300); // estimate 800, actual 300
    expect(await field(keyId, 'tok')).toBe(700);
    await limiter.adjust(keyId, 1000, 5000); // more refund than the bucket can hold
    // A full bucket expires at once, so prove the cap by spending it: exactly 1000 was there, not 6000.
    expect((await limiter.take(keyId, 100, 1000, 1000)).status).toBe('allowed');
    expect(await field(keyId, 'tok')).toBe(0);
  });

  it('debit after a larger actual usage drives the bucket negative and delays later requests', async () => {
    const limiter = newLimiter();
    const keyId = id();
    await limiter.take(keyId, 100, 1000, 100);
    await limiter.adjust(keyId, 1000, 100 - 1600); // estimate 100, actual 1600
    expect(await field(keyId, 'tok')).toBe(-600);
    const denied = await limiter.take(keyId, 100, 1000, 10);
    expect(denied).toMatchObject({ status: 'denied', limited: 'tokens' });
    // 610 tokens short at 1000 per minute = 36.6 s.
    expect(denied.status === 'denied' && denied.retryAfterMs).toBe(36_600);
    now += 36_600;
    expect((await limiter.take(keyId, 100, 1000, 10)).status).toBe('allowed');
  });

  it('retry-after equals the time until the short bucket can serve the request', async () => {
    const limiter = newLimiter();
    const byRequests = id();
    for (let i = 0; i < 60; i++) await limiter.take(byRequests, 60, 1_000_000, 1);
    const r = await limiter.take(byRequests, 60, 1_000_000, 1);
    expect(r.status === 'denied' && r.retryAfterMs).toBe(1000); // one token at 1 per second

    const byTokens = id();
    await limiter.take(byTokens, 100, 6000, 6000); // tokens 0, refill 100 per second
    const t = await limiter.take(byTokens, 100, 6000, 250);
    expect(t.status === 'denied' && t.retryAfterMs).toBe(2500);
    expect(t.status === 'denied' && t.limited).toBe('tokens');

    // Both short: the longer wait is reported, and waiting exactly that long admits the request.
    const both = id();
    await limiter.take(both, 1, 6000, 6000);
    const w = await limiter.take(both, 1, 6000, 250); // requests need 60 s, tokens 2.5 s
    expect(w).toMatchObject({ status: 'denied', limited: 'requests', retryAfterMs: 60_000 });
    now += 60_000;
    expect((await limiter.take(both, 1, 6000, 250)).status).toBe('allowed');
  });

  it('reports remaining and reset for both buckets', async () => {
    const limiter = newLimiter();
    const keyId = id();
    const r = await limiter.take(keyId, 60, 1000, 400);
    expect(r).toMatchObject({
      status: 'allowed',
      buckets: {
        requests: { limit: 60, remaining: 59, resetMs: 1000 },
        tokens: { limit: 1000, remaining: 600, resetMs: 24_000 },
      },
    });
  });

  it('idle bucket keys expire', async () => {
    const limiter = newLimiter({ pinned: false });
    const keyId = id();
    await limiter.take(keyId, 120, 120, 1); // one token short of full: back to full in 500 ms
    for (const bucket of ['req', 'tok']) {
      const ttl = await redis.pttl(`${prefix}rl:{${keyId}}:${bucket}`);
      expect(ttl).not.toBe(-1); // a TTL was set
      expect(ttl).toBeLessThanOrEqual(500);
    }
    await vi.waitFor(async () => expect(await redis.exists(`${prefix}rl:{${keyId}}:req`, `${prefix}rl:{${keyId}}:tok`)).toBe(0), {
      timeout: 5000,
    });
  });
});

describe('fail open', { timeout: 30_000 }, () => {
  it('Redis down fails open and logs once per outage', async () => {
    const warns: object[] = [];
    const infos: object[] = [];
    const limiter = newLimiter({ log: { warn: (o: object) => warns.push(o), info: (o: object) => infos.push(o) } });
    const real = (redis as unknown as { rlTake: unknown }).rlTake;
    const broken = async () => {
      throw Object.assign(new Error('ECONNREFUSED secret-host'), { code: 'ECONNREFUSED' });
    };
    (redis as unknown as { rlTake: unknown }).rlTake = broken;
    try {
      const results = await Promise.all(Array.from({ length: 5 }, () => limiter.take(id(), 1, 1, 1)));
      expect(results.map((r) => r.status)).toEqual(Array(5).fill('skipped'));
      expect(warns).toHaveLength(1);
      expect(JSON.stringify(warns)).not.toContain('secret-host'); // class and code only, never the message
      expect(warns[0]).toMatchObject({ errClass: 'Error', code: 'ECONNREFUSED' });

      (redis as unknown as { rlTake: unknown }).rlTake = real; // Redis is back
      expect((await limiter.take(id(), 1, 1, 1)).status).toBe('allowed');
      expect(infos).toHaveLength(1);

      (redis as unknown as { rlTake: unknown }).rlTake = broken; // a second outage warns again
      await limiter.take(id(), 1, 1, 1);
      await limiter.take(id(), 1, 1, 1);
      expect(warns).toHaveLength(2);
    } finally {
      (redis as unknown as { rlTake: unknown }).rlTake = real;
    }
  });

  it('a reply slower than the timeout is an outage for that request', async () => {
    const warns: object[] = [];
    const limiter = newLimiter({ timeoutMs: 20, log: { warn: (o: object) => warns.push(o), info: () => {} } });
    const real = (redis as unknown as { rlTake: unknown }).rlTake;
    (redis as unknown as { rlTake: unknown }).rlTake = () => new Promise(() => {});
    try {
      expect((await limiter.take(id(), 1, 1, 1)).status).toBe('skipped');
      expect(warns[0]).toMatchObject({ errClass: 'RedisTimeout' });
    } finally {
      (redis as unknown as { rlTake: unknown }).rlTake = real;
    }
  });

  it('a take that times out but still runs in Redis is handed back, in both buckets', async () => {
    const limiter = newLimiter({ timeoutMs: 20 });
    const keyId = id();
    const real = (redis as unknown as { rlTake: (...a: unknown[]) => Promise<unknown> }).rlTake.bind(redis);
    let ran: Promise<unknown> = Promise.resolve();
    // Redis answers after 150 ms: the caller has long since given up, and the script then charges.
    (redis as unknown as { rlTake: unknown }).rlTake = (...a: unknown[]) => {
      ran = new Promise((r) => setTimeout(r, 150)).then(() => real(...a));
      return ran;
    };
    try {
      expect((await limiter.take(keyId, 10, 1000, 1000)).status).toBe('skipped');
    } finally {
      (redis as unknown as { rlTake: unknown }).rlTake = real;
    }
    await ran; // the script has now run and charged: the request bucket holds 9, the token bucket 0
    // Both buckets are whole again once the late charge is handed back, and a full bucket expires. The
    // keys cannot expire any other way inside this wait (the request bucket's expiry is 6 s away).
    await vi.waitFor(
      async () => expect(await redis.exists(`${prefix}rl:{${keyId}}:req`, `${prefix}rl:{${keyId}}:tok`)).toBe(0),
      { timeout: 5000 },
    );
    // All ten requests and all 1000 tokens are available again, and not an eleventh.
    const fast = newLimiter();
    const results = [];
    for (let i = 0; i < 10; i++) results.push((await fast.take(keyId, 10, 1000, 100)).status);
    expect(results).toEqual(Array(10).fill('allowed'));
    expect((await fast.take(keyId, 10, 1000, 100)).status).toBe('denied');
  });

  it('an unreachable Redis serves the request and a client still connecting is not logged as down', async () => {
    const warns: object[] = [];
    const dead = createRedis('redis://127.0.0.1:1', { startupGraceMs: 0 });
    extra.push(dead);
    const limiter = newLimiter({ client: dead, timeoutMs: 1000, log: { warn: (o: object) => warns.push(o), info: () => {} } });
    expect((await limiter.take(id(), 1, 1, 1)).status).toBe('skipped');
    expect((await limiter.take(id(), 1, 1, 1)).status).toBe('skipped');
    expect(warns).toHaveLength(1);

    const starting = createRedis('redis://127.0.0.1:1', { startupGraceMs: 60_000 });
    extra.push(starting);
    const quiet: object[] = [];
    const l2 = newLimiter({ client: starting, log: { warn: (o: object) => quiet.push(o), info: () => {} } });
    expect((await l2.take(id(), 1, 1, 1)).status).toBe('skipped');
    expect(quiet).toHaveLength(0);
  });
});

describe('across gateway instances', { timeout: 120_000 }, () => {
  it('1000 concurrent requests across 3 in-process gateway apps sharing Redis admit exactly 100', async () => {
    let upstreamHits = 0;
    const mock: Server = http.createServer((req, res) => {
      req.resume();
      req.on('end', () => {
        upstreamHits++;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ id: 'x', choices: [], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
      });
    });
    await new Promise<void>((resolve) => mock.listen(0, '127.0.0.1', resolve));
    const mockUrl = `http://127.0.0.1:${(mock.address() as AddressInfo).port}`;
    const handle = createDb({ databaseUrl: base.databaseUrl, poolSize: 2 });
    const cleanupRedis = new Redis(base.redisUrl!);
    const seeded = await seedKey(handle.db, base, { rpm: 100, tpm: 10_000_000 });
    const apps: FastifyInstance[] = [];
    try {
      for (let i = 0; i < 3; i++) {
        // Same pepper, prefix and database: three instances of one gateway. Redis calls get a generous
        // timeout so a loaded machine cannot turn a slow reply into a fail-open admit.
        const app = buildApp(
          testConfig({
            API_KEY_PEPPER: base.apiKeyPepper,
            REDIS_KEY_PREFIX: prefix,
            OPENAI_BASE_URL: mockUrl,
            RATE_LIMIT_REDIS_TIMEOUT_MS: '30000',
          }),
          { rateLimitClock: clock },
        );
        await app.ready();
        apps.push(app);
      }
      // Warm each instance's key cache without touching the limited route.
      for (const app of apps) {
        const warm = await app.inject({ method: 'GET', url: '/__warm', headers: { authorization: `Bearer ${seeded.key}` } });
        expect(warm.statusCode).toBe(404);
      }
      const body = JSON.stringify({ model: 'm', messages: [{ role: 'user', content: 'hi' }] });
      const responses = await Promise.all(
        Array.from({ length: 1000 }, (_, i) =>
          apps[i % 3]!.inject({
            method: 'POST',
            url: '/v1/chat/completions',
            headers: { 'content-type': 'application/json', authorization: `Bearer ${seeded.key}` },
            payload: body,
          }),
        ),
      );
      const ok = responses.filter((r) => r.statusCode === 200);
      const limited = responses.filter((r) => r.statusCode === 429);
      expect(ok).toHaveLength(100);
      expect(limited).toHaveLength(900);
      expect(limited.every((r) => Number(r.headers['retry-after']) >= 1)).toBe(true);
      expect(upstreamHits).toBe(100); // a rejected request never reaches the provider
    } finally {
      await Promise.all(apps.map((a) => a.close()));
      mock.closeAllConnections();
      await new Promise((resolve) => mock.close(resolve));
      await cleanup(handle.db, cleanupRedis, [seeded.tenantId], prefix);
      cleanupRedis.disconnect();
      await handle.close();
    }
  });
});
