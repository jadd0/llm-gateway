import { randomBytes } from 'node:crypto';
import { like, sql } from 'drizzle-orm';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb } from '../db/client.ts';
import { semanticCache } from '../db/schema.ts';
import { testConfig } from '../test-env.ts';
import { guardSignature } from './guards.ts';
import type { Db } from '../db/client.ts';
import { checkPgvector, createSemanticStore, isMissingPgvector, sweepExpired, type SemanticRow, type SemanticStoreOptions } from './store.ts';
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

// A table of its own (same columns and indexes) in a schema of its own, reached through search_path, so a test
// can lock it, crowd it and tune the session without touching the table the other test files share.
describe('semantic store on a private table', () => {
  const schema = `s_${run}`;
  // A vector index scan that stops after 100 tuples and does not continue (at the defaults it is 20000 tuples,
  // which a table shared by many tenants exceeds the same way).
  const stingy = ['-c hnsw.max_scan_tuples=100', '-c hnsw.iterative_scan=off'];
  // And a planner that has no other way to order by distance than the vector index.
  const adverse = [...stingy, '-c enable_seqscan=off', '-c enable_bitmapscan=off'];
  const url = (options: string[]) => `${config.databaseUrl}${config.databaseUrl.includes('?') ? '&' : '?'}options=${encodeURIComponent([`-c search_path=${schema},public`, ...options].join(' '))}`;
  const ownDb = (options: string[] = []) => createDb({ databaseUrl: url(options), poolSize: 4 });
  const made: Array<{ close(): Promise<void> }> = [];
  const open = (options: string[] = [], storeOptions: SemanticStoreOptions = {}) => {
    const h = ownDb(options);
    made.push(h);
    return { h, store: createSemanticStore(h.db, storeOptions) };
  };

  beforeAll(async () => {
    await handle.db.execute(sql.raw(`CREATE SCHEMA ${schema}`));
    await handle.db.execute(sql.raw(`CREATE TABLE ${schema}.semantic_cache (LIKE public.semantic_cache INCLUDING ALL)`));
  });
  afterAll(async () => {
    for (const h of made) await h.close();
    await handle.db.execute(sql.raw(`DROP SCHEMA ${schema} CASCADE`));
  });

  // Rows of other scopes crowd the table; the few rows that may be served are far from the query.
  const crowd = async (store: ReturnType<typeof createSemanticStore>, n: number) => {
    const rows = Array.from({ length: n }, (_, i) => row('crowd', 'c', `crowd-${i}`, angle(0.1 * (i + 1))));
    for (let i = 0; i < rows.length; i += 250) await Promise.all(rows.slice(i, i + 250).map((r) => store.upsert(r)));
  };

  it('a postgres query that runs past its budget is cancelled there, and its connection is free again', async () => {
    const { h, store: own } = open();
    const locker = new pg.Client({ connectionString: url([]) });
    await locker.connect();
    try {
      await locker.query('BEGIN');
      await locker.query('LOCK TABLE semantic_cache IN ACCESS EXCLUSIVE MODE');
      const t0 = performance.now();
      const failure = await own.nearest({ scope: `${run}-t`, contextHash: ctx('1'), embedding: angle(0), now: NOW, timeoutMs: 80 }).catch((e: unknown) => e);
      const took = performance.now() - t0;
      expect(((failure as { cause?: { code?: string } }).cause ?? (failure as { code?: string })).code).toBe('57014'); // query_canceled: statement timeout
      expect(took).toBeGreaterThan(60);
      expect(took).toBeLessThan(1000);
      // The cancelled query is not left waiting on the lock, and the pool's connection did not stay in the transaction.
      const waiting = await handle.db.execute<{ n: string }>(
        sql`SELECT count(*) AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND query LIKE '%FROM semantic_cache%' AND pid <> ${(locker as unknown as { processID: number }).processID}`,
      );
      expect(Number(waiting.rows[0]!.n)).toBe(0);
      await locker.query('ROLLBACK');
      // The same pool answers at once afterwards.
      await own.upsert(row('t', '1', 'after', angle(0)));
      expect((await own.nearest({ scope: `${run}-t`, contextHash: ctx('1'), embedding: angle(0), now: NOW, timeoutMs: 1000 }))?.exactKey).toBe('k-after');
      expect(h.pool.waitingCount).toBe(0);
    } finally {
      await locker.end();
    }
  });

  it('a scope and context with few rows is found even when the vector index would give up first', async () => {
    const { store: own } = open(adverse);
    await crowd(own, 1500);
    await own.upsert(row('mine', 'm', 'far', angle(80)));
    await own.upsert(row('mine', 'm', 'nearer', angle(70)));
    const q = { scope: `${run}-mine`, contextHash: ctx('m'), embedding: angle(0), now: NOW, timeoutMs: 5000 };
    expect((await own.nearest(q))?.exactKey).toBe('k-nearer');
    expect((await own.nearest(q))?.similarity).toBeCloseTo(Math.cos((70 * Math.PI) / 180), 5);
    // The same query with the crowd's own scope is answered too (and by the nearest of the crowd).
    expect((await own.nearest({ ...q, scope: `${run}-crowd`, contextHash: ctx('c') }))?.exactKey).toBe('k-crowd-0');
  }, 60_000);

  for (const iterativeScan of [true, false]) {
    it(`a scope and context with many rows is searched exactly (${iterativeScan ? 'pgvector 0.8 iterative scan' : 'before 0.8: index off, exact sort'})`, async () => {
      // exactMax 3: the 6 rows below take the second path.
      const { store: own } = open(iterativeScan ? adverse : [...stingy, '-c enable_seqscan=off'], { exactMax: 3, pgvector: { version: iterativeScan ? '0.8.7' : '0.7.4', iterativeScan } });
      await crowd(own, 1500);
      const scoped = `${iterativeScan}`;
      for (const [i, deg] of [90, 85, 75, 60, 55, 50].entries()) await own.upsert(row(`many-${scoped}`, 'm', `m${i}`, angle(deg)));
      const got = await own.nearest({ scope: `${run}-many-${scoped}`, contextHash: ctx('m'), embedding: angle(0), now: NOW, timeoutMs: 5000 });
      expect(got?.exactKey).toBe('k-m5');
      expect(got?.similarity).toBeCloseTo(Math.cos((50 * Math.PI) / 180), 5);
    }, 60_000);
  }
});

