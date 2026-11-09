import { sql } from 'drizzle-orm';
import type { Db } from '../../gateway/src/db/client.ts';
import { NO_TENANT, isError, rollupHour, rollupMinute, rollupTotalHour, rollupTotalMinute } from '../../gateway/src/db/schema.ts';
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
 * Sums entries by (bucket, tenant, model), or by bucket alone when `dims` is false (then tenantId and model are
 * empty). `bucketMs` maps a request's start to the start of its bucket. Every entry here is a row that was really
 * inserted: the caller never passes a redelivery.
 */
export function aggregate(entries: readonly LogEntry[], bucketMs: (startedAt: number) => number, dims = true): RollupRow[] {
  const rows = new Map<string, RollupRow>();
  for (const e of entries) {
    const b = bucketMs(e.startedAt);
    const tenantId = dims ? tenantOf(e) : '';
    const model = dims ? modelOf(e) : '';
    const key = `${b}|${tenantId}|${model}`;
    let r = rows.get(key);
    if (!r) {
      r = { bucket: new Date(b), tenantId, model, requests: 0, errors: 0, cacheHits: 0, semanticHits: 0, costMicros: 0, savedMicros: 0, promptTokens: 0, completionTokens: 0, latencyHist: [] };
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

type DimTable = typeof rollupMinute | typeof rollupHour;
type TotalTable = typeof rollupTotalMinute | typeof rollupTotalHour;

// What adds to an existing bucket: counts grow by the new counts, histograms merge bucket by bucket.
const grow = (t: DimTable | TotalTable) => ({
  requests: sql`${t.requests} + excluded.requests`,
  errors: sql`${t.errors} + excluded.errors`,
  cacheHits: sql`${t.cacheHits} + excluded.cache_hits`,
  semanticHits: sql`${t.semanticHits} + excluded.semantic_hits`,
  costMicros: sql`${t.costMicros} + excluded.cost_micros`,
  savedMicros: sql`${t.savedMicros} + excluded.saved_micros`,
  promptTokens: sql`${t.promptTokens} + excluded.prompt_tokens`,
  completionTokens: sql`${t.completionTokens} + excluded.completion_tokens`,
  latencyHist: sql`hist_add(${t.latencyHist}, excluded.latency_hist)`,
});

async function upsertDims(tx: Tx, table: DimTable, rows: RollupRow[]): Promise<void> {
  for (let i = 0; i < rows.length; i += CHUNK) {
    await tx.insert(table).values(rows.slice(i, i + CHUNK)).onConflictDoUpdate({ target: [table.bucket, table.tenantId, table.model], set: grow(table) });
  }
}

async function upsertTotals(tx: Tx, table: TotalTable, rows: RollupRow[]): Promise<void> {
  for (let i = 0; i < rows.length; i += CHUNK) {
    const values = rows.slice(i, i + CHUNK).map(({ tenantId: _t, model: _m, ...measures }) => measures);
    await tx.insert(table).values(values).onConflictDoUpdate({ target: [table.bucket], set: grow(table) });
  }
}

// A late row is also kept at minute grain while it falls within the day the minute-grain views reach back over
// (counted from the fold mark, which trails the clock by 90 minutes or more). Older than this it goes to the hour tables only.
const LATE_MINUTE_KEEP_MS = 24 * HOUR_MS;

/**
 * Adds a batch's rows to the rollups, inside the transaction that inserted them. The entries must be only the
 * rows that insert actually wrote (a redelivered entry inserted nothing, so it adds nothing here either).
 *
 * A minute older than the fold mark has already been moved to the hour tables, so a row for it is added to the
 * hour tables directly; it is also written to the minute tables when recent enough to be shown there. The fold
 * reads only minutes at or after the mark, so that copy is never folded again. The mark is read under a shared
 * lock that the fold's update must wait for, so the hour tables count a request exactly once whatever the order.
 */
export async function writeRollups(tx: Tx, entries: readonly LogEntry[]): Promise<void> {
  if (entries.length === 0) return;
  const state = await tx.execute<{ mark: number }>(sql`SELECT (extract(epoch FROM folded_through) * 1000)::float8 AS mark FROM rollup_state WHERE id = 1 FOR SHARE`);
  const mark = state.rows[0]?.mark;
  if (mark === undefined) throw new Error('rollup_state has no row');
  const minuteOf = (t: number) => floorTo(t, MINUTE_MS);
  const hourOf = (t: number) => floorTo(t, HOUR_MS);
  const late = entries.filter((e) => minuteOf(e.startedAt) < mark);
  const inMinutes = entries.filter((e) => minuteOf(e.startedAt) >= mark - LATE_MINUTE_KEEP_MS);
  await upsertDims(tx, rollupMinute, aggregate(inMinutes, minuteOf));
  await upsertTotals(tx, rollupTotalMinute, aggregate(inMinutes, minuteOf, false));
  await upsertDims(tx, rollupHour, aggregate(late, hourOf));
  await upsertTotals(tx, rollupTotalHour, aggregate(late, hourOf, false));
}

export interface FoldOptions {
  /** An hour is folded once it ended this long ago (minutes). */
  foldAfterMin: number;
  /** Folded minute rows are deleted once they are this old (hours). */
  minuteRetentionH: number;
}

// Sums the minute rows in [from, to) by hour (and by the dimension columns, if any) and adds them to the hour table.
// Table and column names are fixed strings from this file, never input.
async function foldInto(tx: Tx, minute: string, hour: string, dims: string[], from: string, to: string): Promise<void> {
  const keys = ['bucket', ...dims];
  const group = keys.map((_, i) => i + 1).join(', ');
  const cols = [...keys, 'requests', 'errors', 'cache_hits', 'semantic_hits', 'cost_micros', 'saved_micros', 'prompt_tokens', 'completion_tokens', 'latency_hist'];
  const sums = ['requests', 'errors', 'cache_hits', 'semantic_hits', 'cost_micros', 'saved_micros', 'prompt_tokens', 'completion_tokens'];
  await tx.execute(sql.raw(`
    INSERT INTO ${hour} AS h (${cols.join(', ')})
    SELECT date_trunc('hour', bucket, 'UTC')${dims.map((d) => `, ${d}`).join('')}, ${sums.map((c) => `sum(${c})`).join(', ')}, hist_sum(latency_hist)
    FROM ${minute}
    WHERE bucket >= '${from}'::timestamptz AND bucket < '${to}'::timestamptz
    GROUP BY ${group}
    ORDER BY ${group}
    ON CONFLICT (${keys.join(', ')}) DO UPDATE SET
      ${sums.map((c) => `${c} = h.${c} + excluded.${c}`).join(',\n      ')},
      latency_hist = hist_add(h.latency_hist, excluded.latency_hist)`));
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
    await foldInto(tx, 'rollup_minute', 'rollup_hour', ['tenant_id', 'model'], from, to);
    await foldInto(tx, 'rollup_total_minute', 'rollup_total_hour', [], from, to);
    await tx.execute(sql`UPDATE rollup_state SET folded_through = ${to}::timestamptz WHERE id = 1`);
    return new Date(horizon);
  });
}

/** Deletes minute rows older than the retention that have already been folded. Returns how many (dimension rows). */
export async function deleteOldMinutes(db: Db['db'], now: Date, minuteRetentionH: number): Promise<number> {
  const cutoff = new Date(floorTo(now.getTime() - minuteRetentionH * HOUR_MS, HOUR_MS)).toISOString();
  // LEAST with the fold mark: an unfolded minute is never deleted, however old, and the mark only moves forward.
  const where = sql`bucket < LEAST(${cutoff}::timestamptz, (SELECT folded_through FROM rollup_state WHERE id = 1))`;
  const r = await db.execute(sql`DELETE FROM rollup_minute WHERE ${where}`);
  await db.execute(sql`DELETE FROM rollup_total_minute WHERE ${where}`);
  return r.rowCount ?? 0;
}

/** The periodic job: fold, then trim. Each step is its own transaction, so a failure in the trim leaves the fold done. */
export async function maintainRollups(db: Db['db'], now: Date, o: FoldOptions): Promise<{ foldedThrough: Date; deleted: number }> {
  const foldedThrough = await foldRollups(db, now, o.foldAfterMin);
  const deleted = await deleteOldMinutes(db, now, o.minuteRetentionH);
  return { foldedThrough, deleted };
}
