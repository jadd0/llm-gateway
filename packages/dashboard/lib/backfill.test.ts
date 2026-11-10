import { randomBytes, randomUUID } from 'node:crypto';
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BOUNDS, histogramOf } from '../../log-worker/src/histogram.ts';
import { aggregate } from '../../log-worker/src/rollup.ts';
import { NO_TENANT } from '../../gateway/src/db/schema.ts';
import type { LogEntry } from '../../gateway/src/requestlog/entry.ts';
import { testConfig } from '../../gateway/src/test-env.ts';
import { RANGE_KEYS, overview, windowOf } from './queries.ts';

// The rollups migration run over a request log that already has history. A scratch schema holds a copy of the database as
// it was before the migration; the history is inserted; then the rollups migration runs and the dashboard's own queries
// are compared with the same answers computed from the raw log.
const folder = fileURLToPath(new URL('../../gateway/drizzle', import.meta.url));
const schema = `bf_${randomBytes(5).toString('hex')}`;
const admin = new pg.Pool({ connectionString: testConfig().databaseUrl, max: 1 });
let pool: pg.Pool;
let tmp = '';
let now = new Date();
const MIN = 60_000;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const model = (n: number) => `bf-model-${n}`;
const tenantIds = [randomUUID(), randomUUID(), randomUUID()];

