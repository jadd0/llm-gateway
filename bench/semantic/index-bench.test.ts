import { randomBytes } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { createDb } from '../../packages/gateway/src/db/client.ts';
import { testConfig } from '../../packages/gateway/src/test-env.ts';
import { ivfLists, percentile, recallAt1, renderTable, runIndexBench, syntheticVectors } from './index-bench.ts';

const config = testConfig();
const handle = createDb({ databaseUrl: config.databaseUrl, poolSize: 3 });
afterAll(() => handle.close());

describe('vector index bench', () => {
  it('recall counts the exact answer, or a row exactly as near, and nothing else', () => {
    const exact = [{ id: 1, distance: 0.1 }, { id: 2, distance: 0.2 }, { id: 3, distance: 0.3 }, undefined];
    expect(recallAt1(exact, exact)).toBe(1);
    expect(recallAt1(exact, [{ id: 1, distance: 0.1 }, { id: 9, distance: 0.2 }, { id: 8, distance: 0.31 }, undefined])).toBe(0.75);
    expect(recallAt1(exact, [{ id: 9, distance: 0.15 }, { id: 9, distance: 0.5 }, undefined, { id: 4, distance: 0.1 }])).toBe(0);
    expect(() => recallAt1([], [])).toThrow();
    expect(() => recallAt1(exact, exact.slice(1))).toThrow();
  });

  it('percentiles come from the sorted samples', () => {
    const xs = Array.from({ length: 100 }, (_, i) => i + 1);
    expect(percentile(xs, 50)).toBe(50);
    expect(percentile(xs, 95)).toBe(95);
    expect(percentile([7], 95)).toBe(7);
    expect(percentile([], 50)).toBeNaN();
    expect([10_000, 100_000, 2_000_000].map(ivfLists)).toEqual([10, 100, 1414]);
  });

  it('runs every variant on a small table, exact is exact, and the scratch table is gone afterwards', async () => {
    const vectors = syntheticVectors(420, 32, 5);
    const table = `semantic_bench_t${randomBytes(3).toString('hex')}`;
    const rows = await runIndexBench({ pool: handle.pool, table, vectors, size: 400, queries: 20, seed: 1 });
    // 3 variants x 2 filters, one row each.
    expect(rows.map((r) => `${r.variant}/${r.filter}`).sort()).toEqual([
      'exact/1 context',
      'exact/50 contexts',
      'hnsw/1 context',
      'hnsw/50 contexts',
      'ivfflat/1 context',
      'ivfflat/50 contexts',
    ]);
    for (const r of rows) {
      expect(r.recall, `${r.variant} ${r.filter}`).toBeGreaterThan(0.5);
      expect(r.recall).toBeLessThanOrEqual(1);
      expect(r.p50Ms).toBeGreaterThan(0);
      expect(r.p95Ms).toBeGreaterThanOrEqual(r.p50Ms);
      expect(['vector index', 'btree + sort']).toContain(r.plan);
    }
    expect(rows.filter((r) => r.variant === 'exact').every((r) => r.recall === 1 && r.plan === 'btree + sort')).toBe(true);
    for (const r of rows.filter((x) => x.variant !== 'exact')) {
      expect(r.buildS).toBeGreaterThan(0);
      expect(r.sizeMb).toBeGreaterThan(0);
    }
    const left = await handle.pool.query('SELECT to_regclass($1) AS t', [table]);
    expect(left.rows[0].t).toBeNull();
    const md = renderTable(rows);
    expect(md).toContain('## 400 vectors');
    expect(md).not.toMatch(/NaN|undefined/);
  }, 60_000);

  it('too few vectors for the queries is refused before anything is created', async () => {
    const table = `semantic_bench_t${randomBytes(3).toString('hex')}`;
    await expect(runIndexBench({ pool: handle.pool, table, vectors: syntheticVectors(30, 8, 1), size: 30, queries: 10, seed: 1 })).rejects.toThrow(/need 40 vectors/);
    expect((await handle.pool.query('SELECT to_regclass($1) AS t', [table])).rows[0].t).toBeNull();
  });
});
