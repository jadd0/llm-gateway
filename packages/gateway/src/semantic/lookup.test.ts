import { randomBytes } from 'node:crypto';
import { Redis } from 'ioredis';
import { like } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';
import { createCacheStore } from '../cache/store.ts';
import type { CachedCompletion } from '../cache/replay.ts';
import { createDb } from '../db/client.ts';
import { semanticCache } from '../db/schema.ts';
import { testConfig } from '../test-env.ts';
import type { SemanticSplit } from './context.ts';
import { createSemanticLookup } from './lookup.ts';
import { createSemanticStore, type SemanticStore } from './store.ts';
import { angle, atSimilarity, stubEmbedder } from './test-support.ts';

const config = testConfig();
const handle = createDb({ databaseUrl: config.databaseUrl, poolSize: 4 });
const redis = new Redis(config.redisUrl!);
const run = randomBytes(4).toString('hex');
const prefix = `${config.redisKeyPrefix}lookup-${run}:`;
const scope = `${run}-s`;
const CTX = 'c'.repeat(64);
const NOW = new Date('2030-01-01T00:00:00Z').getTime();
const answer: CachedCompletion = { content: 'Paris', finishReason: 'stop', usage: null, model: 'mock-1' };
const split = (text: string): SemanticSplit => ({ text, contextHash: CTX });

afterAll(async () => {
  await handle.db.delete(semanticCache).where(like(semanticCache.scope, `${run}%`));
  const keys = await redis.keys(`${prefix}*`);
  if (keys.length) await redis.del(...keys);
  redis.disconnect();
  await handle.close();
});

const world = (table: Record<string, number[]>, over: { threshold?: number; crossModel?: boolean; store?: SemanticStore; maxChars?: number; pgTimeoutMs?: number } = {}) => {
  const stub = stubEmbedder(table);
  const store = over.store ?? createSemanticStore(handle.db);
  const cache = createCacheStore({ redis, ttlS: 3600, maxEntryBytes: 10_000, timeoutMs: 500 });
  const lookup = createSemanticLookup({
    embedder: stub.embedder,
    store,
    cache,
    threshold: over.threshold ?? 0.95,
    crossModel: over.crossModel ?? true,
    maxChars: over.maxChars ?? 2000,
    pgTimeoutMs: over.pgTimeoutMs ?? 1000,
    clock: () => NOW,
  });
  return { stub, store, cache, lookup };
};
const stored = async (w: ReturnType<typeof world>, key: string, vector: number[], over: { embedder?: string; withAnswer?: boolean } = {}) => {
  if (over.withAnswer !== false) await w.cache.set(`${prefix}${key}`, answer);
  await w.store.upsert({ scope, contextHash: CTX, exactKey: `${prefix}${key}`, embedding: vector, embedder: over.embedder ?? 'voyage-4-lite', expiresAt: new Date(NOW + 3600_000) });
};

