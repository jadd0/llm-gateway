// Dashboard query time against log size. For each size the synthetic log is grown to that many rows (through the
// worker's own rollup code), then every dashboard range is timed two ways: the real queries on the rollups, and the
// same answer computed from the raw request log. The rollup time should stay flat; the raw time should grow.
//
//   npm run bench:dashboard -- --sizes 10000,100000,1000000,5000000 --out bench/results/pr-11
//   flags: --sizes a,b,c   --reps n (rollup queries, default 30)   --raw-reps n (raw queries, default 5)   --out dir
//
// Run behind `bash bench/quiet.sh <out>`. It TRUNCATES request_log and the rollup tables of the database it is
// pointed at, so it refuses any database that is not the worktree's own (TEST_DATABASE) or named *bench*.
// The database is BENCH_DATABASE_URL, or DATABASE_URL when that is unset.
import { mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import pg from 'pg';
import { createDb } from '../../packages/gateway/src/db/client.ts';
import { lastErrors, overview, windowOf, RANGE_KEYS, RANGES, type Queryable, type RangeKey } from '../../packages/dashboard/lib/queries.ts';
import { foldRollups } from '../../packages/log-worker/src/rollup.ts';
import { ensureTenants, seed } from './seed.ts';

export interface Timing {
  reps: number;
  p50Ms: number;
  p95Ms: number;
  minMs: number;
  maxMs: number;
}

export interface Row {
  size: number;
  query: string;
  source: 'rollups' | 'raw';
  timing: Timing;
}

export interface Agreement {
  size: number;
  range: RangeKey;
  rollup: { requests: number; errors: number; costMicros: number; p95: number | null };
  raw: { requests: number; errors: number; costMicros: number; p95: number | null };
}

export interface Results {
  startedAt: string;
  node: string;
  postgres: string;
  cpus: string;
  loadAvgAtStart: number[];
  sizes: number[];
  rollupRows: Array<{ size: number; rollupMinuteRows: number; rollupHourRows: number }>;
  rows: Row[];
  agreement: Agreement[];
  errorsUseIndex: boolean;
}

/** Nearest-rank percentile of timings (ms). */
export function pct(xs: number[], q: number): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.max(1, Math.ceil(q * s.length)) - 1]!;
}

export function summarize(ms: number[]): Timing {
  return { reps: ms.length, p50Ms: pct(ms, 0.5), p95Ms: pct(ms, 0.95), minMs: Math.min(...ms), maxMs: Math.max(...ms) };
}

/** One warm-up run, then `reps` timed runs. */
export async function timeIt(reps: number, fn: () => Promise<unknown>): Promise<Timing> {
  await fn();
  const ms: number[] = [];
  for (let i = 0; i < reps; i++) {
    const t0 = performance.now();
    await fn();
    ms.push(performance.now() - t0);
  }
  return summarize(ms);
}

/** The same answer as `overview()`, computed from the raw log: series by step, totals with exact percentiles, spend by tenant. */
export async function rawOverview(db: Queryable, range: RangeKey, now: Date) {
  const { from, to } = windowOf(range, now);
  const step = RANGES[range].stepMs;
  const params = [from.toISOString(), to.toISOString()];
  const where = 'created_at >= $1 AND created_at < $2';
  const series = await db.query(
    `SELECT to_timestamp(floor(extract(epoch FROM created_at) * 1000 / ${step}) * ${step} / 1000.0) AS t, count(*) AS requests,
            count(*) FILTER (WHERE status >= 500 OR error_code = 'upstream_stream_broken') AS errors, count(*) FILTER (WHERE cache IN ('hit', 'semantic-hit')) AS hits,
            percentile_disc(0.5) WITHIN GROUP (ORDER BY latency_ms) AS p50, percentile_disc(0.95) WITHIN GROUP (ORDER BY latency_ms) AS p95
     FROM request_log WHERE ${where} GROUP BY 1 ORDER BY 1`,
    params,
  );
  const totals = await db.query<{ requests: string; errors: string; cost: string; p50: number; p95: number }>(
    `SELECT count(*) AS requests, count(*) FILTER (WHERE status >= 500 OR error_code = 'upstream_stream_broken') AS errors, coalesce(sum(cost_micros), 0) AS cost,
            percentile_disc(0.5) WITHIN GROUP (ORDER BY latency_ms) AS p50, percentile_disc(0.95) WITHIN GROUP (ORDER BY latency_ms) AS p95
     FROM request_log WHERE ${where}`,
    params,
  );
  const byTenant = await db.query(`SELECT tenant_id, count(*) AS requests, sum(cost_micros) AS cost FROM request_log WHERE ${where} GROUP BY 1 ORDER BY 3 DESC`, params);
  const t = totals.rows[0]!;
  return { series: series.rows.length, byTenant: byTenant.rows.length, requests: Number(t.requests), errors: Number(t.errors), costMicros: Number(t.cost), p95: t.p95 ?? null };
}

