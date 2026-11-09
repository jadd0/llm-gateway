import { Redis } from 'ioredis';
import { chargeExpiredHolds } from '../../gateway/src/budget/pg-ledger.ts';
import { applySettled } from '../../gateway/src/budget/redis-ledger.ts';
import { createPgLedger } from '../../gateway/src/budget/pg-ledger.ts';
import { loadConfig } from '../../gateway/src/config.ts';
import { createDb, type Db } from '../../gateway/src/db/client.ts';
import { applyBatch, catchUp } from './batch.ts';
import { createGroup, type Raw } from './claim.ts';

export interface Logger {
  info(obj: object, msg: string): void;
  warn(obj: object, msg: string): void;
  error(obj: object, msg: string): void;
}

export interface WorkerOptions {
  db: Db['db'];
  redis: Redis;
  keyPrefix: string;
  group: string;
  consumer: string;
  batchSize: number;
  batchWaitMs: number;
  claimIdleMs: number;
  maxDeliveries: number;
  sweepS: number;
  log: Logger;
  /** How long a Redis catch-up call may take before it is skipped. */
  redisTimeoutMs?: number;
  /** Called once a batch has been read and before it is written. Tests only. */
  afterRead?: (count: number) => Promise<void>;
}

/** What one pass did. */
export interface PassResult {
  read: number;
  applied: number;
  deadLettered: number;
  swept: number;
}

export interface Worker {
  /** One pass: take over idle entries, read new ones, write them, acknowledge them, trim. */
  runOnce(): Promise<PassResult>;
  /** Runs passes until `stop()`. */
  start(): void;
  /** Stops reading. The pass in progress writes and acknowledges its batch first; resolves when it has. */
  stop(): Promise<void>;
}

const errInfo = (err: unknown) => ({ errClass: (err as Error)?.name, code: (err as { code?: string })?.code });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function createWorker(o: WorkerOptions): Worker {
  const group = createGroup({ redis: o.redis, keyPrefix: o.keyPrefix, group: o.group, consumer: o.consumer });
  const redisTimeoutMs = o.redisTimeoutMs ?? 2000;
  let ensured = false;
  let stopping = false;
  let loop: Promise<void> | null = null;
  let lastSweep = Date.now();

  async function runOnce(): Promise<PassResult> {
    if (!ensured) {
      await group.ensure();
      ensured = true;
    }
    const result: PassResult = { read: 0, applied: 0, deadLettered: 0, swept: 0 };

    // Entries another consumer read and never acknowledged come first: its batch died with it.
    const reclaimed = await group.claimIdle(o.batchSize, o.claimIdleMs);
    let fresh: Raw[] = [];
    if (reclaimed.length < o.batchSize && !stopping) {
      fresh = await group.readNew(o.batchSize - reclaimed.length, reclaimed.length > 0 ? 1 : o.batchWaitMs);
    }
    let batch = [...reclaimed, ...fresh];
    result.read = batch.length;

    if (reclaimed.length > 0) {
      // An entry that keeps coming back is poison: kept aside so it cannot block the stream.
      const counts = await group.deliveries(reclaimed.map((r) => r.id));
      const keep: Raw[] = [];
      for (const e of batch) {
        const n = counts.get(e.id) ?? 0;
        if (reclaimed.includes(e) && n > o.maxDeliveries) {
          await group.deadLetter(e, n);
          result.deadLettered++;
          o.log.error({ entryId: e.id, deliveries: n }, 'log entry moved to the dead-letter stream');
        } else keep.push(e);
      }
      batch = keep;
    }

    if (batch.length > 0) {
      await o.afterRead?.(batch.length);
      const r = await applyBatch(o.db, batch);
      // Acknowledged only after the transaction committed: a crash before this line redelivers the batch, and
      // the inserts are idempotent.
      await group.ack(r.applied);
      result.applied = r.applied.length;
      for (const m of r.malformed) o.log.warn({ entryId: m.id, errClass: m.errClass }, 'log entry could not be read, left pending');
      for (const f of r.failed) o.log.warn({ entryId: f.id, errClass: f.errClass, code: f.code }, 'log entry could not be written, left pending');
      await catchUp(o.db, o.redis, o.keyPrefix, r.settled, redisTimeoutMs).catch((err: unknown) =>
        o.log.warn(errInfo(err), 'live balances could not be caught up'),
      );
      await group.trim().catch((err: unknown) => o.log.warn(errInfo(err), 'stream trim failed'));
    }

    // The safety net for settles that never arrived: only with nothing queued and nothing in flight, so an entry
    // that is merely late is not charged its estimate first.
    if (!stopping && Date.now() - lastSweep >= o.sweepS * 1000 && batch.length === 0) {
      lastSweep = Date.now();
      const b = await group.backlog();
      if (b.lag === 0 && b.pending === 0) {
        const charged = await chargeExpiredHolds(o.db, 1000);
        result.swept = charged.length;
        if (charged.length > 0) {
          o.log.warn({ holds: charged.length }, 'expired holds charged at their estimate');
          const epoch = await createPgLedger(o.db).readEpoch();
          await applySettled(o.redis, o.keyPrefix, epoch, charged, redisTimeoutMs).catch((err: unknown) =>
            o.log.warn(errInfo(err), 'live balances could not be caught up'),
          );
        }
      }
    }
    return result;
  }

  return {
    runOnce,
    start() {
      if (loop) return;
      loop = (async () => {
        while (!stopping) {
          try {
            await runOnce();
          } catch (err) {
            // Redis or Postgres is away: nothing was acknowledged that was not written, so wait and go again.
            o.log.warn(errInfo(err), 'log worker pass failed');
            await sleep(500);
          }
        }
      })();
    },
    async stop() {
      stopping = true;
      await loop;
    },
  };
}

// The process: reads the same environment as the gateway (.env.local), runs until told to stop.
if (import.meta.main) {
  const config = loadConfig();
  const log: Logger = {
    info: (obj, msg) => console.log(JSON.stringify({ level: 'info', msg, ...obj })),
    warn: (obj, msg) => console.log(JSON.stringify({ level: 'warn', msg, ...obj })),
    error: (obj, msg) => console.log(JSON.stringify({ level: 'error', msg, ...obj })),
  };
  if (config.redisUrl === undefined) throw new Error('REDIS_URL is required by the log worker');
  const handle = createDb({ databaseUrl: config.databaseUrl, poolSize: 4 });
  const redis = new Redis(config.redisUrl, { maxRetriesPerRequest: 2 });
  redis.on('error', () => {});
  const worker = createWorker({
    db: handle.db, redis, keyPrefix: config.redisKeyPrefix, group: config.logGroup, consumer: config.workerConsumer,
    batchSize: config.logBatchSize, batchWaitMs: config.logBatchWaitMs, claimIdleMs: config.logClaimIdleMs,
    maxDeliveries: config.logMaxDeliveries, sweepS: config.logSweepS, log,
  });
  let closing = false;
  const shutdown = (signal: string) => {
    if (closing) return;
    closing = true;
    log.warn({ signal }, 'log worker stopping');
    worker.stop().then(
      async () => {
        redis.disconnect();
        await handle.close();
        process.exit(0);
      },
      () => process.exit(1),
    );
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  worker.start();
  log.info({ consumer: config.workerConsumer, group: config.logGroup }, 'log worker started');
}
