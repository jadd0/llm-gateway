import { randomBytes, randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createDb, type Db } from '../../gateway/src/db/client.ts';
import { NO_TENANT } from '../../gateway/src/db/schema.ts';
import { streamKey, toLogFields, type LogEntry } from '../../gateway/src/requestlog/entry.ts';
import { lockRollupState, testConfig } from '../../gateway/src/test-env.ts';
import { applyBatch } from './batch.ts';
import { histogramOf } from './histogram.ts';
import { createWorker } from './worker.ts';
import { aggregate, deleteOldMinutes, foldRollups, maintainRollups } from './rollup.ts';

// A real Postgres. Every row a test writes carries a model name unique to the test, so the assertions look at
// those rows only; the fold mark is global, so each test puts it back to the start and the file restores it.
const handle: Db = createDb({ databaseUrl: testConfig().databaseUrl, poolSize: 4 });
const db = handle.db;
const run = randomBytes(4).toString('hex');
let testN = 0;
let model = '';
let originalMark = '';
let unlock: () => Promise<void>;

// One injected clock for the whole file.
const NOW = new Date('2031-03-01T12:30:00Z');
const WINDOW_FROM = '2031-01-01T00:00:00Z';
const WINDOW_TO = '2031-04-01T00:00:00Z';
const MIN = 60_000;
const HOUR = 3_600_000;

function lcg(seed: number) {
  let s = seed;
  return () => (s = (s * 1664525 + 1013904223) % 4294967296) / 4294967296;
}

const tenants = [randomUUID(), randomUUID(), randomUUID(), null];

function entries(n: number, from: Date, to: Date, seed = 1): LogEntry[] {
  const rand = lcg(seed);
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)]!;
  return Array.from({ length: n }, (_, i): LogEntry => {
    const r = rand();
    const status = r < 0.05 ? 500 : r < 0.08 ? 429 : r < 0.1 ? 499 : 200;
    const slow = rand() < 0.1;
    return {
      requestId: randomUUID(), startedAt: from.getTime() + Math.floor(rand() * (to.getTime() - from.getTime())),
      tenantId: pick(tenants), keyId: null, model: `${model}-${pick(['a', 'b'])}`,
      servedModel: i % 17 === 0 ? null : `${model}-${pick(['a', 'b'])}`, provider: 'mock',
      status, errorCode: status === 499 ? 'client_closed' : i % 23 === 0 && status === 200 ? 'upstream_stream_broken' : null,
      stream: false, promptTokens: i % 5 === 0 ? null : Math.floor(rand() * 100), completionTokens: Math.floor(rand() * 400),
      costMicros: Math.floor(rand() * 5000), savedMicros: Math.floor(rand() * 100),
      cache: pick(['hit', 'semantic-hit', 'miss', 'miss', 'bypass', null]), attempts: 1, fallbackUsed: false,
      latencyMs: i % 11 === 0 ? 0 : slow ? 2000 + Math.floor(rand() * 8000) : 20 + Math.floor(rand() * 200), ttfbMs: null, upstreamMs: null,
    };
  });
}
// A request with the model of the entry that served it, as the rollup names it.
const servedAs = (e: LogEntry) => e.servedModel ?? e.model ?? '';

const raw = (es: LogEntry[]) => es.map((e, i) => ({ id: `${Date.now()}-${i}`, fields: toLogFields(e), stream: 'log' as const }));
const apply = (es: LogEntry[]) => applyBatch(db, raw(es));

interface Group {
  bucket: string;
  tenant: string;
  model: string;
  requests: number;
  errors: number;
  cacheHits: number;
  semanticHits: number;
  cost: number;
  saved: number;
  prompt: number;
  completion: number;
  hist: number[];
}

