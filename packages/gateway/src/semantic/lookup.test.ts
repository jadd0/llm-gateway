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
import { guardSignature } from './guards.ts';
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
const ctx = (n: number) => String(n).padStart(64, '0');
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
    guard: { tokenSet: true, maxDiff: 2 },
    clock: () => NOW,
  });
  return { stub, store, cache, lookup };
};
const stored = async (w: ReturnType<typeof world>, key: string, vector: number[], over: { embedder?: string; withAnswer?: boolean; text?: string } = {}) => {
  if (over.withAnswer !== false) await w.cache.set(`${prefix}${key}`, answer);
  await w.store.upsert({ scope, contextHash: CTX, exactKey: `${prefix}${key}`, embedding: vector, embedder: over.embedder ?? 'voyage-4-lite', guardSig: guardSignature(over.text ?? 'q'), expiresAt: new Date(NOW + 3600_000) });
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
    await w.store.upsert({ scope: dangling, contextHash: CTX, exactKey: `${prefix}missing`, embedding: atSimilarity(0.99), embedder: 'voyage-4-lite', guardSig: guardSignature('q'), expiresAt: new Date(NOW + 3600_000) });
    const before = await w.store.nearest({ scope: dangling, contextHash: CTX, embedding: angle(0), now: new Date(NOW), timeoutMs: 5000 });
    expect(before?.exactKey).toBe(`${prefix}missing`);
    expect(await w.lookup.find(dangling, split('q'))).toEqual({ status: 'miss' });
    expect(await w.store.nearest({ scope: dangling, contextHash: CTX, embedding: angle(0), now: new Date(NOW), timeoutMs: 5000 })).toBeUndefined();
  });

  it('a Redis that cannot answer is unavailable and the row stays', async () => {
    const w = world({ q: angle(0) });
    const scoped = `${run}-down`;
    await w.store.upsert({ scope: scoped, contextHash: CTX, exactKey: `${prefix}x`, embedding: atSimilarity(0.99), embedder: 'voyage-4-lite', guardSig: guardSignature('q'), expiresAt: new Date(NOW + 3600_000) });
    const down = { get: async () => ({ status: 'unavailable' as const }) };
    const lookup = createSemanticLookup({ embedder: w.stub.embedder, store: w.store, cache: down, threshold: 0.95, guard: { tokenSet: true, maxDiff: 2 }, crossModel: true, maxChars: 100, pgTimeoutMs: 500, clock: () => NOW });
    expect(await lookup.find(scoped, split('q'))).toEqual({ status: 'unavailable' });
    expect((await w.store.nearest({ scope: scoped, contextHash: CTX, embedding: angle(0), now: new Date(NOW), timeoutMs: 5000 }))?.exactKey).toBe(`${prefix}x`);
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
    await off.store.upsert({ scope: scoped, contextHash: CTX, exactKey: `${prefix}nano`, embedding: atSimilarity(0.99), embedder: 'voyage-4-nano', guardSig: guardSignature('q'), expiresAt: new Date(NOW + 3600_000) });
    // The stub embeds as voyage-4-lite.
    expect(await off.lookup.find(scoped, split('q'))).toEqual({ status: 'miss' });
    expect((await world({ q: angle(0) }, { crossModel: true }).lookup.find(scoped, split('q'))).status).toBe('hit');
  });

  it('a close match that fails a guard is a miss that names the rule, and its answer is never read', async () => {
    // The verifier's case: two order numbers 0.982 apart in meaning space.
    const scoped = `${run}-guard`;
    const w = world({ 'refund order number 1235': angle(0) }, { threshold: 0.95 });
    await w.cache.set(`${prefix}order-1234`, answer);
    await w.store.upsert({ scope: scoped, contextHash: CTX, exactKey: `${prefix}order-1234`, embedding: atSimilarity(0.982), embedder: 'voyage-4-lite', guardSig: guardSignature('refund order number 1234'), expiresAt: new Date(NOW + 3600_000) });
    let reads = 0;
    const counting = { get: (k: string) => (reads++, w.cache.get(k)) };
    const lookup = createSemanticLookup({ embedder: w.stub.embedder, store: w.store, cache: counting, threshold: 0.95, guard: { tokenSet: true, maxDiff: 2 }, crossModel: true, maxChars: 100, pgTimeoutMs: 500, clock: () => NOW });
    expect(await lookup.find(scoped, split('refund order number 1235'))).toEqual({ status: 'miss', guard: 'numbers' });
    expect(reads).toBe(0);
    // With the guard satisfied (the stored prompt is the same text) the same vector distance serves.
    await w.store.upsert({ scope: scoped, contextHash: CTX, exactKey: `${prefix}order-1234`, embedding: atSimilarity(0.982), embedder: 'voyage-4-lite', guardSig: guardSignature('refund order number 1235'), expiresAt: new Date(NOW + 3600_000) });
    expect((await lookup.find(scoped, split('refund order number 1235'))).status).toBe('hit');
    expect(reads).toBe(1);
  });

  it('each guard rule reaches the caller, and the content-word guard can be switched off', async () => {
    const scoped = `${run}-rules`;
    const cases: Array<[string, string, string | undefined]> = [
      ['pay 10 dollars today', 'pay 11 dollars today', 'numbers'],
      [`say 'hi there' to him`, `say 'bye now' to him`, 'quotes'],
      ['visit France this summer', 'visit Spain this summer', 'names'],
      ['is it safe to eat', 'is it not safe to eat', 'negation'],
      ['reset account password quickly', 'update billing address immediately now', 'tokens'],
    ];
    for (const [i, [stored, asked, rule]] of cases.entries()) {
      const w = world({ [asked]: angle(0) });
      const key = `${prefix}rule-${i}`;
      await w.cache.set(key, answer);
      await w.store.upsert({ scope: scoped, contextHash: ctx(i), exactKey: key, embedding: atSimilarity(0.99), embedder: 'voyage-4-lite', guardSig: guardSignature(stored), expiresAt: new Date(NOW + 3600_000) });
      expect(await w.lookup.find(scoped, { text: asked, contextHash: ctx(i) }), asked).toEqual({ status: 'miss', guard: rule });
      if (rule === 'tokens') {
        const off = createSemanticLookup({ embedder: w.stub.embedder, store: w.store, cache: w.cache, threshold: 0.95, guard: { tokenSet: false, maxDiff: 2 }, crossModel: true, maxChars: 100, pgTimeoutMs: 500, clock: () => NOW });
        expect((await off.find(scoped, { text: asked, contextHash: ctx(i) })).status).toBe('hit');
      }
    }
  });

  it('a dangling row is removed without holding the lookup', async () => {
    const w = world({ q: angle(0) });
    const scoped = `${run}-slow-remove`;
    await w.store.upsert({ scope: scoped, contextHash: CTX, exactKey: `${prefix}missing2`, embedding: atSimilarity(0.99), embedder: 'voyage-4-lite', guardSig: guardSignature('q'), expiresAt: new Date(NOW + 3600_000) });
    const stuck: SemanticStore = { ...w.store, remove: () => new Promise(() => {}) };
    const lookup = createSemanticLookup({ embedder: w.stub.embedder, store: stuck, cache: w.cache, threshold: 0.95, guard: { tokenSet: true, maxDiff: 2 }, crossModel: true, maxChars: 100, pgTimeoutMs: 500, clock: () => NOW });
    // A delete that never finishes: the lookup still answers.
    expect(await Promise.race([lookup.find(scoped, split('q')), new Promise((r) => setTimeout(() => r('hung'), 1000))])).toEqual({ status: 'miss' });
  });
});
