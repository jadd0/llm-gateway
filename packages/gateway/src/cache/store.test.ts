import { randomBytes } from 'node:crypto';
import { Redis } from 'ioredis';
import { afterAll, describe, expect, it } from 'vitest';
import { createRedis } from '../redis.ts';
import { testConfig } from '../test-env.ts';
import type { CachedCompletion } from './replay.ts';
import { createCacheStore } from './store.ts';

const config = testConfig();
const prefix = `${config.redisKeyPrefix}store-${randomBytes(4).toString('hex')}:`;
const redis = new Redis(config.redisUrl!);
const entry: CachedCompletion = { content: 'hello', finishReason: 'stop', usage: { promptTokens: 1, completionTokens: 2, totalTokens: 3 }, model: 'mock-1' };

afterAll(async () => {
  const keys = await redis.keys(`${prefix}*`);
  if (keys.length) await redis.del(...keys);
  redis.disconnect();
});

describe('cache store', () => {
  const store = createCacheStore({ redis, ttlS: 60, maxEntryBytes: 300, timeoutMs: 500 });

  it('what is set is got back, with a TTL; an unknown key is a miss', async () => {
    expect(await store.get(`${prefix}a`)).toEqual({ status: 'miss' });
    expect(await store.set(`${prefix}a`, entry)).toBe('stored');
    expect(await store.get(`${prefix}a`)).toEqual({ status: 'hit', entry });
    const ttl = await redis.ttl(`${prefix}a`);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(60);
    await store.set(`${prefix}n`, { ...entry, usage: null });
    expect(await store.get(`${prefix}n`)).toEqual({ status: 'hit', entry: { ...entry, usage: null } });
  });

  it('entry over the size cap is not stored', async () => {
    expect(await store.set(`${prefix}big`, { ...entry, content: 'x'.repeat(400) })).toBe('too-large');
    expect(await redis.exists(`${prefix}big`)).toBe(0);
    // The cap counts bytes of the stored JSON, not characters.
    expect(await store.set(`${prefix}bytes`, { ...entry, content: 'é'.repeat(150) })).toBe('too-large');
    expect(await store.set(`${prefix}small`, { ...entry, content: 'x'.repeat(100) })).toBe('stored');
  });

  it('a value this store did not write is a miss', async () => {
    for (const bad of ['{not json', '{"content":1}', '{"content":"a","model":"m","finishReason":"content_filter","usage":null}', 'null']) {
      await redis.set(`${prefix}bad`, bad);
      expect(await store.get(`${prefix}bad`), bad).toEqual({ status: 'miss' });
    }
  });

  it('redis down is a miss, not an error', async () => {
    const dead = createRedis('redis://127.0.0.1:1', { startupGraceMs: 0 });
    const logged: object[] = [];
    const deadStore = createCacheStore({ redis: dead, ttlS: 60, maxEntryBytes: 300, timeoutMs: 50, log: { warn: (o) => logged.push(o), info: () => {} } });
    try {
      expect(await deadStore.get(`${prefix}a`)).toEqual({ status: 'unavailable' });
      expect(await deadStore.set(`${prefix}a`, entry)).toBe('unavailable');
      expect(await deadStore.get(`${prefix}a`)).toEqual({ status: 'unavailable' });
      expect(logged).toHaveLength(1); // one warning for the outage, no message text in it
      expect(Object.keys(logged[0]!).sort()).toEqual(['code', 'errClass', 'op']);
    } finally {
      dead.disconnect();
    }
  });

  it('a Redis slower than the timeout is unavailable and the request is not held up', async () => {
    const slow = new Redis(config.redisUrl!);
    await slow.ping();
    // A command that answers after 300 ms.
    const origGet = slow.get.bind(slow);
    (slow as unknown as { get: (k: string) => Promise<string | null> }).get = async (k: string) => {
      await new Promise((r) => setTimeout(r, 300));
      return origGet(k);
    };
    const slowStore = createCacheStore({ redis: slow, ttlS: 60, maxEntryBytes: 300, timeoutMs: 30 });
    const started = performance.now();
    expect(await slowStore.get(`${prefix}a`)).toEqual({ status: 'unavailable' });
    expect(performance.now() - started).toBeLessThan(200);
    slow.disconnect();
  });
});