// The answer, straight from the request log with a plain GROUP BY (its own copy of what an error is).
async function groupBy(unit: 'minute' | 'hour', dims = true): Promise<Group[]> {
  const r = await db.execute<Record<string, string | string[]>>(sql`
    SELECT date_trunc(${unit}, created_at, 'UTC') AS b, ${dims ? sql`coalesce(tenant_id, ${NO_TENANT}::uuid)` : sql`''`} AS t, ${dims ? sql`coalesce(served_model, model, '')` : sql`''`} AS m,
           count(*) AS requests,
           count(*) FILTER (WHERE status >= 500 OR error_code = 'upstream_stream_broken') AS errors,
           count(*) FILTER (WHERE cache = 'hit') AS hits, count(*) FILTER (WHERE cache = 'semantic-hit') AS sem,
           sum(cost_micros) AS cost, sum(saved_micros) AS saved, coalesce(sum(prompt_tokens), 0) AS prompt, coalesce(sum(completion_tokens), 0) AS completion,
           array_agg(latency_ms) AS lat
    FROM request_log WHERE coalesce(served_model, model) LIKE ${model + '-%'}
    GROUP BY 1, 2, 3 ORDER BY 1, 2, 3`);
  return r.rows.map((x) => ({
    bucket: new Date(x.b as string).toISOString(), tenant: x.t as string, model: x.m as string, requests: Number(x.requests), errors: Number(x.errors),
    cacheHits: Number(x.hits), semanticHits: Number(x.sem), cost: Number(x.cost), saved: Number(x.saved), prompt: Number(x.prompt), completion: Number(x.completion),
    hist: histogramOf((x.lat as unknown as number[]).map(Number)),
  }));
}

async function rollup(table: 'rollup_minute' | 'rollup_hour' | 'rollup_total_minute' | 'rollup_total_hour', sinceExclusive?: Date): Promise<Group[]> {
  const total = table.startsWith('rollup_total');
  const r = await db.execute<Record<string, string | string[]>>(sql`
    SELECT bucket AS b, ${total ? sql`''` : sql.raw('tenant_id')} AS t, ${total ? sql`''` : sql.raw('model')} AS m, requests, errors, cache_hits AS hits, semantic_hits AS sem, cost_micros AS cost,
           saved_micros AS saved, prompt_tokens AS prompt, completion_tokens AS completion, latency_hist AS hist
    FROM ${sql.raw(table)} WHERE ${total ? sql`bucket >= ${WINDOW_FROM}::timestamptz AND bucket < ${WINDOW_TO}::timestamptz` : sql`model LIKE ${model + '-%'}`} AND bucket >= ${(sinceExclusive ?? new Date(0)).toISOString()}::timestamptz ORDER BY 1, 2, 3`);
  return r.rows.map((x) => ({
    bucket: new Date(x.b as string).toISOString(), tenant: x.t as string, model: x.m as string, requests: Number(x.requests), errors: Number(x.errors),
    cacheHits: Number(x.hits), semanticHits: Number(x.sem), cost: Number(x.cost), saved: Number(x.saved), prompt: Number(x.prompt), completion: Number(x.completion),
    hist: (x.hist as unknown as number[]).map(Number),
  }));
}
const totalRequests = (g: Group[]) => g.reduce((s, x) => s + x.requests, 0);
const mark = async () => new Date((await db.execute<{ m: number }>(sql`SELECT (extract(epoch FROM folded_through) * 1000)::float8 AS m FROM rollup_state WHERE id = 1`)).rows[0]!.m);

beforeAll(async () => {
  unlock = await lockRollupState(testConfig().databaseUrl);
  originalMark = (await mark()).toISOString();
});
// Everything the file writes is removed: the rows by their models, the totals by this file's window of 2031.
const wipe = async () => {
  await db.execute(sql`DELETE FROM rollup_minute WHERE model LIKE ${`rt-${run}-%`}`);
  await db.execute(sql`DELETE FROM rollup_hour WHERE model LIKE ${`rt-${run}-%`}`);
  await db.execute(sql`DELETE FROM rollup_total_minute WHERE bucket >= ${WINDOW_FROM}::timestamptz AND bucket < ${WINDOW_TO}::timestamptz`);
  await db.execute(sql`DELETE FROM rollup_total_hour WHERE bucket >= ${WINDOW_FROM}::timestamptz AND bucket < ${WINDOW_TO}::timestamptz`);
  await db.execute(sql`DELETE FROM request_log WHERE coalesce(served_model, model) LIKE ${`rt-${run}-%`}`);
};
beforeEach(async () => {
  await wipe();
  model = `rt-${run}-${++testN}`;
  await db.execute(sql`UPDATE rollup_state SET folded_through = 'epoch' WHERE id = 1`);
});
afterAll(async () => {
  await wipe();
  await db.execute(sql`UPDATE rollup_state SET folded_through = ${originalMark}::timestamptz WHERE id = 1`);
  await handle.close();
  await unlock();
});