const ms = (n: number) => (n < 10 ? n.toFixed(2) : n < 1000 ? n.toFixed(1) : n.toFixed(0));

/** summary.md: every figure is read from `results`. */
export function renderSummary(r: Results): string {
  const lines: string[] = ['# Dashboard query time vs log size', '', `Run ${r.startedAt} on ${r.cpus}, node ${r.node}, ${r.postgres}.`, ''];
  const queries = [...new Set(r.rows.map((x) => x.query))];
  for (const source of ['rollups', 'raw'] as const) {
    lines.push(`## ${source === 'rollups' ? 'On the rollups (what the dashboard runs)' : 'Same answer computed from the raw request log'}`, '', `Median (p95) milliseconds over the timed runs, after one warm-up.`, '');
    lines.push(`| query | ${r.sizes.map((s) => s.toLocaleString('en-US') + ' rows').join(' | ')} |`, `|---|${r.sizes.map(() => '---:').join('|')}|`);
    for (const q of queries) {
      const cells = r.sizes.map((s) => {
        const x = r.rows.find((y) => y.size === s && y.query === q && y.source === source);
        return x ? `${ms(x.timing.p50Ms)} (${ms(x.timing.p95Ms)})` : 'n/a';
      });
      if (cells.some((c) => c !== 'n/a')) lines.push(`| ${q} | ${cells.join(' | ')} |`);
    }
    lines.push('');
  }
  lines.push('## Rollup table sizes', '', '| log rows | rollup_minute rows | rollup_hour rows |', '|---:|---:|---:|');
  for (const x of r.rollupRows) lines.push(`| ${x.size.toLocaleString('en-US')} | ${x.rollupMinuteRows.toLocaleString('en-US')} | ${x.rollupHourRows.toLocaleString('en-US')} |`);
  lines.push('', '## Do the two ways agree?', '', '| log rows | range | requests (rollup / raw) | errors (rollup / raw) | spend micro-USD (rollup / raw) | p95 ms (rollup / raw) |', '|---:|---|---|---|---|---|');
  for (const a of r.agreement) {
    lines.push(`| ${a.size.toLocaleString('en-US')} | ${a.range} | ${a.rollup.requests} / ${a.raw.requests} | ${a.rollup.errors} / ${a.raw.errors} | ${a.rollup.costMicros} / ${a.raw.costMicros} | ${a.rollup.p95?.toFixed(1) ?? 'n/a'} / ${a.raw.p95?.toFixed(1) ?? 'n/a'} |`);
  }
  lines.push('', `Last-errors query uses the partial index: ${r.errorsUseIndex ? 'yes' : 'no'}.`, '');
  return lines.join('\n');
}

function flag(name: string, def: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : def;
}

