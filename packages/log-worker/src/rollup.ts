import { sql } from 'drizzle-orm';
import type { Db } from '../../gateway/src/db/client.ts';
import { NO_TENANT, isError, rollupHour, rollupMinute } from '../../gateway/src/db/schema.ts';
import type { LogEntry } from '../../gateway/src/requestlog/entry.ts';
import { bucketOf } from './histogram.ts';

export type Tx = Parameters<Parameters<Db['db']['transaction']>[0]>[0];

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
const floorTo = (ms: number, step: number) => Math.floor(ms / step) * step;

/** One rollup row: the counts of every request in one (time bucket, tenant, model). */
export interface RollupRow {
  bucket: Date;
  tenantId: string;
  model: string;
  requests: number;
  errors: number;
  cacheHits: number;
  semanticHits: number;
  costMicros: number;
  savedMicros: number;
  promptTokens: number;
  completionTokens: number;
  latencyHist: number[];
}

const tenantOf = (e: LogEntry) => e.tenantId ?? NO_TENANT;
// The model that served the request: that is what the cost belongs to. A refusal never reached one, so it has the asked-for name.
const modelOf = (e: LogEntry) => e.servedModel ?? e.model ?? '';

/**
 * Sums entries by (bucket, tenant, model). `bucketMs` maps a request's start to the start of its bucket.
 * Every entry here is a row that was really inserted: the caller never passes a redelivery.
 */
export function aggregate(entries: readonly LogEntry[], bucketMs: (startedAt: number) => number): RollupRow[] {
  const rows = new Map<string, RollupRow>();
  for (const e of entries) {
    const b = bucketMs(e.startedAt);
    const key = `${b}|${tenantOf(e)}|${modelOf(e)}`;
    let r = rows.get(key);
    if (!r) {
      r = { bucket: new Date(b), tenantId: tenantOf(e), model: modelOf(e), requests: 0, errors: 0, cacheHits: 0, semanticHits: 0, costMicros: 0, savedMicros: 0, promptTokens: 0, completionTokens: 0, latencyHist: [] };
      rows.set(key, r);
    }
    r.requests++;
    if (isError(e.status, e.errorCode)) r.errors++;
    if (e.cache === 'hit') r.cacheHits++;
    if (e.cache === 'semantic-hit') r.semanticHits++;
    r.costMicros += e.costMicros;
    r.savedMicros += e.savedMicros;
    r.promptTokens += e.promptTokens ?? 0;
    r.completionTokens += e.completionTokens ?? 0;
    const i = bucketOf(e.latencyMs);
    while (r.latencyHist.length <= i) r.latencyHist.push(0);
    r.latencyHist[i]!++;
  }
  // A fixed order, so two workers writing overlapping buckets lock rows in the same sequence and cannot deadlock.
  return [...rows.values()].sort((a, b) => a.bucket.getTime() - b.bucket.getTime() || (a.tenantId < b.tenantId ? -1 : a.tenantId > b.tenantId ? 1 : 0) || (a.model < b.model ? -1 : a.model > b.model ? 1 : 0));
}

const CHUNK = 1000;

// Adds rows to a rollup table: a bucket that exists grows by the new counts (histograms merged bucket by bucket).
async function upsert(tx: Tx, table: typeof rollupMinute | typeof rollupHour, rows: RollupRow[]): Promise<void> {
  for (let i = 0; i < rows.length; i += CHUNK) {
    await tx
      .insert(table)
      .values(rows.slice(i, i + CHUNK))
      .onConflictDoUpdate({
        target: [table.bucket, table.tenantId, table.model],
        set: {
          requests: sql`${table.requests} + excluded.requests`,
          errors: sql`${table.errors} + excluded.errors`,
          cacheHits: sql`${table.cacheHits} + excluded.cache_hits`,
          semanticHits: sql`${table.semanticHits} + excluded.semantic_hits`,
          costMicros: sql`${table.costMicros} + excluded.cost_micros`,
          savedMicros: sql`${table.savedMicros} + excluded.saved_micros`,
          promptTokens: sql`${table.promptTokens} + excluded.prompt_tokens`,
          completionTokens: sql`${table.completionTokens} + excluded.completion_tokens`,
          latencyHist: sql`hist_add(${table.latencyHist}, excluded.latency_hist)`,
        },
      });
  }
}

/**
 * Adds a batch's rows to the rollups, inside the transaction that inserted them. The entries must be only the
 * rows that insert actually wrote (a redelivered entry inserted nothing, so it adds nothing here either).
 *
 * A minute older than the fold mark has already been moved to the hour table and is not written to the minute
 * table again: its row goes to the hour directly. The mark is read under a shared lock that the fold's update
 * must wait for, so a request is counted in exactly one table whatever the order.
 */