describe('batch rollups', () => {
  it("a batch's rollups equal a GROUP BY over its rows", async () => {
    const es = entries(600, new Date(NOW.getTime() - 3 * HOUR), new Date(NOW.getTime() - 10 * MIN));
    const r = await apply(es);
    expect(r.logRows).toBe(600);
    const want = await groupBy('minute');
    const got = await rollup('rollup_minute');
    // Not vacuous: many groups, every tenant (null included), both models, errors and every cache result present.
    expect(want.length).toBeGreaterThan(100);
    expect(new Set(want.map((g) => g.tenant))).toEqual(new Set(tenants.map((t) => t ?? NO_TENANT)));
    expect(new Set(want.map((g) => g.model))).toEqual(new Set([`${model}-a`, `${model}-b`]));
    expect(want.some((g) => g.errors > 0 && g.cacheHits > 0 && g.semanticHits > 0)).toBe(true);
    expect(totalRequests(want)).toBe(600);
    expect(got).toEqual(want);
    // The totals table has one row per minute across all tenants and models.
    const wantTotals = await groupBy('minute', false);
    expect(wantTotals.length).toBeGreaterThan(50);
    expect(await rollup('rollup_total_minute')).toEqual(wantTotals);
    // The hour tables are untouched until the fold.
    expect(await rollup('rollup_hour')).toEqual([]);
    expect(await rollup('rollup_total_hour')).toEqual([]);
  });

  it('counts a client that left and a refusal as requests but not errors, and a broken stream as an error', async () => {
    const base = entries(1, NOW, NOW)[0]!;
    const mk = (over: Partial<LogEntry>): LogEntry => ({ ...base, requestId: randomUUID(), startedAt: NOW.getTime(), tenantId: tenants[0]!, servedModel: model + '-a', model: model + '-a', ...over });
    await apply([mk({ status: 499, errorCode: 'client_closed' }), mk({ status: 429, errorCode: 'rate_limited' }), mk({ status: 200, errorCode: 'upstream_stream_broken' }), mk({ status: 504, errorCode: 'upstream_timeout' }), mk({ status: 200, errorCode: null })]);
    const got = await rollup('rollup_minute');
    expect(got).toHaveLength(1);
    expect([got[0]!.requests, got[0]!.errors]).toEqual([5, 2]);
  });

  it('redelivered rows add nothing', async () => {
    const es = entries(120, new Date(NOW.getTime() - 2 * HOUR), new Date(NOW.getTime() - 10 * MIN), 5);
    await apply(es);
    const once = await rollup('rollup_minute');
    // The same batch again, then half of it again inside a larger batch with 30 new entries, and a duplicate inside one batch.
    const again = await apply(es);
    expect(again.logRows).toBe(0);
    const extra = entries(30, new Date(NOW.getTime() - 2 * HOUR), new Date(NOW.getTime() - 10 * MIN), 6);
    const mixed = await apply([...es.slice(0, 60), ...extra, extra[0]!]);
    expect(mixed.logRows).toBe(30);
    expect(totalRequests(once)).toBe(120);
    expect(await rollup('rollup_minute')).toEqual(await groupBy('minute'));
    expect(totalRequests(await rollup('rollup_minute'))).toBe(150);
  });

  it('sorts its rows so overlapping batches from two workers do not deadlock', async () => {
    const from = new Date(NOW.getTime() - 20 * MIN);
    const a = entries(300, from, NOW, 21);
    const b = entries(300, from, NOW, 22);
    const [ra, rb] = await Promise.all([apply(a), apply(b)]);
    expect([ra.failed.length, rb.failed.length]).toEqual([0, 0]);
    expect(await rollup('rollup_minute')).toEqual(await groupBy('minute'));
  });

  it('is in aggregate() order: bucket, tenant, model', () => {
    const es = entries(80, new Date(NOW.getTime() - HOUR), NOW, 3);
    const rows = aggregate(es, (t) => Math.floor(t / MIN) * MIN);
    const keys = rows.map((r) => `${r.bucket.toISOString()}|${r.tenantId}|${r.model}`);
    expect(rows.length).toBeGreaterThan(20);
    expect(keys).toEqual([...keys].sort());
    expect(rows.reduce((s, r) => s + r.requests, 0)).toBe(80);
    expect(new Set(rows.map((r) => r.model))).toEqual(new Set(es.map(servedAs)));
  });
});

