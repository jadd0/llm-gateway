import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { histogramOf } from '../../packages/log-worker/src/histogram.ts';
import { createDb } from '../../packages/gateway/src/db/client.ts';
import { lockRollupState, testConfig } from '../../packages/gateway/src/test-env.ts';
import { MODELS, TENANT_COUNT, ensureTenants, entryAt, forget, seed } from './seed.ts';

// A small seed through the worker's batch code. The window is in 2034, so nothing else in the database overlaps it.
const db = createDb({ databaseUrl: testConfig().databaseUrl, poolSize: 3 });
const prefix = `bs${randomBytes(3).toString('hex')}-`;
const NOW = new Date('2034-05-20T12:00:00Z');
const window = { from: NOW.getTime() - 5 * 24 * 3_600_000, to: NOW.getTime() - 5 * 60_000 };
let ids: string[] = [];
// A seed of this run's own, so its request ids cannot meet those of an earlier run left in the database.
const SEED = 1000 + Math.floor(Math.random() * 4_000_000_000);
let unlock: () => Promise<void>;
let originalMark = '';

beforeAll(async () => {
  unlock = await lockRollupState(testConfig().databaseUrl);
  originalMark = ((await db.pool.query("SELECT folded_through::text AS m FROM rollup_state WHERE id = 1")).rows[0] as { m: string }).m;
  await db.pool.query("UPDATE rollup_state SET folded_through = 'epoch' WHERE id = 1");
  ids = await ensureTenants(db.db, prefix);
}, 30_000);
afterAll(async () => {
  await forget(db.db, ids);
  await db.pool.query('UPDATE rollup_state SET folded_through = $1::timestamptz WHERE id = 1', [originalMark]);
  await db.close();
  await unlock();
});

describe('bench seed', () => {
  it('is deterministic: the same row number is the same request, and a bigger run extends a smaller one', () => {
    const a = Array.from({ length: 200 }, (_, i) => entryAt(i, ids, window, SEED));
    const b = Array.from({ length: 200 }, (_, i) => entryAt(i, ids, window, SEED));
    expect(a).toEqual(b);
    expect(new Set(a.map((e) => e.requestId)).size).toBe(200);
    expect(a.every((e) => e.startedAt >= window.from && e.startedAt < window.to)).toBe(true);
    expect(entryAt(5, ids, window, SEED + 1)).not.toEqual(a[5]);
  });

  it('has the shape the plan asks for: 20 tenants, 6 models, about 2% errors and 30% cache hits', () => {
    expect(ids).toHaveLength(TENANT_COUNT);
    const es = Array.from({ length: 20_000 }, (_, i) => entryAt(i, ids, window, SEED));
    expect(new Set(es.map((e) => e.tenantId)).size).toBe(TENANT_COUNT);
    expect(new Set(es.map((e) => e.model))).toEqual(new Set(MODELS));
    expect(es.filter((e) => e.status >= 500).length / es.length).toBeGreaterThan(0.015);
    expect(es.filter((e) => e.status >= 500).length / es.length).toBeLessThan(0.025);
    expect(es.filter((e) => e.cache === 'hit').length / es.length).toBeGreaterThan(0.27);
    expect(es.filter((e) => e.cache === 'hit').length / es.length).toBeLessThan(0.31);
  });

  it("seeded rollups equal the worker's own aggregation", async () => {
    const n = 3000;
    expect(await seed(db.db, { tenantIds: ids, window, fromRow: 0, toRow: n, now: NOW, batch: 700, seed: SEED })).toBe(n);
    // Seeding the same rows again changes nothing (redelivery), and extending adds only the new ones.
    expect(await seed(db.db, { tenantIds: ids, window, fromRow: 0, toRow: n, now: NOW, seed: SEED })).toBe(0);
    expect(await seed(db.db, { tenantIds: ids, window, fromRow: n, toRow: n + 500, now: NOW, seed: SEED })).toBe(500);

    // Hour by hour, per tenant and model, straight from the log: counts, errors, hits, cost and the latency histogram.
    const raw = await db.pool.query(
      `SELECT date_trunc('hour', created_at, 'UTC') AS b, tenant_id, coalesce(served_model, model, '') AS m, count(*)::int AS requests,
              count(*) FILTER (WHERE status >= 500)::int AS errors, count(*) FILTER (WHERE cache = 'hit')::int AS hits,
              sum(cost_micros)::bigint AS cost, array_agg(latency_ms) AS lat
       FROM request_log WHERE tenant_id = ANY($1) GROUP BY 1, 2, 3 ORDER BY 1, 2, 3`,
      [ids],
    );
    // Hours up to the fold horizon are in the hour table; the rest are still minutes. Read both and sum by hour.
    const roll = await db.pool.query(
      `WITH u AS (
         SELECT bucket, tenant_id, model, requests, errors, cache_hits, cost_micros, latency_hist FROM rollup_hour WHERE tenant_id = ANY($1)
         UNION ALL
         SELECT date_trunc('hour', bucket, 'UTC'), tenant_id, model, requests, errors, cache_hits, cost_micros, latency_hist
         FROM rollup_minute WHERE tenant_id = ANY($1) AND bucket >= (SELECT folded_through FROM rollup_state WHERE id = 1))
       SELECT bucket AS b, tenant_id, model AS m, sum(requests)::int AS requests, sum(errors)::int AS errors, sum(cache_hits)::int AS hits,
              sum(cost_micros)::bigint AS cost, hist_sum(latency_hist) AS hist
       FROM u GROUP BY 1, 2, 3 ORDER BY 1, 2, 3`,
      [ids],
    );
    expect(raw.rows.length).toBeGreaterThan(200);
    expect(raw.rows.reduce((s: number, r: { requests: number }) => s + r.requests, 0)).toBe(n + 500);
    const shape = (r: Record<string, unknown>) => [new Date(r.b as string).toISOString(), r.tenant_id, r.m, r.requests, r.errors, r.hits, String(r.cost)];
    expect(roll.rows.map(shape)).toEqual(raw.rows.map(shape));
    expect(roll.rows.map((r: { hist: number[] }) => r.hist)).toEqual(raw.rows.map((r: { lat: number[] }) => histogramOf(r.lat.map(Number))));
  }, 60_000);
});