export async function writeRollups(tx: Tx, entries: readonly LogEntry[]): Promise<void> {
  if (entries.length === 0) return;
  const state = await tx.execute<{ mark: number }>(sql`SELECT (extract(epoch FROM folded_through) * 1000)::float8 AS mark FROM rollup_state WHERE id = 1 FOR SHARE`);
  const mark = state.rows[0]?.mark;
  if (mark === undefined) throw new Error('rollup_state has no row');
  const recent = entries.filter((e) => floorTo(e.startedAt, MINUTE_MS) >= mark);
  const late = entries.filter((e) => floorTo(e.startedAt, MINUTE_MS) < mark);
  await upsert(tx, rollupMinute, aggregate(recent, (t) => floorTo(t, MINUTE_MS)));
  await upsert(tx, rollupHour, aggregate(late, (t) => floorTo(t, HOUR_MS)));
}

export interface FoldOptions {
  /** An hour is folded once it ended this long ago (minutes). */
  foldAfterMin: number;
  /** Folded minute rows are deleted once they are this old (hours). */
  minuteRetentionH: number;
}

/**
 * Moves every whole hour that ended `foldAfterMin` ago from the minute table into the hour table, and advances
 * the fold mark. One transaction under the mark's row lock: a batch either finished before it (its minutes are
 * folded) or starts after it (its late rows go to the hour table), never both. Returns the new mark.
 */
export async function foldRollups(db: Db['db'], now: Date, foldAfterMin: number): Promise<Date> {
  const horizon = floorTo(now.getTime() - foldAfterMin * MINUTE_MS, HOUR_MS);
  return db.transaction(async (tx) => {
    const state = await tx.execute<{ mark: number }>(sql`SELECT (extract(epoch FROM folded_through) * 1000)::float8 AS mark FROM rollup_state WHERE id = 1 FOR UPDATE`);
    const mark = state.rows[0]?.mark;
    if (mark === undefined) throw new Error('rollup_state has no row');
    if (horizon <= mark) return new Date(mark);
    const from = new Date(mark).toISOString();
    const to = new Date(horizon).toISOString();
    await tx.execute(sql`
      INSERT INTO rollup_hour AS h (bucket, tenant_id, model, requests, errors, cache_hits, semantic_hits, cost_micros, saved_micros,
                                    prompt_tokens, completion_tokens, latency_hist)
      SELECT date_trunc('hour', bucket, 'UTC'), tenant_id, model, sum(requests), sum(errors), sum(cache_hits), sum(semantic_hits),
             sum(cost_micros), sum(saved_micros), sum(prompt_tokens), sum(completion_tokens), hist_sum(latency_hist)
      FROM rollup_minute
      WHERE bucket >= ${from}::timestamptz AND bucket < ${to}::timestamptz
      GROUP BY 1, 2, 3
      ORDER BY 1, 2, 3
      ON CONFLICT (bucket, tenant_id, model) DO UPDATE SET
        requests = h.requests + excluded.requests, errors = h.errors + excluded.errors,
        cache_hits = h.cache_hits + excluded.cache_hits, semantic_hits = h.semantic_hits + excluded.semantic_hits,
        cost_micros = h.cost_micros + excluded.cost_micros, saved_micros = h.saved_micros + excluded.saved_micros,
        prompt_tokens = h.prompt_tokens + excluded.prompt_tokens, completion_tokens = h.completion_tokens + excluded.completion_tokens,
        latency_hist = hist_add(h.latency_hist, excluded.latency_hist)`);
    await tx.execute(sql`UPDATE rollup_state SET folded_through = ${to}::timestamptz WHERE id = 1`);
    return new Date(horizon);
  });
}

/** Deletes minute rows older than the retention that have already been folded. Returns how many. */
export async function deleteOldMinutes(db: Db['db'], now: Date, minuteRetentionH: number): Promise<number> {
  const cutoff = new Date(floorTo(now.getTime() - minuteRetentionH * HOUR_MS, HOUR_MS)).toISOString();
  // LEAST with the fold mark: an unfolded minute is never deleted, however old, and the mark only moves forward.
  const r = await db.execute(sql`
    DELETE FROM rollup_minute
    WHERE bucket < LEAST(${cutoff}::timestamptz, (SELECT folded_through FROM rollup_state WHERE id = 1))`);
  return r.rowCount ?? 0;
}

/** The periodic job: fold, then trim. Each step is its own transaction, so a failure in the trim leaves the fold done. */
export async function maintainRollups(db: Db['db'], now: Date, o: FoldOptions): Promise<{ foldedThrough: Date; deleted: number }> {
  const foldedThrough = await foldRollups(db, now, o.foldAfterMin);
  const deleted = await deleteOldMinutes(db, now, o.minuteRetentionH);
  return { foldedThrough, deleted };
}
