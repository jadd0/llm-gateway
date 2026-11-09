import { merge, percentile } from './histogram.ts';
import { tenantLabel } from './tenants.ts';

// Everything the overview page shows. Reads rollup tables only, plus the newest failures from the request log
// (through the partial index on its error rows). Each function takes a `now`, so a test fixes the clock.

/** The minimal slice of a pg Pool or Client these queries need. */
export interface Queryable {
  query<R = Record<string, unknown>>(text: string, params?: unknown[]): Promise<{ rows: R[] }>;
}

const MIN = 60_000;
const HOUR = 3_600_000;

export const RANGES = {
  '1h': { label: 'Last hour', ms: HOUR, stepMs: MIN, minute: true },
  '24h': { label: 'Last 24 hours', ms: 24 * HOUR, stepMs: 15 * MIN, minute: true },
  '7d': { label: 'Last 7 days', ms: 7 * 24 * HOUR, stepMs: HOUR, minute: false },
  '30d': { label: 'Last 30 days', ms: 30 * 24 * HOUR, stepMs: 6 * HOUR, minute: false },
} as const;
export type RangeKey = keyof typeof RANGES;
export const RANGE_KEYS = Object.keys(RANGES) as RangeKey[];
export const DEFAULT_RANGE: RangeKey = '24h';
export const isRangeKey = (v: unknown): v is RangeKey => typeof v === 'string' && Object.hasOwn(RANGES, v);

export interface Point {
  /** Start of the step, unix ms. */
  t: number;
  requests: number;
  errors: number;
  /** errors / requests, 0..1 (null when there were no requests). */
  errorRate: number | null;
  /** (exact + semantic hits) / requests, 0..1. */
  cacheHitRate: number | null;
  p50: number | null;
  p95: number | null;
}

export interface Totals {
  requests: number;
  errors: number;
  errorRate: number | null;
  cacheHitRate: number | null;
  costMicros: number;
  savedMicros: number;
  promptTokens: number;
  completionTokens: number;
  p50: number | null;
  p95: number | null;
}

export interface TenantSpend {
  tenantId: string;
  /** What to show: the tenant's name, "Unauthenticated", or "Deleted tenant <id>" (see tenantLabel). */
  name: string;
  requests: number;
  costMicros: number;
}

export interface ErrorRow {
  requestId: string;
  at: Date;
  tenant: string;
  model: string | null;
  status: number;
  errorCode: string | null;
  latencyMs: number;
}

/**
 * The window a range covers, ending at `now`. It starts on a boundary of the range's own step (a minute, 15 minutes,
 * an hour, 6 hours, counted from midnight UTC), so the first point of a series covers a whole step instead of a partial one,
 * and no rollup bucket is half-counted.
 */
export function windowOf(range: RangeKey, now: Date): { from: Date; to: Date } {
  const { ms, stepMs } = RANGES[range];
  return { from: new Date(Math.floor((now.getTime() - ms) / stepMs) * stepMs), to: now };
}

// The rows a range is summed from. Up to 24 hours: the minute table. Longer: the hour table, plus the minutes
// that have not been folded into it yet (at or after the fold mark), so no request is in both or neither.
// `total` tables hold one row per bucket across all tenants and models (series and percentiles); the others hold a
// row per tenant and model (spend by tenant).
function source(range: RangeKey, kind: 'total' | 'tenant'): string {
  const [minute, hour] = kind === 'total' ? ['rollup_total_minute', 'rollup_total_hour'] : ['rollup_minute', 'rollup_hour'];
  const cols = kind === 'total'
    ? 'bucket, requests, errors, cache_hits, semantic_hits, cost_micros, saved_micros, prompt_tokens, completion_tokens, latency_hist'
    : 'bucket, tenant_id, requests, cost_micros';
  if (RANGES[range].minute) {
    return `SELECT ${cols} FROM ${minute} WHERE bucket >= $1 AND bucket < $2`;
  }
  return `SELECT ${cols} FROM ${hour} WHERE bucket >= $1 AND bucket < $2
          UNION ALL
          SELECT ${cols} FROM ${minute} WHERE bucket >= greatest($1::timestamptz, (SELECT folded_through FROM rollup_state WHERE id = 1)) AND bucket < $2`;
}

const num = (v: unknown): number => Number(v ?? 0);
const ratio = (n: number, d: number): number | null => (d === 0 ? null : n / d);

interface SeriesRow {
  t: Date;
  requests: string;
  errors: string;
  hits: string;
  cost: string;
  saved: string;
  prompt: string;
  completion: string;
  hist: number[];
}

