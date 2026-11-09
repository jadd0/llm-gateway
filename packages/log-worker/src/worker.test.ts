import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { eq, inArray, sql } from 'drizzle-orm';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTenant } from '../../gateway/src/cli/keys.ts';
import { createDb, type Db } from '../../gateway/src/db/client.ts';
import { requestLog } from '../../gateway/src/db/schema.ts';
import { deadKey, spendKey, streamKey, toLogFields, toSpendFields, type LogEntry, type SpendEntry } from '../../gateway/src/requestlog/entry.ts';
import { cleanup, testConfig } from '../../gateway/src/test-env.ts';
import { periodOf } from '../../gateway/src/budget/period.ts';
import { createBudget } from '../../gateway/src/budget/budget.ts';
import { chargeExpiredHolds, createPgLedger } from '../../gateway/src/budget/pg-ledger.ts';
import { applySettled, createRedisLedger, balanceKey } from '../../gateway/src/budget/redis-ledger.ts';
import { createWorker, type Worker, type WorkerOptions } from './worker.ts';

// A real Redis and a real Postgres. Each test uses its own consumer group, so tests never read each other's
// entries; the stream key is the run's own prefix.
const base = testConfig();
const prefix = base.redisKeyPrefix;
// Each test has a stream of its own under the run's prefix, so no test reads another's entries.
let kp = prefix;
let testN = 0;
const P = periodOf(Date.now());
let handle: Db;
let redis: Redis;
const tenantIds: string[] = [];
const requestIds: string[] = [];
const quiet = { info() {}, warn() {}, error() {} };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeEach(() => {
  kp = `${prefix}t${++testN}:`;
});
beforeAll(() => {
  handle = createDb({ databaseUrl: base.databaseUrl, poolSize: 8 });
  redis = new Redis(base.redisUrl!);
});
afterAll(async () => {
  if (requestIds.length) await handle.db.delete(requestLog).where(inArray(requestLog.requestId, requestIds));
  await cleanup(handle.db, redis, tenantIds, prefix);
  redis.disconnect();
  await handle.close();
});

const newTenant = async () => {
  const t = await createTenant(handle.db, `t-${randomUUID().slice(0, 8)}`);
  tenantIds.push(t.id);
  return t.id;
};
let groupN = 0;
const workerFor = (extra: Partial<WorkerOptions> = {}, group = `g${++groupN}-${randomUUID().slice(0, 6)}`): Worker & { group: string } =>
  Object.assign(
    createWorker({
      db: handle.db, redis, keyPrefix: kp, group, consumer: extra.consumer ?? 'w1', batchSize: 500, batchWaitMs: 50,
      claimIdleMs: 3_600_000, maxDeliveries: 5, sweepS: 3600, log: quiet, ...extra,
    }),
    { group },
  );

const logEntry = (tenantId: string | null, over: Partial<LogEntry> = {}): LogEntry => {
  const requestId = randomUUID();
  requestIds.push(requestId);
  return {
    requestId, startedAt: Date.now(), tenantId, keyId: null, model: 'mock-ok', servedModel: 'mock-ok', provider: 'mock',
    status: 200, errorCode: null, stream: false, promptTokens: 1, completionTokens: 10, costMicros: 31, savedMicros: 0,
    cache: 'miss', attempts: 1, fallbackUsed: false, latencyMs: 12, ttfbMs: 5, upstreamMs: 9, ...over,
  };
};
const spendEntry = (tenantId: string, over: Partial<SpendEntry> = {}): SpendEntry => ({
  kind: 'charge', id: randomUUID(), tenantId, period: P, model: 'mock-ok', promptTokens: 1, completionTokens: 10,
  costMicros: 31, estimated: false, savedMicros: 0, ...over,
});
const queue = async (fields: string[][]) => {
  for (const f of fields) await redis.xadd(streamKey(kp), '*', ...f);
};
const logRows = async (ids: string[]) => (await handle.db.select({ id: requestLog.requestId }).from(requestLog).where(inArray(requestLog.requestId, ids))).length;
const pending = async (group: string) => Number(((await redis.xpending(streamKey(kp), group)) as unknown as [number])[0]);

