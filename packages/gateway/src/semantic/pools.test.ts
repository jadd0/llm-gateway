import { randomBytes } from 'node:crypto';
import { like, sql } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';
import { semanticCache } from '../db/schema.ts';
import { testConfig } from '../test-env.ts';
import { guardSignature } from './guards.ts';
import { CONNECT_TIMEOUT_MS, createSemanticPools } from './pools.ts';
import { createSemanticStore } from './store.ts';
import { angle } from './test-support.ts';

const config = testConfig();
const run = randomBytes(4).toString('hex');
const NOW = new Date('2030-01-01T00:00:00Z');
const ctx = '1'.padEnd(64, '0');
const made: Array<{ close(): Promise<void> }> = [];
const open = (over: Partial<Parameters<typeof createSemanticPools>[0]> = {}) => {
  const pools = createSemanticPools({ databaseUrl: config.databaseUrl, lookupPool: 3, writePool: 2, lookupTimeoutMs: 100, ...over });
  made.push(pools);
  return pools;
};
const rowOf = (key: string, scope = 'p') => ({ scope: `${run}-${scope}`, contextHash: ctx, exactKey: `k-${key}`, embedding: angle(10), embedder: 'voyage-4-lite', guardSig: guardSignature('q'), expiresAt: new Date(NOW.getTime() + 3600_000) });
const q = (scope = 'p') => ({ scope: `${run}-${scope}`, contextHash: ctx, embedding: angle(0), now: NOW });

afterAll(async () => {
  const pools = open();
  await pools.write.db.delete(semanticCache).where(like(semanticCache.scope, `${run}%`));
  for (const m of made) await m.close();
});

describe('semantic pools', () => {
  it('the lookup budget is a statement timeout, not the time allowed to open a connection', async () => {
    const pools = open();
    const opts = pools.lookup.pool.options as { connectionTimeoutMillis?: number; statement_timeout?: number; min?: number };
    expect(opts.statement_timeout).toBe(100);
    expect(opts.connectionTimeoutMillis).toBe(CONNECT_TIMEOUT_MS);
    expect(opts.connectionTimeoutMillis).toBeGreaterThan(opts.statement_timeout!);
    expect(opts.min).toBe(2);
    // The write pool has no statement timeout: an upsert into the vector index may take longer than a lookup may.
    expect((pools.write.pool.options as { statement_timeout?: number }).statement_timeout).toBeUndefined();
  });

  it('a cold pool serves a lookup, and warming opens the idle connections up front', async () => {
    const pools = open();
    const store = createSemanticStore(pools.write.db, { lookupDb: pools.lookup.db });
    await store.upsert(rowOf('cold'));
    expect(pools.lookup.pool.totalCount).toBe(0);
    expect((await store.nearest(q()))?.exactKey).toBe('k-cold');
    await pools.warm();
    expect(pools.lookup.pool.idleCount).toBe(2);
    // The server enforces the budget on the connections it opened: a statement past it is cancelled.
    await expect(pools.lookup.db.execute(sql`SELECT pg_sleep(1)`)).rejects.toMatchObject({ cause: { code: '57014' } });
  });

  it('a burst of fills that takes the whole write pool leaves lookups their connections', async () => {
    const pools = open({ writePool: 2 });
    const store = createSemanticStore(pools.write.db, { lookupDb: pools.lookup.db });
    await store.upsert(rowOf('burst', 'b'));
    // Every write connection is busy and more fills are queued behind them.
    const held = await Promise.all([pools.write.pool.connect(), pools.write.pool.connect()]);
    const queued = [store.upsert(rowOf('q1', 'b')), store.upsert(rowOf('q2', 'b')), store.upsert(rowOf('q3', 'b'))];
    while (pools.write.pool.waitingCount < 3) await new Promise((r) => setTimeout(r, 5));
    try {
      const t0 = performance.now();
      const found = await Promise.race([store.nearest(q('b')), new Promise<'stuck'>((r) => setTimeout(() => r('stuck'), 1500))]);
      expect(found).toMatchObject({ exactKey: 'k-burst' });
      expect(performance.now() - t0).toBeLessThan(500);
    } finally {
      for (const c of held) c.release();
      await Promise.all(queued);
    }
  });
});