describe('pgvector at start-up', () => {
  it('reads the installed version and says whether iterative scans exist', async () => {
    const found = await checkPgvector(handle.db);
    expect(found.version).toMatch(/^\d+\.\d+(\.\d+)?$/);
    expect(found.iterativeScan).toBe(Number(found.version.split('.')[0]) > 0 || Number(found.version.split('.')[1]) >= 8);
    const fake = (version: string | undefined) => ({ execute: async () => ({ rows: version ? [{ extversion: version }] : [] }) }) as unknown as Db['db'];
    expect(await checkPgvector(fake('0.7.4'))).toEqual({ version: '0.7.4', iterativeScan: false });
    expect(await checkPgvector(fake('0.8.0'))).toEqual({ version: '0.8.0', iterativeScan: true });
    expect(await checkPgvector(fake('0.10.1'))).toEqual({ version: '0.10.1', iterativeScan: true });
    await expect(checkPgvector(fake(undefined))).rejects.toThrow(/pgvector extension is not installed.*pgvector\/pgvector/);
  });

  it('recognises the errors a Postgres without pgvector gives', () => {
    expect(isMissingPgvector(new Error('extension "vector" is not available'))).toBe(true);
    expect(isMissingPgvector(new Error('Failed query', { cause: new Error('could not open extension control file "/usr/share/postgresql/17/extension/vector.control": No such file or directory') }))).toBe(true);
    expect(isMissingPgvector(new Error('type "vector" does not exist'))).toBe(true);
    expect(isMissingPgvector(new Error('connection refused'))).toBe(false);
  });
});