describe('log worker', { timeout: 60_000 }, () => {
  it('batches up to LOG_BATCH_SIZE in one transaction', async () => {
    const t = await newTenant();
    const entries = Array.from({ length: 25 }, () => logEntry(t));
    await queue(entries.map(toLogFields));
    const w = workerFor({ batchSize: 10 });
    const spy = vi.spyOn(handle.db, 'transaction');
    try {
      const first = await w.runOnce();
      expect(first).toMatchObject({ read: 10, applied: 10 });
      expect(spy).toHaveBeenCalledTimes(1); // ten entries, one transaction
    } finally {
      spy.mockRestore();
    }
    expect(await logRows(entries.map((e) => e.requestId))).toBe(10);
    expect(await w.runOnce()).toMatchObject({ read: 10, applied: 10 });
    expect(await w.runOnce()).toMatchObject({ read: 5, applied: 5 });
    expect(await logRows(entries.map((e) => e.requestId))).toBe(25);
    expect(await pending(w.group)).toBe(0);
    const row = (await handle.db.select().from(requestLog).where(eq(requestLog.requestId, entries[0]!.requestId)))[0]!;
    expect(row).toMatchObject({ tenantId: t, model: 'mock-ok', status: 200, costMicros: 31, cache: 'miss', fallbackUsed: false, latencyMs: 12 });
  });

  it('redelivered entries insert nothing twice: a duplicate of a log entry and of a charge changes no row and no total', async () => {
    const t = await newTenant();
    const pgl = createPgLedger(handle.db);
    const hold = { id: randomUUID(), tenantId: t, period: P, estimate: 100, ttlMs: 300_000 };
    await pgl.hold(hold);
    const log = logEntry(t);
    const charge = spendEntry(t, { id: hold.id, costMicros: 40 });
    const fields = [toLogFields(log), toSpendFields(charge)];
    await queue(fields);
    const w = workerFor();
    expect(await w.runOnce()).toMatchObject({ read: 2, applied: 2 });
    expect(await pgl.snapshot(t, P)).toMatchObject({ spent: 40, charges: 1, holds: [] });
    // The same two entries delivered again (a redelivery after a lost ack), in one batch with a copy.
    await queue([...fields, fields[0]!]);
    expect(await w.runOnce()).toMatchObject({ read: 3, applied: 3 });
    expect(await pgl.snapshot(t, P)).toMatchObject({ spent: 40, charges: 1 });
    expect(await logRows([log.requestId])).toBe(1);
    const n = await handle.db.execute(sql`select count(*) as n from spend_ledger where tenant_id = ${t}`);
    expect(Number(n.rows[0]!.n)).toBe(1);
  });

  it('idle pending entries are reclaimed: a batch read by a worker that died is written by another, once', async () => {
    const t = await newTenant();
    const entries = [logEntry(t), logEntry(t), logEntry(t)];
    await queue(entries.map(toLogFields));
    const group = `reclaim-${randomUUID().slice(0, 6)}`;
    const dying = workerFor({ consumer: 'dies', afterRead: () => Promise.reject(new Error('killed mid-batch')) }, group);
    await expect(dying.runOnce()).rejects.toThrow('killed mid-batch');
    expect(await logRows(entries.map((e) => e.requestId))).toBe(0);
    expect(await pending(group)).toBe(3);
    // Not idle long enough: left alone.
    const impatient = workerFor({ consumer: 'next', claimIdleMs: 3_600_000 }, group);
    expect(await impatient.runOnce()).toMatchObject({ read: 0 });
    await sleep(30);
    const next = workerFor({ consumer: 'next', claimIdleMs: 20 }, group);
    expect(await next.runOnce()).toMatchObject({ read: 3, applied: 3 });
    expect(await logRows(entries.map((e) => e.requestId))).toBe(3);
    expect(await pending(group)).toBe(0);
  });

  it('poison entry goes to dead letter after max deliveries and the worker keeps going', async () => {
    const t = await newTenant();
    const good = logEntry(t);
    // Not a uuid where one is required: it can never be applied.
    await queue([['v', '1', 'k', 'log', 'id', 'not-a-uuid', 'at', '1']]);
    await queue([toLogFields(good)]);
    const group = `poison-${randomUUID().slice(0, 6)}`;
    const w = workerFor({ claimIdleMs: 5, maxDeliveries: 2 }, group);
    let dead = 0;
    for (let i = 0; i < 12 && dead === 0; i++) {
      dead += (await w.runOnce()).deadLettered;
      await sleep(10);
    }
    expect(dead).toBe(1);
    expect(await logRows([good.requestId])).toBe(1);
    expect(await pending(group)).toBe(0);
    const entries = await redis.xrange(deadKey(kp), '-', '+');
    expect(entries).toHaveLength(1);
    const f = entries[0]![1];
    expect(f[f.indexOf('id') + 1]).toBe('not-a-uuid');
    expect(Number(f[f.indexOf('dead_deliveries') + 1])).toBeGreaterThan(2);
    // And it carries nothing but what was queued: ids, counts, no text.
    expect(await w.runOnce()).toMatchObject({ read: 0 });
  });

  it('trim never removes a pending entry, and removes what every consumer is done with', async () => {
    const t = await newTenant();
    const stuck = [logEntry(t), logEntry(t)];
    await queue(stuck.map(toLogFields));
    const group = `trim-${randomUUID().slice(0, 6)}`;
    const dying = workerFor({ consumer: 'dies', afterRead: () => Promise.reject(new Error('killed')) }, group);
    await expect(dying.runOnce()).rejects.toThrow();
    const later = [logEntry(t), logEntry(t), logEntry(t)];
    await queue(later.map(toLogFields));
    const w = workerFor({ consumer: 'live', claimIdleMs: 3_600_000 }, group);
    expect(await w.runOnce()).toMatchObject({ read: 3, applied: 3 });
    // The three later ones are done; the two stuck ones are pending and must still be in the stream.
    const ids = (await redis.xrange(streamKey(kp), '-', '+')).map(([, f]) => f[f.indexOf('id') + 1]);
    expect(ids).toEqual(expect.arrayContaining(stuck.map((e) => e.requestId)));
    expect(await pending(group)).toBe(2);
    // Once they are taken over and done, the stream shrinks to (at most) the last delivered entry.
    await sleep(30);
    const taker = workerFor({ consumer: 'taker', claimIdleMs: 10 }, group);
    expect(await taker.runOnce()).toMatchObject({ applied: 2 });
    expect(await pending(group)).toBe(0);
    expect(await redis.xlen(streamKey(kp))).toBeLessThanOrEqual(1);
    expect(await logRows(stuck.map((e) => e.requestId))).toBe(2);
  });

  it('stop mid-batch commits and acknowledges it before resolving', async () => {
    const t = await newTenant();
    const entries = Array.from({ length: 6 }, () => logEntry(t));
    await queue(entries.map(toLogFields));
    let reached!: () => void;
    const atBatch = new Promise<void>((r) => (reached = r));
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const w = workerFor({ afterRead: async () => (reached(), await gate) });
    w.start();
    await atBatch; // read, not yet written
    expect(await logRows(entries.map((e) => e.requestId))).toBe(0);
    const stopped = w.stop();
    let done = false;
    void stopped.then(() => (done = true));
    await sleep(50);
    expect(done).toBe(false); // waiting for the batch
    release();
    await stopped;
    expect(await logRows(entries.map((e) => e.requestId))).toBe(6);
    expect(await pending(w.group)).toBe(0);
  });

  it('lapsed holds are charged on the sweep timer while a steady stream of entries keeps the worker busy', async () => {
    const t = await newTenant();
    const pgl = createPgLedger(handle.db);
    const orphan = { id: randomUUID(), tenantId: t, period: P, estimate: 250, ttlMs: -60_000 };
    await pgl.hold(orphan);
    // About 5 requests a second with the default batch wait: each pass returns as soon as an entry arrives, so
    // no pass is ever empty and the stream is never quiet.
    const w = workerFor({ sweepS: 0.4, sweepGraceS: 0, batchWaitMs: 1000 });
    // The producer has its own connection: the worker's blocking read would hold up commands on a shared one.
    const gateway = new Redis(base.redisUrl!);
    let producing = true;
    const producer = (async () => {
      while (producing) {
        await gateway.xadd(streamKey(kp), '*', ...toLogFields(logEntry(t)));
        await sleep(200);
      }
    })();
    const startedAt = Date.now();
    w.start();
    let charged = false;
    while (!charged && Date.now() - startedAt < 4000) {
      charged = Number((await handle.db.execute(sql`select count(*) as n from spend_ledger where request_id = ${orphan.id}`)).rows[0]!.n) === 1;
      await sleep(50);
    }
    producing = false;
    await producer;
    gateway.disconnect();
    await w.stop();
    expect(charged).toBe(true);
    expect(Date.now() - startedAt).toBeLessThan(3000); // within about LOG_SWEEP_S, not "when the stream is quiet"
    expect(await pgl.snapshot(t, P)).toMatchObject({ spent: 250, holds: [] });
  });

  it('a hold that lapsed less than the sweep grace ago is left for its queued settle', async () => {
    const t = await newTenant();
    const pgl = createPgLedger(handle.db);
    const recent = { id: randomUUID(), tenantId: t, period: P, estimate: 90, ttlMs: -5000 };
    await pgl.hold(recent);
    const w = workerFor({ sweepS: 0, sweepGraceS: 60 });
    expect((await w.runOnce()).swept).toBe(0);
    expect((await pgl.snapshot(t, P)).holds).toHaveLength(1);
    // Its settle arrives and is applied as the real cost, not the estimate.
    await queue([toSpendFields(spendEntry(t, { id: recent.id, costMicros: 30 }))]);
    await w.runOnce();
    expect(await pgl.snapshot(t, P)).toMatchObject({ spent: 30, holds: [] });
  });

  describe('a stalled worker and the sweeper', () => {
    const REAL = 9;
    const EST = 401;
    const N = 12;
    const lapse = () => sleep(1300); // past a 1 s reservation TTL
    const estRows = async (t: string) =>
      Number((await handle.db.execute(sql`select count(*) as n from spend_ledger where tenant_id = ${t} and estimated`)).rows[0]!.n);
    const realRows = async (t: string) =>
      Number((await handle.db.execute(sql`select count(*) as n from spend_ledger where tenant_id = ${t} and not estimated and cost_micros = ${REAL}`)).rows[0]!.n);
    const redisSpent = async (t: string) => Number((await redis.hget(balanceKey(kp, t, P, await createPgLedger(handle.db).readEpoch()), 'spent')) ?? NaN);
    const settleMany = async (t: string) => {
      const b = await createBudget({ db: handle.db, redis, keyPrefix: kp, reservationTtlS: 1, redisTimeoutMs: 2000, epochRefreshMs: 3_600_000, outageFailures: 3 });
      for (let i = 0; i < N; i++) {
        const o = await b.reserve({ tenantId: t, model: 'm', estimate: EST, cap: 1_000_000_000, promptTokens: 1, completionTokens: 1 });
        if (o.status !== 'allowed') throw new Error('not admitted');
        await b.settle(o.reservation, { kind: 'charge', costMicros: REAL, promptTokens: 1, completionTokens: 1, estimated: false });
      }
      await b.close();
    };

    it('the sweep waits while the spend stream has entries: no hold with a queued settle is charged, and everything ends equal', async () => {
      const t = await newTenant();
      await settleMany(t); // N real settles queued in the spend stream; their hold rows still in Postgres
      await lapse(); // every hold row is past its expiry, the worker has read nothing
      const w = workerFor({ batchSize: 5, sweepS: 0, sweepGraceS: 0 });
      const swept: number[] = [];
      const ests: number[] = [];
      for (let i = 0; i < 6; i++) {
        swept.push((await w.runOnce()).swept);
        ests.push(await estRows(t));
      }
      // While entries are still waiting (the first two passes) nothing is swept; later passes may sweep other tests' holds.
      expect(swept.slice(0, 2)).toEqual([0, 0]);
      expect(ests).toEqual([0, 0, 0, 0, 0, 0]);
      const snap = await createPgLedger(handle.db).snapshot(t, P);
      expect(snap).toMatchObject({ spent: N * REAL, charges: N, holds: [], estimated: [] });
      expect(await realRows(t)).toBe(N);
      expect(await redisSpent(t)).toBe(N * REAL);
    });

    it('a settle applied after the sweeper charged the estimate replaces it, in Postgres and in a balance that took the real settle itself', async () => {
      const t = await newTenant();
      await settleMany(t);
      await lapse();
      // The sweeper gets in first (the check passed, then the settles were queued behind a stall).
      const charged = (await chargeExpiredHolds(handle.db, 10_000, 0)).filter((c) => c.tenantId === t);
      expect(charged).toHaveLength(N);
      const pgl = createPgLedger(handle.db);
      await applySettled(redis, kp, await pgl.readEpoch(), charged, 2000);
      expect((await pgl.snapshot(t, P)).spent).toBe(N * EST);
      expect(await redisSpent(t)).toBe(N * REAL); // Redis had the real cost all along and ignored the estimate
      const w = workerFor({ sweepS: 3600 });
      while ((await w.runOnce()).read > 0);
      expect(await pgl.snapshot(t, P)).toMatchObject({ spent: N * REAL, charges: N, holds: [], estimated: [] });
      expect(await estRows(t)).toBe(0);
      expect(await realRows(t)).toBe(N);
      expect(await redisSpent(t)).toBe(N * REAL);
    });

    it('a settle applied after the sweeper charged the estimate also corrects a balance that was rebuilt from the estimate', async () => {
      const t = await newTenant();
      const pgl = createPgLedger(handle.db);
      const ids = Array.from({ length: N }, () => randomUUID());
      for (const id of ids) await pgl.hold({ id, tenantId: t, period: P, estimate: EST, ttlMs: -60_000 });
      const charged = (await chargeExpiredHolds(handle.db, 10_000, 0)).filter((c) => c.tenantId === t);
      expect(charged).toHaveLength(N);
      // The balance does not exist yet: it is built now, from a snapshot that has the estimates as spend.
      const l = createRedisLedger({ redis, keyPrefix: kp, timeoutMs: 2000, loadSnapshot: (tn, pe) => pgl.snapshot(tn, pe) });
      const epoch = await pgl.readEpoch();
      await l.reserve({ tenantId: t, period: P, epoch, id: randomUUID(), estimate: 1, cap: 1_000_000_000, ttlMs: 60_000 });
      expect(await redisSpent(t)).toBe(N * EST);
      await queue(ids.map((id) => toSpendFields(spendEntry(t, { id, costMicros: REAL }))));
      const w = workerFor({ sweepS: 3600 });
      while ((await w.runOnce()).read > 0);
      expect((await pgl.snapshot(t, P)).spent).toBe(N * REAL);
      expect(await redisSpent(t)).toBe(N * REAL);
      expect(await estRows(t)).toBe(0);
    });
  });

  describe('reconcile', () => {
    const ledgerFor = (pgl: ReturnType<typeof createPgLedger>) =>
      createRedisLedger({ redis, keyPrefix: kp, timeoutMs: 2000, loadSnapshot: (tn, pe) => pgl.snapshot(tn, pe) });
    const bal = async (t: string, epoch: number) => {
      const h = await redis.hgetall(balanceKey(kp, t, P, epoch));
      return { spent: Number(h.spent), reserved: Number(h.reserved) };
    };

    it('drops Redis holds with no Postgres hold row, charges those Postgres already charged, and leaves the young and the held', async () => {
      const t = await newTenant();
      const pgl = createPgLedger(handle.db);
      const epoch = await pgl.readEpoch();
      const l = ledgerFor(pgl);
      const reserve = (id: string, estimate: number, ttlMs: number) => l.reserve({ tenantId: t, period: P, epoch, id, estimate, cap: 1_000_000, ttlMs });
      const phantom = randomUUID(); // a rebuild imported it, Postgres then refused the request: no row anywhere
      const charged = randomUUID(); // Postgres took its charge; Redis never heard
      const held = randomUUID(); // Postgres still holds it: its settle may be queued
      const young = randomUUID(); // no Postgres row, but not yet past its expiry by the grace
      await reserve(phantom, 100, 1);
      await reserve(charged, 200, 1);
      await pgl.hold({ id: held, tenantId: t, period: P, estimate: 400, ttlMs: 1 });
      await reserve(held, 400, 1);
      await reserve(young, 800, 3_600_000);
      await pgl.hold({ id: charged, tenantId: t, period: P, estimate: 200, ttlMs: 1 });
      await pgl.settle(charged, { requestId: charged, tenantId: t, period: P, model: 'm', promptTokens: 1, completionTokens: 1, costMicros: 150, estimated: false });
      expect(await bal(t, epoch)).toEqual({ spent: 0, reserved: 1500 });
      await sleep(20);
      const w = workerFor({ sweepS: 0, sweepGraceS: 3600, orphanGraceS: 0 });
      expect((await w.runOnce()).reconciled).toBe(2);
      // phantom released (100), charged released and charged at what Postgres charged (200 -> 150); held and young stay.
      expect(await bal(t, epoch)).toEqual({ spent: 150, reserved: 1200 });
      expect((await w.runOnce()).reconciled).toBe(0);
    });
  });

  it('warns once the request-log stream is over 80% of its cap, before trimming', async () => {
    const t = await newTenant();
    await queue(Array.from({ length: 90 }, () => toLogFields(logEntry(t))));
    const warns: Array<{ obj: object; msg: string }> = [];
    const w = workerFor({ batchSize: 10, streamMax: 100, trimEveryMs: 0, log: { ...quiet, warn: (obj, msg) => void warns.push({ obj, msg }) } });
    await w.runOnce();
    expect(warns.filter((x) => /80%/.test(x.msg))).toEqual([expect.objectContaining({ obj: expect.objectContaining({ length: 90, max: 100 }) })]);
  });

  it('the budget epoch is read fresh for every batch that wrote spend, so a settle never lands on a stale epoch; the stream is trimmed on an interval', async () => {
    const t = await newTenant();
    await queue(Array.from({ length: 6 }, () => toSpendFields(spendEntry(t))));
    const w = workerFor({ batchSize: 2, trimEveryMs: 3_600_000 });
    const selects = vi.spyOn(handle.db, 'select');
    const xinfo = vi.spyOn(redis, 'xinfo');
    try {
      for (let i = 0; i < 3; i++) await w.runOnce();
      // 3 batches of spend: one epoch read each, and XINFO only for the first pass's trim (two streams).
      expect(selects.mock.calls.length).toBe(3);
      expect(xinfo.mock.calls.length).toBe(2);
    } finally {
      selects.mockRestore();
      xinfo.mockRestore();
    }
  });

  describe('reading', () => {
    it('a batch never exceeds batchSize, and spend entries are read before log entries', async () => {
      const t = await newTenant();
      const spends = Array.from({ length: 3 }, () => spendEntry(t));
      for (const e of Array.from({ length: 7 }, () => logEntry(t))) await redis.xadd(streamKey(kp), '*', ...toLogFields(e));
      for (const e of spends) await redis.xadd(spendKey(kp), '*', ...toSpendFields(e));
      const w = workerFor({ batchSize: 4 });
      const reads: number[] = [];
      let total = 0;
      for (let i = 0; i < 6 && total < 10; i++) {
        const r = await w.runOnce();
        reads.push(r.read);
        total += r.read;
      }
      expect(reads.every((n) => n <= 4)).toBe(true);
      expect(reads[0]).toBe(4); // the three spend entries, then one log entry
      expect(total).toBe(10);
      const n = await handle.db.execute(sql`select count(*) as n from spend_ledger where tenant_id = ${t}`);
      expect(Number(n.rows[0]!.n)).toBe(3); // all three spend entries were in the first batch
      expect(await pending(w.group)).toBe(0);
    });

    it('with nothing waiting, a blocking read that wakes on both streams still fits the batch', async () => {
      const t = await newTenant();
      const w = workerFor({ batchSize: 4, batchWaitMs: 2000 });
      const gateway = new Redis(base.redisUrl!);
      const pass = w.runOnce();
      await sleep(100);
      // Both streams get entries at once: the blocked read is asked for at most half the batch from each.
      await Promise.all([
        ...Array.from({ length: 5 }, () => gateway.xadd(spendKey(kp), '*', ...toSpendFields(spendEntry(t)))),
        ...Array.from({ length: 5 }, () => gateway.xadd(streamKey(kp), '*', ...toLogFields(logEntry(t)))),
      ]);
      const r = await pass;
      gateway.disconnect();
      expect(r.read).toBeGreaterThan(0);
      expect(r.read).toBeLessThanOrEqual(4);
    });
  });

  it('the process stops on SIGTERM after writing what it read, and exits 0', async () => {
    const t = await newTenant();
    const group = `proc-${randomUUID().slice(0, 6)}`;
    const entries = Array.from({ length: 20 }, () => logEntry(t));
    await queue(entries.map(toLogFields));
    const child = spawn(process.execPath, [fileURLToPath(new URL('./worker.ts', import.meta.url))], {
      env: {
        ...process.env,
        REDIS_KEY_PREFIX: kp, API_KEY_PEPPER: base.apiKeyPepper, LOG_GROUP: group, WORKER_CONSUMER: 'proc', LOG_LEVEL: 'silent',
        LOG_BATCH_WAIT_MS: '50', LOG_SWEEP_S: '3600',
      },
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    let out = '';
    child.stdout.on('data', (c: Buffer) => (out += c.toString()));
    const until = Date.now() + 15_000;
    while ((await logRows(entries.map((e) => e.requestId))) < 20 && Date.now() < until) await sleep(25);
    expect(await logRows(entries.map((e) => e.requestId))).toBe(20);
    child.kill('SIGTERM');
    const [code] = (await once(child, 'exit')) as [number | null, string | null];
    expect(code).toBe(0);
    expect(out).toContain('log worker stopping');
    expect(await pending(group)).toBe(0);
  });
});