describe('fold', () => {
  it('fold minute → hour equals rolling up the raw rows', async () => {
    const es = entries(900, new Date(NOW.getTime() - 5 * HOUR), new Date(NOW.getTime() - 5 * MIN), 8);
    await apply(es);
    const horizon = new Date(Math.floor((NOW.getTime() - 90 * MIN) / HOUR) * HOUR); // 11:00
    const through = await foldRollups(db, NOW, 90);
    expect(through).toEqual(horizon);
    expect(await mark()).toEqual(horizon);
    const hourly = (await groupBy('hour')).filter((g) => new Date(g.bucket) < horizon);
    expect(hourly.length).toBeGreaterThan(10);
    expect(await rollup('rollup_hour')).toEqual(hourly);
    expect(await rollup('rollup_total_hour')).toEqual((await groupBy('hour', false)).filter((g) => new Date(g.bucket) < horizon));
    // The hours not yet folded are in the minute table only.
    expect(totalRequests(await rollup('rollup_minute', horizon))).toBe(totalRequests((await groupBy('minute')).filter((g) => new Date(g.bucket) >= horizon)));
    // Running it again moves nothing.
    await foldRollups(db, NOW, 90);
    expect(await rollup('rollup_hour')).toEqual(hourly);
  });

  it('counts a row that arrives after its hour was folded exactly once, in the hour tables and at minute grain', async () => {
    const early = entries(200, new Date(NOW.getTime() - 5 * HOUR), new Date(NOW.getTime() - 3 * HOUR), 9);
    await apply(early);
    await foldRollups(db, NOW, 90);
    const late = entries(40, new Date(NOW.getTime() - 5 * HOUR), new Date(NOW.getTime() - 3 * HOUR), 10);
    await apply(late);
    const horizon = await mark();
    // The hour tables hold all 240 once. The minute table holds them too, so a 24 hour view that reads minutes sees them.
    expect(await rollup('rollup_hour')).toEqual((await groupBy('hour')).filter((g) => new Date(g.bucket) < horizon));
    expect(totalRequests(await rollup('rollup_hour'))).toBe(240);
    expect(await rollup('rollup_total_hour')).toEqual((await groupBy('hour', false)).filter((g) => new Date(g.bucket) < horizon));
    expect(await rollup('rollup_minute')).toEqual(await groupBy('minute'));
    expect(await rollup('rollup_total_minute')).toEqual(await groupBy('minute', false));
    // A later fold reads only minutes at or after the old mark, so it adds nothing for them a second time.
    await foldRollups(db, new Date(NOW.getTime() + 3 * HOUR), 90);
    expect(await rollup('rollup_hour')).toEqual((await groupBy('hour')).filter((g) => new Date(g.bucket) < NOW));
    expect(await rollup('rollup_total_hour')).toEqual((await groupBy('hour', false)).filter((g) => new Date(g.bucket) < NOW));
  });

  it('keeps a row older than the minute views reach only in the hour tables', async () => {
    await foldRollups(db, NOW, 90);
    const ancient = entries(30, new Date(NOW.getTime() - 100 * HOUR), new Date(NOW.getTime() - 99 * HOUR), 11);
    await apply(ancient);
    expect(totalRequests(await rollup('rollup_hour'))).toBe(30);
    expect(await rollup('rollup_minute')).toEqual([]);
    expect(await rollup('rollup_total_minute')).toEqual([]);
  });

  it('a fold waits for a batch that is mid-write and counts it', async () => {
    const es = entries(100, new Date(NOW.getTime() - 4 * HOUR), new Date(NOW.getTime() - 3 * HOUR), 12);
    // Two live transactions: the first has written its rollups and not committed; the fold must queue behind it.
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    let written!: () => void;
    const wrote = new Promise<void>((r) => (written = r));
    const { writeRollups } = await import('./rollup.ts');
    const batch = db.transaction(async (tx) => {
      await writeRollups(tx, es);
      written();
      await held;
    });
    await wrote;
    let folded = false;
    const fold = foldRollups(db, NOW, 90).then(() => (folded = true));
    await new Promise((r) => setTimeout(r, 300));
    expect(folded).toBe(false);
    release();
    await batch;
    await fold;
    expect(folded).toBe(true);
    expect(totalRequests(await rollup('rollup_hour'))).toBe(100);
    // These rows were written to the rollups directly, so the answer is aggregate() by the hour rather than the log.
    const want = aggregate(es, (t) => Math.floor(t / HOUR) * HOUR).map((r) => [r.bucket.toISOString(), r.tenantId, r.model, r.requests, r.latencyHist]);
    expect((await rollup('rollup_hour')).map((g) => [g.bucket, g.tenant, g.model, g.requests, g.hist])).toEqual(want);
    expect(totalRequests(await rollup('rollup_total_hour'))).toBe(100);
  });
});

