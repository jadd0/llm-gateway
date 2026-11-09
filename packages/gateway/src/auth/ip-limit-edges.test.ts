import type { AddressInfo } from 'node:net';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import type { Redis } from 'ioredis';
import { Redis as RedisClient } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../app.ts';
import { createDb, type Db } from '../db/client.ts';
import { cleanup, seedKey, testConfig } from '../test-env.ts';
import { generateKey } from './keys.ts';
import { createIpLimiter, type IpLimiter } from './ip-limit.ts';
import { auth } from './plugin.ts';
import type { KeyStore } from './key-store.ts';

describe('ip limiter: a take that times out', () => {
  it('hands back a token the late script reply took, and not one it did not', async () => {
    for (const lateTaken of [1, 0]) {
      const adjusts: unknown[][] = [];
      const fake = {
        defineCommand() {},
        ipTake: () => new Promise((resolve) => setTimeout(() => resolve([lateTaken, 0]), 80)),
        ipAdjust: (...args: unknown[]) => {
          adjusts.push(args);
          return Promise.resolve(1);
        },
      };
      const limiter = createIpLimiter({ redis: fake as unknown as Redis, keyPrefix: 'p:', limitPerMin: 5, timeoutMs: 10 });
      const g = await limiter.take('203.0.113.9', 1000);
      expect(g.refused).toBe(false); // fail open
      await new Promise((r) => setTimeout(r, 200));
      expect(adjusts.length).toBe(lateTaken);
    }
  });
});

describe('auth plugin without a request address', () => {
  it('does not charge any bucket and does not refuse', async () => {
    const taken: string[] = [];
    const limiter: IpLimiter = {
      async take(ip) {
        taken.push(ip);
        return { refused: true, retryAfterMs: 1000 };
      },
    };
    const lookups: Array<string | undefined> = [];
    const store = {
      async lookup(_h: string, ip?: string) {
        lookups.push(ip);
        return null;
      },
    } as unknown as KeyStore;
    const app = Fastify();
    app.addHook('onRequest', async (request) => {
      Object.defineProperty(request, 'ip', { value: undefined });
    });
    app.register(auth, { keyStore: store, pepper: 'x', ipLimiter: limiter });
    app.get('/x', async () => 'ok');
    const noKey = await app.inject({ method: 'GET', url: '/x' });
    const badKey = await app.inject({ method: 'GET', url: '/x', headers: { authorization: `Bearer ${generateKey()}` } });
    expect([noKey.statusCode, badKey.statusCode]).toEqual([401, 401]);
    expect(taken).toEqual([]);
    expect(lookups).toEqual([undefined]);
    await app.close();
  });
});

describe('AUTH_CACHE=none with the address guard on', () => {
  let handle: Db;
  let redis: Redis;
  let app: FastifyInstance;
  const tenantIds: string[] = [];
  const config = testConfig({ AUTH_CACHE: 'none', AUTH_FAIL_LIMIT_PER_MIN: '30' });

  beforeAll(async () => {
    handle = createDb({ databaseUrl: config.databaseUrl, poolSize: 4 });
    redis = new RedisClient(config.redisUrl!);
    app = buildApp(config, { rateLimitClock: () => 1_700_000_000_000 });
    app.register(async (a) => {
      a.get('/__whoami', async (request) => request.tenant);
    });
    await app.listen({ port: 0, host: '127.0.0.1' });
  });
  afterAll(async () => {
    await app.close();
    await cleanup(handle.db, redis, tenantIds, config.redisKeyPrefix);
    redis.disconnect();
    await handle.close();
  });

  it('40 concurrent valid requests from one address all succeed; unknown keys still run out', async () => {
    const url = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}/__whoami`;
    const seeded = await seedKey(handle.db, config);
    tenantIds.push(seeded.tenantId);
    // Redis commands fail until the app's client has connected; wait until a failed key is counted.
    const get = (key: string) => fetch(url, { headers: { authorization: `Bearer ${key}` } });
    for (let i = 0; i < 100 && (await redis.keys(`${config.redisKeyPrefix}ipfail:*`)).length === 0; i++) {
      await get(generateKey());
      await new Promise((r) => setTimeout(r, 50));
    }
    const statuses = (await Promise.all(Array.from({ length: 40 }, () => get(seeded.key)))).map((r) => r.status);
    expect(statuses).toEqual(Array<number>(40).fill(200));
    const bad = [];
    for (let i = 0; i < 40; i++) bad.push((await get(generateKey())).status);
    expect(bad).toContain(429);
  }, 60_000);
});
