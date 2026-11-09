import { randomBytes, randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { applyBatch } from '../../log-worker/src/batch.ts';
import { deleteOldMinutes, foldRollups } from '../../log-worker/src/rollup.ts';
import { createTenant } from '../../gateway/src/cli/keys.ts';
import { periodOf } from '../../gateway/src/budget/period.ts';
import { createDb } from '../../gateway/src/db/client.ts';
import { provisionReader } from '../../gateway/src/db/reader.ts';
import { toLogFields, toSpendFields, type LogEntry, type SpendEntry } from '../../gateway/src/requestlog/entry.ts';
import { lockRollupState, testConfig } from '../../gateway/src/test-env.ts';
import { RANGES, RANGE_KEYS, lastErrors, overview, windowOf, type Queryable } from './queries.ts';

// Real Postgres, read through the dashboard's own login role, so a query that touches anything the role may not
// read fails here. The clock is injected; the data is in 2032 so nothing else in the database overlaps it.
const owner = createDb({ databaseUrl: testConfig().databaseUrl, poolSize: 4 });
const loginName = `dashq_${randomBytes(5).toString('hex')}`;
const loginPassword = randomBytes(18).toString('hex');
const NOW = new Date('2032-06-15T12:30:00Z');
const MIN = 60_000;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const run = randomBytes(4).toString('hex');

let reader: pg.Pool;
let unlock: () => Promise<void>;
let originalMark = '';
const sqlSeen: string[] = [];
const watched: Queryable = {
  query(text, params) {
    sqlSeen.push(text);
    return reader.query(text, params as unknown[]) as never;
  },
};
const tenants: Array<{ id: string; name: string }> = [];

function lcg(seed: number) {
  let s = seed;
  return () => (s = (s * 1664525 + 1013904223) % 4294967296) / 4294967296;
}

const logs: LogEntry[] = [];
const spends: SpendEntry[] = [];

// The totals tables have no tenant to delete by: this file owns the year 2032 in them.
const wipeTotals = async () => {
  await owner.pool.query("DELETE FROM rollup_total_minute WHERE bucket >= '2032-01-01' AND bucket < '2033-01-01'");
  await owner.pool.query("DELETE FROM rollup_total_hour WHERE bucket >= '2032-01-01' AND bucket < '2033-01-01'");
};

beforeAll(async () => {
  unlock = await lockRollupState(testConfig().databaseUrl);
  await wipeTotals();
  originalMark = ((await owner.pool.query("SELECT folded_through::text AS m FROM rollup_state WHERE id = 1")).rows[0] as { m: string }).m;
  await owner.pool.query("UPDATE rollup_state SET folded_through = 'epoch' WHERE id = 1");
  const url = new URL(testConfig().databaseUrl);
  url.username = loginName;
  url.password = loginPassword;
  const c = await owner.pool.connect();
  try {
    await provisionReader(c, url.toString());
  } finally {
    c.release();
  }
  reader = new pg.Pool({ connectionString: url.toString(), max: 2 });

  for (const n of ['alpha', 'bravo', 'charlie']) {
    const t = await createTenant(owner.db, `${n}-${run}`);
    tenants.push({ id: t.id, name: t.name });
  }
  const rand = lcg(42);
  const period = periodOf(NOW.getTime());
  // 9 days of traffic ending 20 minutes before NOW, a request every ~4 minutes, a few failures and cache hits.
  for (let i = 0; i < 3000; i++) {
    const startedAt = NOW.getTime() - 20 * MIN - Math.floor(rand() * 9 * DAY);
    const t = tenants[Math.floor(rand() * 3)]!;
    const failed = rand() < 0.04;
    const cache = rand() < 0.3 ? 'hit' : rand() < 0.1 ? 'semantic-hit' : 'miss';
    const cost = cache === 'miss' && !failed ? 100 + Math.floor(rand() * 900) : 0;
    const e: LogEntry = {
      requestId: randomUUID(), startedAt, tenantId: t.id, keyId: null, model: `m-${run}-a`, servedModel: `m-${run}-${rand() < 0.5 ? 'a' : 'b'}`, provider: 'mock',
      status: failed ? 502 : 200, errorCode: failed ? 'upstream_error' : null, stream: false, promptTokens: 10, completionTokens: 20, costMicros: cost, savedMicros: 0,
      cache, attempts: 1, fallbackUsed: false, latencyMs: rand() < 0.1 ? 1500 + Math.floor(rand() * 4000) : 30 + Math.floor(rand() * 150), ttfbMs: null, upstreamMs: null,
    };
    logs.push(e);
    if (cost > 0) spends.push({ kind: 'charge', id: e.requestId, tenantId: t.id, period, model: `m-${run}-a`, promptTokens: 10, completionTokens: 20, costMicros: cost, estimated: false, savedMicros: 0 });
  }
  const raws = [...logs.map((e) => toLogFields(e)), ...spends.map((s) => toSpendFields(s))].map((fields, i) => ({ id: `${i}-0`, fields, stream: 'x' }));
  for (let i = 0; i < raws.length; i += 500) {
    const r = await applyBatch(owner.db, raws.slice(i, i + 500));
    if (r.failed.length || r.malformed.length) throw new Error('seed batch failed');
  }
  await foldRollups(owner.db, NOW, 90);
}, 60_000);

afterAll(async () => {
  await reader.end();
  const ids = tenants.map((t) => t.id);
  await owner.pool.query('DELETE FROM rollup_minute WHERE tenant_id = ANY($1) OR model LIKE $2', [ids, `m-${run}-%`]);
  await owner.pool.query('DELETE FROM rollup_hour WHERE tenant_id = ANY($1) OR model LIKE $2', [ids, `m-${run}-%`]);
  await owner.pool.query('DELETE FROM request_log WHERE tenant_id = ANY($1) OR model LIKE $2', [ids, `m-${run}-%`]);
  await owner.pool.query('DELETE FROM tenants WHERE id = ANY($1)', [ids]);
  await wipeTotals();
  await owner.pool.query('UPDATE rollup_state SET folded_through = $1::timestamptz WHERE id = 1', [originalMark]);
  await owner.pool.query(`DROP ROLE IF EXISTS "${loginName}"`);
  await owner.close();
  await unlock();
}, 30_000);

// The answer for a window straight from the request log.
async function raw(range: (typeof RANGE_KEYS)[number]) {
  const { from, to } = windowOf(range, NOW);
  const r = await owner.pool.query(
    `SELECT count(*)::int AS requests, count(*) FILTER (WHERE status >= 500 OR error_code = 'upstream_stream_broken')::int AS errors,
            count(*) FILTER (WHERE cache IN ('hit', 'semantic-hit'))::int AS hits, coalesce(sum(cost_micros), 0)::bigint AS cost,
            percentile_disc(0.5) WITHIN GROUP (ORDER BY latency_ms) AS p50, percentile_disc(0.95) WITHIN GROUP (ORDER BY latency_ms) AS p95
     FROM request_log WHERE tenant_id = ANY($1) AND created_at >= $2 AND created_at < $3`,
    [tenants.map((t) => t.id), from, to],
  );
  const x = r.rows[0] as { requests: number; errors: number; hits: number; cost: string; p50: number; p95: number };
  return { requests: x.requests, errors: x.errors, hits: x.hits, cost: Number(x.cost), p50: x.p50, p95: x.p95 };
}
const mine = (o: Awaited<ReturnType<typeof overview>>) => o.byTenant.filter((t) => tenants.some((m) => m.id === t.tenantId));
// A percentile read from a histogram is the upper bound of the bucket the exact value is in.
const within = (got: number | null, exact: number) => {
  expect(got).not.toBeNull();
  expect(got!).toBeGreaterThanOrEqual(exact);
  expect(got!).toBeLessThanOrEqual(Math.max(1, exact) * 1.05 + 1e-9);
};

describe('overview', () => {
  it('range ≤ 24h reads minute rows, longer reads hour + unfolded minutes', async () => {
    for (const range of RANGE_KEYS) {
      sqlSeen.length = 0;
      const o = await overview(watched, range, NOW);
      const want = await raw(range);
      expect(want.requests).toBeGreaterThan(5);
      if (range !== '1h') expect(want.errors).toBeGreaterThan(0);
      expect([o.totals.requests, o.totals.errors, o.totals.costMicros]).toEqual([want.requests, want.errors, want.cost]);
      expect(o.totals.cacheHitRate).toBeCloseTo(want.hits / want.requests, 10);
      within(o.totals.p50, want.p50);
      within(o.totals.p95, want.p95);
      expect(o.series.reduce((s, p) => s + p.requests, 0)).toBe(want.requests);
      const tables = sqlSeen.join(' ');
      expect(tables.includes('FROM rollup_minute')).toBe(true);
      // Up to 24h the hour table is not touched; beyond it, it is read.
      expect(tables.includes('FROM rollup_hour')).toBe(range === '7d' || range === '30d');
    }
  });

  it('answers longer ranges from the hour table once the minutes are trimmed', async () => {
    const before = await overview(watched, '7d', NOW);
    // Retention leaves 25 hours of minutes; folded ones older than that go.
    const deleted = await deleteOldMinutes(owner.db, NOW, 25);
    expect(deleted).toBeGreaterThan(100);
    const after = await overview(watched, '7d', NOW);
    expect(after.totals).toEqual(before.totals);
    expect(after.series).toEqual(before.series);
    const day = await overview(watched, '24h', NOW);
    expect(day.totals.requests).toBe((await raw('24h')).requests);
    const month = await overview(watched, '30d', NOW);
    expect(month.totals.requests).toBe((await raw('30d')).requests);
  });

  it('shows a p95 that comes from merged histograms, not from the steps', async () => {
    const o = await overview(watched, '7d', NOW);
    const p95s = o.series.filter((p) => p.p95 !== null).map((p) => p.p95!);
    // The steps differ widely (a step of a few requests is dominated by one slow one), so their mean is no p95.
    expect(p95s.length).toBeGreaterThan(50);
    expect(Math.max(...p95s)).toBeGreaterThan(5 * Math.min(...p95s));
    within(o.totals.p95, (await raw('7d')).p95);
  });

  it('spend by tenant sums match the ledger for the range', async () => {
    const o = await overview(watched, '30d', NOW);
    const ledger = await owner.pool.query('SELECT tenant_id, sum(cost_micros)::bigint AS cost FROM spend_ledger WHERE tenant_id = ANY($1) GROUP BY 1', [tenants.map((t) => t.id)]);
    const want = new Map(ledger.rows.map((r: { tenant_id: string; cost: string }) => [r.tenant_id, Number(r.cost)]));
    expect(want.size).toBe(3);
    const got = mine(o);
    expect(got.map((t) => [t.tenantId, t.costMicros]).sort()).toEqual([...want.entries()].sort());
    expect(got.map((t) => t.name).sort()).toEqual(tenants.map((t) => t.name).sort());
    expect(got.every((t, i) => i === 0 || got[i - 1]!.costMicros >= t.costMicros)).toBe(true);
  });

  it('an empty window is all zeros and nulls, not an error', async () => {
    const o = await overview(watched, '24h', new Date('2045-01-01T00:00:00Z'));
    expect(o.series).toEqual([]);
    expect(o.byTenant).toEqual([]);
    expect(o.totals).toMatchObject({ requests: 0, errors: 0, errorRate: null, cacheHitRate: null, p50: null, p95: null, costMicros: 0 });
  });
});

describe('lastErrors', () => {
  it('returns the newest 50 failures, metadata only, newest first', async () => {
    const rows = await lastErrors(watched, 50);
    const failed = logs.filter((e) => e.status >= 500).sort((a, b) => b.startedAt - a.startedAt);
    expect(failed.length).toBeGreaterThan(50);
    expect(rows).toHaveLength(50);
    expect(rows.map((r) => r.requestId)).toEqual(failed.slice(0, 50).map((e) => e.requestId));
    expect(rows.every((r) => r.status === 502 && r.errorCode === 'upstream_error')).toBe(true);
    expect(Object.keys(rows[0]!).sort()).toEqual(['at', 'errorCode', 'latencyMs', 'model', 'requestId', 'status', 'tenant']);
    expect(rows[0]!.tenant).toBe(tenants.find((t) => t.id === failed[0]!.tenantId)!.name);
  });
});

describe('windows', () => {
  it('start on a boundary of the step of their range, so the first point covers a whole step', async () => {
    const now = new Date('2032-06-15T12:37:41Z');
    for (const range of RANGE_KEYS) {
      const { from, to } = windowOf(range, now);
      const { ms, stepMs } = RANGES[range];
      expect(from.getTime() % stepMs).toBe(0);
      // Never later than the range asked for, and less than one step earlier.
      expect(now.getTime() - from.getTime()).toBeGreaterThanOrEqual(ms);
      expect(now.getTime() - from.getTime()).toBeLessThan(ms + stepMs);
      expect(to).toEqual(now);
    }
    expect(windowOf('24h', now).from.toISOString()).toBe('2032-06-14T12:30:00.000Z');
    expect(windowOf('30d', now).from.toISOString()).toBe('2032-05-16T12:00:00.000Z');
    // And a series built on it has no point before it, and every point is a whole step.
    const o = await overview(watched, '24h', NOW);
    expect(o.series.length).toBeGreaterThan(20);
    expect(o.series.every((p) => p.t >= o.from.getTime() && p.t % o.stepMs === 0)).toBe(true);
  });
});

describe('queries', () => {
  it('run the series and the tenant spend at the same time', async () => {
    let inFlight = 0;
    let peak = 0;
    const slow: Queryable = {
      async query(text, params) {
        inFlight++;
        peak = Math.max(peak, inFlight);
        await new Promise((r) => setTimeout(r, 40));
        try {
          return await (reader.query(text, params as unknown[]) as never);
        } finally {
          inFlight--;
        }
      },
    };
    await overview(slow, '24h', NOW);
    expect(peak).toBe(2);
  });
});

describe('tenant names', () => {
  const GHOST_NOW = new Date('2030-06-15T12:30:00Z');
  const ghostModel = `ghost-${run}`;
  const ghostIds: string[] = [];
  let deleted = '';

  const entry = (tenantId: string | null, i: number, status: number): LogEntry => ({
    requestId: randomUUID(), startedAt: GHOST_NOW.getTime() - (i + 1) * 7 * MIN, tenantId, keyId: null, model: ghostModel, servedModel: ghostModel, provider: 'mock',
    status, errorCode: status >= 500 ? 'upstream_error' : null, stream: false, promptTokens: 1, completionTokens: 1, costMicros: 100, savedMicros: 0, cache: 'miss', attempts: 1,
    fallbackUsed: false, latencyMs: 50, ttfbMs: null, upstreamMs: null,
  });

  beforeAll(async () => {
    const t = await createTenant(owner.db, `ghost-${run}`);
    deleted = t.id;
    const es = [...[0, 1, 2, 3].map((i) => entry(t.id, i, i === 0 ? 502 : 200)), ...[4, 5, 6].map((i) => entry(null, i, i === 4 ? 503 : 200)), entry(tenants[0]!.id, 7, 502)];
    ghostIds.push(...es.map((e) => e.requestId));
    const r = await applyBatch(owner.db, es.map((e, i) => ({ id: `${i}-0`, fields: toLogFields(e), stream: 'x' })));
    if (r.failed.length) throw new Error('ghost seed failed');
    await owner.pool.query('DELETE FROM tenants WHERE id = $1', [t.id]);
  });
  afterAll(async () => {
    await owner.pool.query('DELETE FROM rollup_hour WHERE model = $1', [ghostModel]);
    await owner.pool.query('DELETE FROM rollup_minute WHERE model = $1', [ghostModel]);
    await owner.pool.query("DELETE FROM rollup_total_hour WHERE bucket >= '2030-01-01' AND bucket < '2031-01-01'");
    await owner.pool.query("DELETE FROM rollup_total_minute WHERE bucket >= '2030-01-01' AND bucket < '2031-01-01'");
    await owner.pool.query('DELETE FROM request_log WHERE request_id = ANY($1)', [ghostIds]);
  });

  it('calls only a request with no tenant unauthenticated; a tenant whose row is gone is a deleted tenant', async () => {
    // 30 days: these rows are far behind the fold mark, so they live in the hour tables only.
    const o = await overview(watched, '30d', GHOST_NOW);
    const names = o.byTenant.map((t) => t.name);
    expect(o.byTenant.find((t) => t.tenantId === deleted)!.name).toBe(`Deleted tenant ${deleted.slice(0, 8)}`);
    expect(names.filter((n) => n === 'Unauthenticated')).toHaveLength(1);
    expect(o.byTenant.find((t) => t.tenantId === tenants[0]!.id)!.name).toBe(tenants[0]!.name);
    expect(o.byTenant.find((t) => t.name === 'Unauthenticated')!.requests).toBe(3);

    const rows = await lastErrors(watched, 1_000_000);
    const label = (id: string) => rows.find((r) => r.requestId === id)!.tenant;
    const byId = new Map(ghostIds.map((id, i) => [i, id]));
    expect(label(byId.get(0)!)).toBe(`Deleted tenant ${deleted.slice(0, 8)}`);
    expect(label(byId.get(4)!)).toBe('Unauthenticated');
    expect(label(byId.get(7)!)).toBe(tenants[0]!.name);
  });
});