describe('retention', () => {
  it('retention deletes only folded minutes', async () => {
    const old = entries(150, new Date(NOW.getTime() - 60 * HOUR), new Date(NOW.getTime() - 58 * HOUR), 14);
    const recent = entries(150, new Date(NOW.getTime() - 3 * HOUR), new Date(NOW.getTime() - 5 * MIN), 15);
    await apply([...old, ...recent]);
    // Nothing is folded yet: however old, the old minutes stay.
    expect(await deleteOldMinutes(db, NOW, 48)).toBe(0);
    expect(totalRequests(await rollup('rollup_minute'))).toBe(300);
    expect(totalRequests(await rollup('rollup_total_minute'))).toBe(300);

    await foldRollups(db, NOW, 90);
    const deleted = await deleteOldMinutes(db, NOW, 48);
    expect(deleted).toBeGreaterThan(50);
    const left = await rollup('rollup_minute');
    // The old hours' minutes are gone and their hour rows stay; everything recent is still there.
    expect(left.every((g) => new Date(g.bucket).getTime() >= NOW.getTime() - 48 * HOUR)).toBe(true);
    expect(totalRequests(left)).toBe(150);
    expect(totalRequests(await rollup('rollup_total_minute'))).toBe(150);
    expect(totalRequests(await rollup('rollup_hour'))).toBe(150 + totalRequests((await groupBy('hour')).filter((g) => new Date(g.bucket) < new Date(Math.floor((NOW.getTime() - 90 * MIN) / HOUR) * HOUR) && new Date(g.bucket).getTime() >= NOW.getTime() - 48 * HOUR)));
  });

  it('an hour that was folded and trimmed keeps its totals', async () => {
    const es = entries(200, new Date(NOW.getTime() - 60 * HOUR), new Date(NOW.getTime() - 58 * HOUR), 16);
    await apply(es);
    const m = await maintainRollups(db, NOW, { foldAfterMin: 90, minuteRetentionH: 48 });
    expect(m.deleted).toBeGreaterThan(50);
    expect(await rollup('rollup_minute')).toEqual([]);
    expect(await rollup('rollup_hour')).toEqual(await groupBy('hour'));
  });
});

describe('worker', () => {
  it('writes the rollups with the log rows, and folds and trims on its sweep timer', async () => {
    const config = testConfig();
    const redis = new Redis(config.redisUrl!);
    const prefix = `rt${run}${testN}:`;
    try {
      const old = entries(40, new Date(NOW.getTime() - 60 * HOUR), new Date(NOW.getTime() - 58 * HOUR), 30);
      const recent = entries(40, new Date(NOW.getTime() - 3 * HOUR), new Date(NOW.getTime() - 5 * MIN), 31);
      for (const e of [...old, ...recent]) await redis.xadd(streamKey(prefix), '*', ...toLogFields(e));
      const quiet = { info() {}, warn() {}, error() {} };
      const w = createWorker({
        db, redis, keyPrefix: prefix, group: 'g', consumer: 'c', batchSize: 500, batchWaitMs: 50, claimIdleMs: 3_600_000, maxDeliveries: 5,
        sweepS: 0, sweepGraceS: 0, sweepTenantId: randomUUID(), rollupFoldAfterMin: 90, rollupMinuteRetentionH: 48, now: () => NOW, epoch: async () => 1, log: quiet,
      });
      await w.runOnce();
      await w.runOnce(); // the sweep of the first pass ran before this batch was a minute old; the second sees it all written
      expect(await rollup('rollup_minute')).toEqual((await groupBy('minute')).filter((g) => new Date(g.bucket).getTime() >= NOW.getTime() - 48 * HOUR));
      const horizon = new Date(Math.floor((NOW.getTime() - 90 * MIN) / HOUR) * HOUR);
      expect(await mark()).toEqual(horizon);
      expect(totalRequests(await rollup('rollup_hour'))).toBe(80 - totalRequests((await groupBy('hour')).filter((g) => new Date(g.bucket) >= horizon)));
    } finally {
      const keys = await redis.keys(`${prefix}*`);
      if (keys.length) await redis.del(...keys);
      redis.disconnect();
    }
  });
});
