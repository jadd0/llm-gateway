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
import { deadKey, streamKey, toLogFields, toSpendFields, type LogEntry, type SpendEntry } from '../../gateway/src/requestlog/entry.ts';
import { cleanup, testConfig } from '../../gateway/src/test-env.ts';
import { periodOf } from '../../gateway/src/budget/period.ts';
import { createPgLedger } from '../../gateway/src/budget/pg-ledger.ts';
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