async function main() {
  const sizes = flag('sizes', '10000,100000').split(',').map(Number);
  const reps = Number(flag('reps', '30'));
  const rawReps = Number(flag('raw-reps', '5'));
  const out = flag('out', 'bench/results/pr-11');
  const url = process.env.BENCH_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!url) throw new Error('set BENCH_DATABASE_URL or DATABASE_URL');
  const dbName = decodeURIComponent(new URL(url).pathname.slice(1));
  if (dbName !== process.env.TEST_DATABASE && !dbName.includes('bench')) {
    throw new Error(`refusing to truncate "${dbName}": the bench database must be TEST_DATABASE or have "bench" in its name`);
  }
  console.log(`bench database: ${dbName} (request_log and the rollup tables are truncated)`);
  if (sizes.some((s) => !Number.isInteger(s) || s <= 0)) throw new Error('--sizes needs positive integers');
  sizes.sort((a, b) => a - b);

  const handle = createDb({ databaseUrl: url, poolSize: 4 });
  const db = handle.db;
  const pool: pg.Pool = handle.pool;
  try {
    await pool.query('TRUNCATE request_log, rollup_minute, rollup_hour, rollup_total_minute, rollup_total_hour');
    await pool.query("UPDATE rollup_state SET folded_through = 'epoch' WHERE id = 1");
    const tenantIds = await ensureTenants(db, 'bench-');
    const now = new Date();
    // The fold mark where a running worker would have it, so history goes to the hour tables as it would have from the start
    // (otherwise the first load would write every minute of 30 days and fold it afterwards).
    await foldRollups(db, now, 90);
    const window = { from: now.getTime() - 30 * 24 * 3_600_000, to: now.getTime() - 5 * 60_000 };

    const results: Results = {
      startedAt: now.toISOString(), node: process.version, postgres: ((await pool.query('SHOW server_version')).rows[0] as { server_version: string }).server_version.replace(/^/, 'PostgreSQL '),
      cpus: `${os.cpus()[0]?.model ?? 'cpu'} x${os.cpus().length}`, loadAvgAtStart: os.loadavg(), sizes, rollupRows: [], rows: [], agreement: [], errorsUseIndex: false,
    };

    let have = 0;
    for (const size of sizes) {
      const t0 = performance.now();
      await seed(db, { tenantIds, window, fromRow: have, toRow: size, now, onProgress: (n) => n % 100_000 < 2000 && console.log(`  seeded ${have + n} rows`) });
      have = size;
      await pool.query('VACUUM ANALYZE request_log, rollup_minute, rollup_hour, rollup_total_minute, rollup_total_hour, rollup_state');
      const count = (await pool.query('SELECT (SELECT count(*) FROM request_log)::int AS log, (SELECT count(*) FROM rollup_minute)::int AS m, (SELECT count(*) FROM rollup_hour)::int AS h')).rows[0] as { log: number; m: number; h: number };
      if (count.log !== size) throw new Error(`expected ${size} log rows, found ${count.log}`);
      results.rollupRows.push({ size, rollupMinuteRows: count.m, rollupHourRows: count.h });
      console.log(`size ${size}: seeded in ${((performance.now() - t0) / 1000).toFixed(1)}s; rollup rows ${count.m} minute, ${count.h} hour`);

      for (const range of RANGE_KEYS) {
        results.rows.push({ size, query: `overview ${range}`, source: 'rollups', timing: await timeIt(reps, () => overview(pool, range, now)) });
        results.rows.push({ size, query: `overview ${range}`, source: 'raw', timing: await timeIt(rawReps, () => rawOverview(pool, range, now)) });
        const [fast, slow] = [await overview(pool, range, now), await rawOverview(pool, range, now)];
        results.agreement.push({
          size, range,
          rollup: { requests: fast.totals.requests, errors: fast.totals.errors, costMicros: fast.totals.costMicros, p95: fast.totals.p95 },
          raw: { requests: slow.requests, errors: slow.errors, costMicros: slow.costMicros, p95: slow.p95 },
        });
      }
      results.rows.push({ size, query: 'last 50 errors', source: 'rollups', timing: await timeIt(reps, () => lastErrors(pool, 50)) });
      const plan = (await pool.query("EXPLAIN SELECT l.request_id FROM request_log l WHERE l.status >= 500 OR l.error_code = 'upstream_stream_broken' ORDER BY l.created_at DESC NULLS LAST LIMIT 50")).rows.map((x: { 'QUERY PLAN': string }) => x['QUERY PLAN']).join('\n');
      results.errorsUseIndex = plan.includes('request_log_errors_recent');
    }

    mkdirSync(out, { recursive: true });
    writeFileSync(join(out, 'results.json'), JSON.stringify(results, null, 2) + '\n');
    writeFileSync(join(out, 'summary.md'), renderSummary(results));
    console.log(`wrote ${join(out, 'summary.md')}`);
  } finally {
    await handle.close();
  }
}

if (import.meta.main) await main();