beforeAll(async () => {
  await admin.query(`CREATE SCHEMA ${schema}`);
  pool = new pg.Pool({ connectionString: testConfig().databaseUrl, max: 4, options: `-c search_path=${schema},public` });
  // The migrations before the rollups one, in a folder of its own. Later ones are held back too: the migrator applies
  // only migrations newer than the last one applied, so a later one run first would make it skip the rollups one.
  tmp = mkdtempSync(join(tmpdir(), 'bf-migrations-'));
  cpSync(folder, tmp, { recursive: true });
  const journalPath = join(tmp, 'meta/_journal.json');
  const full = readFileSync(journalPath, 'utf8');
  const journal = JSON.parse(full) as { entries: Array<{ tag: string }> };
  const rollupsAt = journal.entries.findIndex((e) => e.tag.endsWith('_rollups'));
  expect(rollupsAt).toBeGreaterThanOrEqual(0);
  writeFileSync(journalPath, JSON.stringify({ ...journal, entries: journal.entries.slice(0, rollupsAt) }));
  await migrate(drizzle(pool), { migrationsFolder: tmp, migrationsSchema: schema });
  expect((await pool.query('SELECT to_regclass($1) AS t', [`${schema}.rollup_hour`])).rows[0]).toEqual({ t: null });

  // History: 900 requests from 35 days ago to 5 minutes ago, across the fold mark the migration will set (about 90 to 150
  // minutes ago), with errors, both cache hits, a null tenant, latencies from 0 ms to over the last bucket, and nulls.
  now = new Date();
  let seed = 99;
  const rand = () => (seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296;
  const rows: unknown[][] = [];
  for (let i = 0; i < 900; i++) {
    const age = i < 300 ? 5 * MIN + rand() * 4 * HOUR : 5 * MIN + rand() * 35 * DAY;
    const status = rand() < 0.06 ? 503 : rand() < 0.04 ? 429 : 200;
    const lat = i % 50 === 0 ? 0 : i % 61 === 0 ? 150_000 + i : rand() < 0.1 ? Math.floor(2000 + rand() * 9000) : Math.floor(rand() * 400);
    rows.push([
      randomUUID(), new Date(now.getTime() - age), i % 7 === 0 ? null : tenantIds[i % 3], model(i % 2), i % 11 === 0 ? null : model(i % 2), status,
      status === 200 && i % 13 === 0 ? 'upstream_stream_broken' : null, i % 5 === 0 ? null : Math.floor(rand() * 50), Math.floor(rand() * 300),
      Math.floor(rand() * 900), Math.floor(rand() * 40), ['hit', 'semantic-hit', 'miss', 'bypass', null][i % 5], lat,
    ]);
  }
  // Edge cases where the SQL and the worker could disagree: no model at all, a served model missing, every kind of status and
  // error code, a latency of exactly 1 and 2 ms, just inside and just past the last bucket bound, and no tenant.
  const edgeAge = 3 * DAY;
  const edge = (status: number, code: string | null, lat: number, over: Partial<{ tenant: string | null; model: string | null; served: string | null; cache: string | null }> = {}) =>
    rows.push([
      randomUUID(), new Date(now.getTime() - edgeAge - rows.length * 1000), 'tenant' in over ? over.tenant : tenantIds[0], 'model' in over ? over.model : 'bf-edge-model',
      'served' in over ? over.served : 'bf-edge-served', status, code, 7, 11, 13, 17, 'cache' in over ? over.cache : 'miss', lat,
    ]);
  edge(200, null, 5, { model: null, served: null });
  edge(200, null, 5, { served: null });
  edge(499, 'client_closed', 5);
  edge(200, 'client_closed', 5);
  edge(200, 'upstream_stream_broken', 5);
  edge(500, null, 5);
  edge(499, null, 5);
  edge(429, 'rate_limited', 5);
  edge(404, null, 1);
  edge(200, null, 2, { tenant: null, cache: 'semantic-hit' });
  edge(200, null, 120_000);
  edge(200, null, Math.floor(BOUNDS.at(-1)!));
  edge(200, null, Math.floor(BOUNDS.at(-1)!) + 1);
  for (let i = 0; i < rows.length; i += 100) {
    const chunk = rows.slice(i, i + 100);
    const values = chunk.map((_, r) => `(${Array.from({ length: 13 }, (_, c) => `$${r * 13 + c + 1}`).join(', ')}, false)`).join(', ');
    await pool.query(
      `INSERT INTO request_log (request_id, created_at, tenant_id, model, served_model, status, error_code, prompt_tokens, completion_tokens, cost_micros, saved_micros, cache, latency_ms, stream)
       VALUES ${values}`,
      chunk.flat(),
    );
  }
  writeFileSync(journalPath, full);
  await migrate(drizzle(pool), { migrationsFolder: tmp, migrationsSchema: schema });
}, 60_000);

afterAll(async () => {
  await pool.end();
  await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  await admin.end();
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

const raw = async (from: Date, to: Date) => {
  const r = await pool.query(
    `SELECT count(*)::int AS requests, count(*) FILTER (WHERE status >= 500 OR error_code = 'upstream_stream_broken')::int AS errors,
            count(*) FILTER (WHERE cache IN ('hit', 'semantic-hit'))::int AS hits, coalesce(sum(cost_micros), 0)::bigint AS cost,
            percentile_disc(0.5) WITHIN GROUP (ORDER BY latency_ms) AS p50, percentile_disc(0.95) WITHIN GROUP (ORDER BY latency_ms) AS p95
     FROM request_log WHERE created_at >= $1 AND created_at < $2`,
    [from, to],
  );
  return r.rows[0] as { requests: number; errors: number; hits: number; cost: string; p50: number; p95: number };
};
const within = (got: number | null, exact: number) => {
  expect(got).not.toBeNull();
  expect(got!).toBeGreaterThanOrEqual(Math.min(exact, 121_739));
  // One bucket above the exact value; past the last bucket the open-ended one reads the last bound.
  expect(got!).toBeLessThanOrEqual(Math.max(1, exact) * 1.05 + 1e-9);
};

describe('rollups migration over an existing log', () => {
  it('sets the fold mark where a worker would have it and fills the hour and minute tables', async () => {
    const mark = new Date(((await pool.query('SELECT (extract(epoch FROM folded_through) * 1000)::float8 AS ms FROM rollup_state')).rows[0] as { ms: number }).ms);
    expect(mark.getTime() % HOUR).toBe(0);
    expect(now.getTime() - mark.getTime()).toBeGreaterThanOrEqual(90 * MIN);
    expect(now.getTime() - mark.getTime()).toBeLessThan(150 * MIN + 10_000);
    const n = async (t: string) => ((await pool.query(`SELECT count(*)::int AS n FROM ${t}`)).rows[0] as { n: number }).n;
    for (const t of ['rollup_hour', 'rollup_total_hour', 'rollup_minute', 'rollup_total_minute']) expect(await n(t)).toBeGreaterThan(20);
    // Hour tables hold only what is before the mark; minute tables only what is within a day of it.
    expect(((await pool.query('SELECT max(bucket) AS b FROM rollup_hour')).rows[0] as { b: Date }).b.getTime()).toBeLessThan(mark.getTime());
    expect(((await pool.query('SELECT min(bucket) AS b FROM rollup_minute')).rows[0] as { b: Date }).b.getTime()).toBeGreaterThanOrEqual(mark.getTime() - DAY);
  });

  it('shows the history in every range, equal to the raw aggregate', async () => {
    for (const range of RANGE_KEYS) {
      const { from, to } = windowOf(range, now);
      const want = await raw(from, to);
      const got = await overview(pool, range, now);
      expect(want.requests).toBeGreaterThan(range === '1h' ? 0 : 40);
      expect([got.totals.requests, got.totals.errors, got.totals.costMicros]).toEqual([want.requests, want.errors, Number(want.cost)]);
      expect(got.totals.cacheHitRate).toBeCloseTo(want.hits / want.requests, 10);
      within(got.totals.p50, want.p50);
      within(got.totals.p95, want.p95);
      expect(got.series.reduce((s, p) => s + p.requests, 0)).toBe(want.requests);
    }
    // Spend by tenant over 30 days equals the raw sums, tenants and the unauthenticated alike.
    const { from, to } = windowOf('30d', now);
    const spend = await pool.query(
      `SELECT coalesce(tenant_id, '00000000-0000-0000-0000-000000000000') AS t, sum(cost_micros)::bigint AS cost FROM request_log WHERE created_at >= $1 AND created_at < $2 GROUP BY 1`,
      [from, to],
    );
    const o = await overview(pool, '30d', now);
    expect(o.byTenant.map((t) => [t.tenantId, t.costMicros]).sort()).toEqual(spend.rows.map((r: { t: string; cost: string }) => [r.t, Number(r.cost)]).sort());
    expect(o.byTenant.length).toBe(4);
  });

  it('puts every latency in the bucket the worker would have: the hour histograms equal histograms built from the raw rows', async () => {
    const want = await pool.query(
      `SELECT date_trunc('hour', created_at, 'UTC') AS b, coalesce(tenant_id, '00000000-0000-0000-0000-000000000000') AS t, coalesce(served_model, model, '') AS m, array_agg(latency_ms) AS lat
       FROM request_log WHERE created_at < (SELECT folded_through FROM rollup_state) GROUP BY 1, 2, 3 ORDER BY 1, 2, 3`,
    );
    const got = await pool.query('SELECT bucket AS b, tenant_id AS t, model AS m, latency_hist AS hist FROM rollup_hour ORDER BY 1, 2, 3');
    expect(want.rows.length).toBeGreaterThan(100);
    expect(got.rows.map((r: { hist: number[] }) => r.hist)).toEqual(want.rows.map((r: { lat: number[] }) => histogramOf(r.lat.map(Number))));
    // The 150 s and 0 ms requests are in the open-ended and the first bucket.
    const all = got.rows.map((r: { hist: number[] }) => r.hist);
    expect(all.some((h: number[]) => h.length === 242)).toBe(true);
    expect(all.some((h: number[]) => (h[0] ?? 0) > 0)).toBe(true);
  });
});

describe('the backfill agrees with the worker', () => {
  const migration = readFileSync(join(folder, readdirSync(folder).find((f) => f.endsWith('_rollups.sql'))!), 'utf8');

  it('carries the worker latency bounds, the unauthenticated sentinel and the fold delay as literals that match the code', () => {
    const literal = /width_bucket\(latency_ms::float8 - 1e-9, ARRAY\[([^\]]+)\]::float8\[\]\)/.exec(migration)![1]!;
    expect(literal.split(',').map(Number)).toEqual([...BOUNDS]);
    expect(migration).toContain(`'${NO_TENANT}'::uuid`);
    expect(migration).toContain("interval '90 minutes'");
    expect(testConfig().rollupFoldAfterMin).toBe(90);
  });

  it("writes the hour tables the worker's own aggregation would, edge cases included", async () => {
    const r = await pool.query(
      `SELECT created_at, tenant_id, model, served_model, status, error_code, cache, prompt_tokens, completion_tokens, cost_micros, saved_micros, latency_ms
       FROM request_log WHERE created_at < (SELECT folded_through FROM rollup_state)`,
    );
    const entries = r.rows.map((x: Record<string, unknown>) => ({
      startedAt: (x.created_at as Date).getTime(), tenantId: x.tenant_id, model: x.model, servedModel: x.served_model, status: x.status, errorCode: x.error_code, cache: x.cache,
      promptTokens: x.prompt_tokens, completionTokens: x.completion_tokens, costMicros: Number(x.cost_micros), savedMicros: Number(x.saved_micros), latencyMs: x.latency_ms,
    })) as unknown as LogEntry[];
    const want = aggregate(entries, (t) => Math.floor(t / HOUR) * HOUR).map((g) => [g.bucket.toISOString(), g.tenantId, g.model, g.requests, g.errors, g.cacheHits, g.semanticHits, g.costMicros, g.savedMicros, g.promptTokens, g.completionTokens, g.latencyHist]);
    const got = (await pool.query('SELECT bucket, tenant_id, model, requests, errors, cache_hits, semantic_hits, cost_micros, saved_micros, prompt_tokens, completion_tokens, latency_hist FROM rollup_hour ORDER BY 1, 2, 3')).rows.map(
      (x: Record<string, unknown>) => [(x.bucket as Date).toISOString(), x.tenant_id, x.model, x.requests, x.errors, x.cache_hits, x.semantic_hits, Number(x.cost_micros), Number(x.saved_micros), Number(x.prompt_tokens), Number(x.completion_tokens), x.latency_hist],
    );
    expect(want.length).toBeGreaterThan(100);
    expect(got).toEqual(want);
    // The edge cases are in it: an empty model, a null tenant, and each of an error, a client that left and a refusal.
    expect(got.some((g) => g[2] === '')).toBe(true);
    expect(got.some((g) => g[1] === NO_TENANT && (g[6] as number) > 0)).toBe(true);
    expect(entries.filter((e) => e.status === 499 && e.errorCode === 'client_closed')).toHaveLength(1);
  });
});