export interface Overview {
  range: RangeKey;
  from: Date;
  to: Date;
  stepMs: number;
  series: Point[];
  totals: Totals;
  byTenant: TenantSpend[];
}

/** Per-step series, totals and spend by tenant for a range, from the rollups. */
export async function overview(db: Queryable, range: RangeKey, now: Date): Promise<Overview> {
  const { from, to } = windowOf(range, now);
  const stepMs = RANGES[range].stepMs;
  const params = [from.toISOString(), to.toISOString()];

  const stepsQ = db.query<SeriesRow>(
    `WITH src AS (${source(range, 'total')})
     SELECT to_timestamp(floor(extract(epoch FROM bucket) * 1000 / ${stepMs}) * ${stepMs} / 1000.0) AS t,
            sum(requests) AS requests, sum(errors) AS errors, sum(cache_hits + semantic_hits) AS hits,
            sum(cost_micros) AS cost, sum(saved_micros) AS saved, sum(prompt_tokens) AS prompt, sum(completion_tokens) AS completion,
            hist_sum(latency_hist) AS hist
     FROM src GROUP BY 1 ORDER BY 1`,
    params,
  );

  const tenantsQ = db.query<{ tenant_id: string; name: string | null; requests: string; cost: string }>(
    `WITH src AS (${source(range, 'tenant')})
     SELECT s.tenant_id, t.name, s.requests, s.cost
     FROM (SELECT tenant_id, sum(requests) AS requests, sum(cost_micros) AS cost FROM src GROUP BY tenant_id) s
     LEFT JOIN tenants t ON t.id = s.tenant_id
     ORDER BY s.cost DESC, s.requests DESC, s.tenant_id`,
    params,
  );
  // The two reads are independent: run them together.
  const [steps, tenants] = await Promise.all([stepsQ, tenantsQ]);

  // Percentiles come from merged histograms, per step and for the whole range, never from averaging step percentiles.
  const series: Point[] = steps.rows.map((r) => {
    const requests = num(r.requests);
    return {
      t: new Date(r.t).getTime(), requests, errors: num(r.errors), errorRate: ratio(num(r.errors), requests),
      cacheHitRate: ratio(num(r.hits), requests), p50: percentile(r.hist, 0.5), p95: percentile(r.hist, 0.95),
    };
  });
  let hist: number[] = [];
  const totals: Totals = { requests: 0, errors: 0, errorRate: null, cacheHitRate: null, costMicros: 0, savedMicros: 0, promptTokens: 0, completionTokens: 0, p50: null, p95: null };
  let hits = 0;
  for (const r of steps.rows) {
    totals.requests += num(r.requests);
    totals.errors += num(r.errors);
    hits += num(r.hits);
    totals.costMicros += num(r.cost);
    totals.savedMicros += num(r.saved);
    totals.promptTokens += num(r.prompt);
    totals.completionTokens += num(r.completion);
    hist = merge(hist, r.hist);
  }
  totals.errorRate = ratio(totals.errors, totals.requests);
  totals.cacheHitRate = ratio(hits, totals.requests);
  totals.p50 = percentile(hist, 0.5);
  totals.p95 = percentile(hist, 0.95);

  const byTenant = tenants.rows.map((r) => ({ tenantId: r.tenant_id, name: tenantLabel(r.tenant_id, r.name), requests: num(r.requests), costMicros: num(r.cost) }));

  return { range, from, to, stepMs, series, totals, byTenant };
}

/** The newest failures, metadata only: no key, no content, no cost. Reads the request log through its partial index on error rows. */
export async function lastErrors(db: Queryable, limit = 50): Promise<ErrorRow[]> {
  const r = await db.query<{ request_id: string; created_at: Date; tenant_id: string | null; name: string | null; model: string | null; status: number; error_code: string | null; latency_ms: number }>(
    `SELECT l.request_id, l.created_at, l.tenant_id, t.name, l.model, l.status, l.error_code, l.latency_ms
     FROM request_log l LEFT JOIN tenants t ON t.id = l.tenant_id
     WHERE l.status >= 500 OR l.error_code = 'upstream_stream_broken'
     ORDER BY l.created_at DESC NULLS LAST
     LIMIT $1`,
    [limit],
  );
  return r.rows.map((x) => ({ requestId: x.request_id, at: new Date(x.created_at), tenant: tenantLabel(x.tenant_id, x.name), model: x.model, status: x.status, errorCode: x.error_code, latencyMs: x.latency_ms }));
}
