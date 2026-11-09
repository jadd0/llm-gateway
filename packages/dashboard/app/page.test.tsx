import { randomBytes, randomUUID } from 'node:crypto';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { applyBatch } from '../../log-worker/src/batch.ts';
import { foldRollups } from '../../log-worker/src/rollup.ts';
import { createTenant } from '../../gateway/src/cli/keys.ts';
import { createDb } from '../../gateway/src/db/client.ts';
import { toLogFields, type LogEntry } from '../../gateway/src/requestlog/entry.ts';
import { lockRollupState, testConfig } from '../../gateway/src/test-env.ts';
import { OverviewView } from '../components/OverviewView.tsx';
import { lastErrors, overview } from '../lib/queries.ts';

// Rollups seeded through the worker's own batch code, read with the dashboard's queries, laid out by the view.
const owner = createDb({ databaseUrl: testConfig().databaseUrl, poolSize: 3 });
const run = randomBytes(4).toString('hex');
const NOW = new Date('2033-04-10T12:30:00Z');
const MIN = 60_000;
const tenants: Array<{ id: string; name: string }> = [];
let unlock: () => Promise<void>;
let originalMark = '';

// The totals tables have no tenant to delete by: this file owns the year 2033 in them.
const wipeTotals = async () => {
  await owner.pool.query("DELETE FROM rollup_total_minute WHERE bucket >= '2033-01-01' AND bucket < '2034-01-01'");
  await owner.pool.query("DELETE FROM rollup_total_hour WHERE bucket >= '2033-01-01' AND bucket < '2034-01-01'");
};

beforeAll(async () => {
  unlock = await lockRollupState(testConfig().databaseUrl);
  await wipeTotals();
  originalMark = ((await owner.pool.query("SELECT folded_through::text AS m FROM rollup_state WHERE id = 1")).rows[0] as { m: string }).m;
  await owner.pool.query("UPDATE rollup_state SET folded_through = 'epoch' WHERE id = 1");
  for (const n of ['north', 'south']) {
    const t = await createTenant(owner.db, `${n}-${run}`);
    tenants.push({ id: t.id, name: t.name });
  }
  const entries: LogEntry[] = Array.from({ length: 120 }, (_, i) => ({
    requestId: randomUUID(), startedAt: NOW.getTime() - 5 * MIN - i * 9 * MIN, tenantId: tenants[i % 2]!.id, keyId: null, model: `v-${run}`, servedModel: `v-${run}`, provider: 'mock',
    status: i % 10 === 0 ? 503 : 200, errorCode: i % 10 === 0 ? 'upstream_unavailable' : null, stream: false, promptTokens: 5, completionTokens: 9, costMicros: 1500 + i,
    savedMicros: 0, cache: i % 3 === 0 ? 'hit' : 'miss', attempts: 1, fallbackUsed: false, latencyMs: 40 + (i % 7) * 30, ttfbMs: null, upstreamMs: null,
  }));
  const r = await applyBatch(owner.db, entries.map((e, i) => ({ id: `${i}-0`, fields: toLogFields(e), stream: 'x' })));
  if (r.failed.length) throw new Error('seed failed');
  await foldRollups(owner.db, NOW, 90);
}, 30_000);
afterAll(async () => {
  const ids = tenants.map((t) => t.id);
  await owner.pool.query('DELETE FROM rollup_minute WHERE tenant_id = ANY($1)', [ids]);
  await owner.pool.query('DELETE FROM rollup_hour WHERE tenant_id = ANY($1)', [ids]);
  await owner.pool.query('DELETE FROM request_log WHERE tenant_id = ANY($1)', [ids]);
  await owner.pool.query('DELETE FROM tenants WHERE id = ANY($1)', [ids]);
  await wipeTotals();
  await owner.pool.query('UPDATE rollup_state SET folded_through = $1::timestamptz WHERE id = 1', [originalMark]);
  await owner.close();
  await unlock();
});

const charts = (html: string) => [...html.matchAll(/data-chart="([a-z]+)"/g)].map((m) => m[1]);

describe('overview page', () => {
  it('overview renders four charts and the errors table from seeded rollups', async () => {
    const data = await overview(owner.pool, '7d', NOW);
    const errors = (await lastErrors(owner.pool, 50)).filter((e) => tenants.some((t) => t.name === e.tenant));
    expect(data.totals.requests).toBe(120);
    expect(errors.length).toBe(12);
    const html = renderToStaticMarkup(<OverviewView data={data} errors={errors} />);

    expect(charts(html)).toEqual(['latency', 'spend', 'cache', 'errors']);
    // Each chart has its frame (Recharts draws the SVG in the browser) and carries its numbers as a table.
    expect((html.match(/class="recharts-wrapper"/g) ?? []).length).toBe(4);
    expect((html.match(/<details/g) ?? []).length).toBe(4);
    expect(html).toContain('aria-label="Latency over time"');
    expect(html).toContain('<th scope="col" class="num">p95</th>');
    expect(html).toContain('<th scope="col" class="num">Spend</th>');
    // 7d at one-hour steps: one table row per step that had traffic.
    expect(html).toContain(`<td>${tenants[0]!.name}</td>`);
    // Totals, tenants by name, and the failures table (12 rows, newest first, no key or content columns).
    expect(html).toContain('>120<');
    for (const t of tenants) expect(html).toContain(t.name);
    expect(html).toContain('Last 12 failed requests');
    expect((html.match(/upstream_unavailable/g) ?? []).length).toBe(12);
    expect(html).toContain('Request id');
    for (const forbidden of ['Key', 'Prompt', 'Completion', 'Cost']) expect(html).not.toMatch(new RegExp(`<th[^>]*>${forbidden}`));
    // The selected range is marked, the others link to theirs.
    expect(html).toMatch(/href="\/\?range=7d" aria-current="page"/);
    expect(html).toContain('href="/?range=1h"');
  });

  it('empty database shows empty states', async () => {
    const data = await overview(owner.pool, '24h', new Date('2046-01-01T00:00:00Z'));
    const html = renderToStaticMarkup(<OverviewView data={data} errors={[]} />);
    expect(charts(html)).toEqual([]);
    expect(html).toContain('No requests in this range');
    expect(html).toContain('No failed requests on record');
    // The tiles still show, with a dash where there is no rate or percentile.
    expect(html).toContain('Error rate');
    expect(html).toContain('—');
  });
});
