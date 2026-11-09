// Synthetic request-log traffic for the dashboard: 20 tenants, 6 models, a day/night shape, 2% errors, 30% cache hits,
// log-normal latencies. Row i is a pure function of (seed, i), so a bigger run is the smaller one plus more rows, and the
// same seed always gives the same log. Rows go through the log worker's own batch code (applyBatch), so the rollups are
// whatever the worker would have written, not a second implementation.
import { inArray, like } from 'drizzle-orm';
import { applyBatch } from '../../packages/log-worker/src/batch.ts';
import { maintainRollups } from '../../packages/log-worker/src/rollup.ts';
import { createTenant } from '../../packages/gateway/src/cli/keys.ts';
import type { Db } from '../../packages/gateway/src/db/client.ts';
import { tenants } from '../../packages/gateway/src/db/schema.ts';
import { toLogFields, type LogEntry } from '../../packages/gateway/src/requestlog/entry.ts';

export const MODELS = ['gpt-6-astra', 'gpt-6-mini', 'claude-fable-5-1', 'claude-haiku-5', 'gemini-4-pro', 'mock-ok'] as const;
export const TENANT_COUNT = 20;
const HOUR = 3_600_000;

// 32-bit hash to a number in [0, 1): row-local randomness without a shared stream.
function mulberry32(a: number) {
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface SeedWindow {
  /** First instant requests may start at. */
  from: number;
  /** Last instant (exclusive). */
  to: number;
}

// Traffic is heavier in the UTC afternoon than at night: a sine over the day, never below 35% of the peak.
const dayWeight = (t: number) => 0.35 + 0.65 * (0.5 + 0.5 * Math.sin(((t % (24 * HOUR)) / (24 * HOUR)) * 2 * Math.PI - Math.PI / 2));

/** Request number `i` of the synthetic log. `tenantIds` are the 20 tenants, in a fixed order. */
export function entryAt(i: number, tenantIds: readonly string[], w: SeedWindow, seed = 1): LogEntry {
  const rand = mulberry32((seed * 0x9e3779b1) ^ Math.imul(i + 1, 0x85ebca6b));
  let t = w.from + rand() * (w.to - w.from);
  for (let k = 0; k < 8 && rand() > dayWeight(t); k++) t = w.from + rand() * (w.to - w.from);
  const tenant = tenantIds[Math.min(tenantIds.length - 1, Math.floor(rand() ** 1.6 * tenantIds.length))]!; // a few big tenants, a long tail
  const model = MODELS[Math.floor(rand() * MODELS.length)]!;
  const failed = rand() < 0.02;
  const cache = failed ? 'miss' : rand() < 0.3 ? 'hit' : 'miss';
  const prompt = 20 + Math.floor(rand() * 1500);
  const completion = failed ? 0 : 10 + Math.floor(rand() * 600);
  const z = Math.sqrt(-2 * Math.log(Math.max(rand(), 1e-12))) * Math.cos(2 * Math.PI * rand());
  const latency = cache === 'hit' ? 2 + Math.floor(rand() * 8) : Math.min(110_000, Math.max(30, Math.round(900 * Math.exp(0.8 * z) * (failed ? 3 : 1))));
  const hex = (n: number, width: number) => n.toString(16).padStart(width, '0');
  return {
    // A uuid built from the seed and the row number, so a redelivery of row i is the same request id and two seeds never share one.
    requestId: `${hex(seed, 8)}-0000-4000-8000-${hex(i, 12)}`,
    startedAt: Math.floor(t), tenantId: tenant, keyId: null, model, servedModel: model, provider: 'mock', status: failed ? (rand() < 0.5 ? 502 : 503) : 200,
    errorCode: failed ? 'upstream_error' : null, stream: false, promptTokens: prompt, completionTokens: completion,
    costMicros: cache === 'hit' || failed ? 0 : Math.round(prompt * 3 + completion * 15), savedMicros: cache === 'hit' ? Math.round(prompt * 3 + completion * 15) : 0,
    cache, attempts: 1, fallbackUsed: false, latencyMs: latency, ttfbMs: null, upstreamMs: null,
  };
}

/** The 20 tenants named `<prefix>01`..`<prefix>20`, created when missing. Returns their ids in name order. */
export async function ensureTenants(db: Db['db'], prefix: string): Promise<string[]> {
  const names = Array.from({ length: TENANT_COUNT }, (_, k) => `${prefix}${String(k + 1).padStart(2, '0')}`);
  const have = new Map((await db.select({ id: tenants.id, name: tenants.name }).from(tenants).where(like(tenants.name, `${prefix}%`))).map((r) => [r.name, r.id]));
  for (const n of names) if (!have.has(n)) have.set(n, (await createTenant(db, n)).id);
  return names.map((n) => have.get(n)!);
}

export interface SeedOptions {
  tenantIds: readonly string[];
  window: SeedWindow;
  /** Rows [fromRow, toRow) of the synthetic log. */
  fromRow: number;
  toRow: number;
  seed?: number;
  /** Rows per transaction. */
  batch?: number;
  /** The clock the fold and trim read. */
  now: Date;
  foldAfterMin?: number;
  minuteRetentionH?: number;
  onProgress?: (done: number) => void;
}

/** Writes the rows through the worker's batch code, then folds and trims the way the worker's timer would. Returns rows inserted. */
export async function seed(db: Db['db'], o: SeedOptions): Promise<number> {
  const size = o.batch ?? 2000;
  let inserted = 0;
  for (let i = o.fromRow; i < o.toRow; i += size) {
    const raws = [];
    for (let j = i; j < Math.min(i + size, o.toRow); j++) raws.push({ id: `${j}-0`, fields: toLogFields(entryAt(j, o.tenantIds, o.window, o.seed)), stream: 'bench' });
    const r = await applyBatch(db, raws);
    if (r.failed.length > 0 || r.malformed.length > 0) throw new Error(`seed batch at row ${i} failed (${r.failed[0]?.errClass ?? r.malformed[0]?.errClass})`);
    inserted += r.logRows;
    o.onProgress?.(inserted);
  }
  await maintainRollups(db, o.now, { foldAfterMin: o.foldAfterMin ?? 90, minuteRetentionH: o.minuteRetentionH ?? 48 });
  return inserted;
}

/** Removes a seeded run's tenants' log and rollup rows (used by tests; the bench itself truncates its own database). */
export async function forget(db: Db['db'], tenantIds: string[]): Promise<void> {
  if (tenantIds.length === 0) return;
  await db.$client.query('DELETE FROM rollup_minute WHERE tenant_id = ANY($1)', [tenantIds]);
  await db.$client.query('DELETE FROM rollup_hour WHERE tenant_id = ANY($1)', [tenantIds]);
  await db.$client.query('DELETE FROM request_log WHERE tenant_id = ANY($1)', [tenantIds]);
  await db.delete(tenants).where(inArray(tenants.id, tenantIds));
}