describe('semantic lookup', () => {
  it('above threshold serves; below misses', async () => {
    const w = world({ q: angle(0) }, { threshold: 0.95 });
    await stored(w, 'p', atSimilarity(0.96));
    const hit = await w.lookup.find(scope, split('q'));
    expect(hit).toMatchObject({ status: 'hit', entry: { entry: answer } });
    expect(hit.status === 'hit' && hit.entry.similarity).toBeCloseTo(0.96, 6);

    // The same stored row is not served when the threshold is above its similarity, and is when it is below it
    // (pgvector keeps single-precision floats, so the margins are well above their rounding).
    const strict = world({ q: angle(0) }, { threshold: 0.97 });
    expect(await strict.lookup.find(scope, split('q'))).toEqual({ status: 'miss' });
    const justAbove = world({ q: angle(0) }, { threshold: 0.96 + 1e-4 });
    expect(await justAbove.lookup.find(scope, split('q'))).toEqual({ status: 'miss' });
    const justBelow = world({ q: angle(0) }, { threshold: 0.96 - 1e-4 });
    expect((await justBelow.lookup.find(scope, split('q'))).status).toBe('hit');
  });

  it('row whose Redis entry is gone is deleted and misses', async () => {
    const w = world({ q: angle(0) });
    const dangling = `${run}-gone`;
    await w.store.upsert({ scope: dangling, contextHash: CTX, exactKey: `${prefix}missing`, embedding: atSimilarity(0.99), embedder: 'voyage-4-lite', expiresAt: new Date(NOW + 3600_000) });
    const before = await w.store.nearest({ scope: dangling, contextHash: CTX, embedding: angle(0), now: new Date(NOW) });
    expect(before?.exactKey).toBe(`${prefix}missing`);
    expect(await w.lookup.find(dangling, split('q'))).toEqual({ status: 'miss' });
    expect(await w.store.nearest({ scope: dangling, contextHash: CTX, embedding: angle(0), now: new Date(NOW) })).toBeUndefined();
  });

  it('a Redis that cannot answer is unavailable and the row stays', async () => {
    const w = world({ q: angle(0) });
    const scoped = `${run}-down`;
    await w.store.upsert({ scope: scoped, contextHash: CTX, exactKey: `${prefix}x`, embedding: atSimilarity(0.99), embedder: 'voyage-4-lite', expiresAt: new Date(NOW + 3600_000) });
    const down = { get: async () => ({ status: 'unavailable' as const }) };
    const lookup = createSemanticLookup({ embedder: w.stub.embedder, store: w.store, cache: down, threshold: 0.95, crossModel: true, maxChars: 100, pgTimeoutMs: 500, clock: () => NOW });
    expect(await lookup.find(scoped, split('q'))).toEqual({ status: 'unavailable' });
    expect((await w.store.nearest({ scope: scoped, contextHash: CTX, embedding: angle(0), now: new Date(NOW) }))?.exactKey).toBe(`${prefix}x`);
  });

  it('no embedding is no lookup, and a long prompt is not embedded at all', async () => {
    const w = world({}, { maxChars: 10 });
    await stored(w, 'p2', angle(0));
    expect(await w.lookup.find(scope, split('unknown'))).toEqual({ status: 'unavailable' });
    expect(w.stub.calls).toHaveLength(1);
    expect(await w.lookup.find(scope, split('x'.repeat(11)))).toEqual({ status: 'miss' });
    expect(w.stub.calls).toHaveLength(1);
  });

  it('a slow or failing Postgres is unavailable, never a throw', async () => {
    const real = createSemanticStore(handle.db);
    const slow: SemanticStore = { ...real, nearest: () => new Promise(() => {}) };
    const w = world({ q: angle(0) }, { store: slow, pgTimeoutMs: 40 });
    const t0 = performance.now();
    expect(await w.lookup.find(scope, split('q'))).toEqual({ status: 'unavailable' });
    expect(performance.now() - t0).toBeLessThan(400);
    const broken: SemanticStore = { ...real, nearest: async () => Promise.reject(Object.assign(new Error('secret prompt text'), { code: 'ECONNREFUSED' })) };
    expect(await world({ q: angle(0) }, { store: broken }).lookup.find(scope, split('q'))).toEqual({ status: 'unavailable' });
  });

  it('with cross-model off only the same model is compared; with it on either is', async () => {
    const scoped = `${run}-x`;
    const off = world({ q: angle(0) }, { crossModel: false });
    await off.cache.set(`${prefix}nano`, answer);
    await off.store.upsert({ scope: scoped, contextHash: CTX, exactKey: `${prefix}nano`, embedding: atSimilarity(0.99), embedder: 'voyage-4-nano', expiresAt: new Date(NOW + 3600_000) });
    // The stub embeds as voyage-4-lite.
    expect(await off.lookup.find(scoped, split('q'))).toEqual({ status: 'miss' });
    expect((await world({ q: angle(0) }, { crossModel: true }).lookup.find(scoped, split('q'))).status).toBe('hit');
  });
});
