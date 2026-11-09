import { randomBytes } from 'node:crypto';
import { like } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';
import { createDb } from '../db/client.ts';
import { semanticCache } from '../db/schema.ts';
import { testConfig } from '../test-env.ts';
import { guardSignature } from './guards.ts';
import { createSemanticStore, sweepExpired, type SemanticRow } from './store.ts';
import { angle, atSimilarity } from './test-support.ts';

const config = testConfig();
const handle = createDb({ databaseUrl: config.databaseUrl, poolSize: 4 });
const store = createSemanticStore(handle.db);
const run = randomBytes(4).toString('hex');
const NOW = new Date('2030-01-01T00:00:00Z');
const later = (s: number) => new Date(NOW.getTime() + s * 1000);
const ctx = (c: string) => c.padEnd(64, '0');

afterAll(async () => {
  await handle.db.delete(semanticCache).where(like(semanticCache.scope, `${run}%`));
  await handle.close();
});

const row = (scope: string, c: string, key: string, embedding: number[], over: Partial<SemanticRow> = {}): SemanticRow => ({
  scope: `${run}-${scope}`,
  contextHash: ctx(c),
  exactKey: `k-${key}`,
  embedding,
  embedder: 'voyage-4-lite',
  guardSig: guardSignature(`prompt ${key}`),
  expiresAt: later(3600),
  ...over,
});
const ask = (scope: string, c: string, embedding: number[], extra: { embedder?: string; now?: Date } = {}) =>
  store.nearest({ scope: `${run}-${scope}`, contextHash: ctx(c), embedding, now: extra.now ?? NOW, timeoutMs: 5000, ...(extra.embedder ? { embedder: extra.embedder } : {}) });

describe('semantic store (postgres + pgvector)', () => {
  it('nearest within scope and context only', async () => {
    const q = angle(0);
    // The exact twin of the query exists in another scope and in another context: neither may be returned.
    await store.upsert(row('a', '1', 'far', angle(60)));
    await store.upsert(row('a', '1', 'near', atSimilarity(0.97)));
    await store.upsert(row('a', '1', 'nearer', atSimilarity(0.99)));
    await store.upsert(row('a', '2', 'twin-other-context', q));
    await store.upsert(row('b', '1', 'twin-other-scope', q));

    const hit = await ask('a', '1', q);
    expect(hit?.exactKey).toBe('k-nearer');
    expect(hit?.similarity).toBeCloseTo(0.99, 6);
    expect(hit?.embedder).toBe('voyage-4-lite');
    // Each twin is found from its own side, so the refusals above are not an empty table.
    expect((await ask('a', '2', q))?.exactKey).toBe('k-twin-other-context');
    expect((await ask('b', '1', q))?.exactKey).toBe('k-twin-other-scope');
    expect((await ask('b', '1', q))?.similarity).toBeCloseTo(1, 6);
    // Nothing in a scope or context that has no rows.
    expect(await ask('c', '1', q)).toBeUndefined();
    expect(await ask('a', '3', q)).toBeUndefined();
  });

  it('only rows made by the asked-for embedder are candidates when one is named', async () => {
    await store.upsert(row('e', '1', 'lite', atSimilarity(0.9), { embedder: 'voyage-4-lite' }));
    await store.upsert(row('e', '1', 'nano', atSimilarity(0.99), { embedder: 'voyage-4-nano' }));
    expect((await ask('e', '1', angle(0)))?.exactKey).toBe('k-nano');
    expect((await ask('e', '1', angle(0), { embedder: 'voyage-4-lite' }))?.exactKey).toBe('k-lite');
    expect(await ask('e', '1', angle(0), { embedder: 'other' })).toBeUndefined();
  });

  it('a second upsert of the same entry replaces its vector and extends its expiry', async () => {
    await store.upsert(row('u', '1', 'x', angle(90), { expiresAt: later(10) }));
    await store.upsert(row('u', '1', 'x', angle(0), { expiresAt: later(7200) }));
    const rows = await handle.db.select().from(semanticCache).where(like(semanticCache.scope, `${run}-u`));
    expect(rows).toHaveLength(1);
    expect((await ask('u', '1', angle(0), { now: later(60) }))?.similarity).toBeCloseTo(1, 6);
  });

  it('expired rows never returned', async () => {
    await store.upsert(row('x', '1', 'old', angle(0), { expiresAt: later(-1) }));
    await store.upsert(row('x', '1', 'edge', angle(1), { expiresAt: NOW }));
    await store.upsert(row('x', '1', 'live', angle(30), { expiresAt: later(1) }));
    // The best match by far is expired, as is the one that expires at this very instant.
    expect((await ask('x', '1', angle(0)))?.exactKey).toBe('k-live');
    expect(await ask('x', '1', angle(0), { now: later(1) })).toBeUndefined();
    expect((await ask('x', '1', angle(0), { now: later(-5) }))?.exactKey).toBe('k-old');
  });

  it('remove deletes one row', async () => {
    await store.upsert(row('r', '1', 'gone', angle(0)));
    const found = (await ask('r', '1', angle(0)))!;
    await store.remove(found.id);
    expect(await ask('r', '1', angle(0))).toBeUndefined();
  });

  it('cleanup deletes expired in batches', async () => {
    // Expiry in 2001 and a clock in 2002: other tests' rows (expiring after 2026) are not touched.
    const past = (n: number) => new Date(Date.UTC(2001, 0, 1, 0, 0, n));
    const clock = new Date(Date.UTC(2002, 0, 1));
    for (let i = 0; i < 5; i++) await store.upsert(row('c', '1', `exp-${i}`, angle(i), { expiresAt: past(i) }));
    await store.upsert(row('c', '1', 'live', angle(9), { expiresAt: later(3600) }));

    expect(await store.cleanupBatch(clock, 2)).toBe(2);
    expect(await handle.db.select().from(semanticCache).where(like(semanticCache.scope, `${run}-c`))).toHaveLength(4);
    // The rest go in batches of 2: 2 and 1.
    expect(await sweepExpired(store, clock, 2)).toEqual({ deleted: 3, batches: 2 });
    const left = await handle.db.select().from(semanticCache).where(like(semanticCache.scope, `${run}-c`));
    expect(left.map((r) => r.exactKey)).toEqual(['k-live']);
    expect(await sweepExpired(store, clock, 2)).toEqual({ deleted: 0, batches: 0 });
  });

  it('the filtered search finds a match even when thousands of closer rows belong to another context', async () => {
    // 1500 rows of another context sit nearer to the query than the one row that may be served.
    const crowd = Array.from({ length: 1500 }, (_, i) => row('crowd', 'other', `c${i}`, angle(0.001 * (i + 1))));
    for (let i = 0; i < crowd.length; i += 250) await Promise.all(crowd.slice(i, i + 250).map((r) => store.upsert(r)));
    await store.upsert(row('crowd', 'mine', 'mine', angle(80)));
    expect((await ask('crowd', 'mine', angle(0)))?.exactKey).toBe('k-mine');
  }, 60_000);
});
