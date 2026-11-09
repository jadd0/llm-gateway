import { randomUUID } from 'node:crypto';
import type { Redis } from 'ioredis';
import type { Db } from '../db/client.ts';
import { periodOf, type Period } from './period.ts';
import { createPgLedger, type PgLedger, type SettleRecord, type SpendEntry } from './pg-ledger.ts';
import { createRedisLedger, type RedisLedger } from './redis-ledger.ts';

/** What a request asks the budget to hold. */
export interface ReserveRequest {
  tenantId: string;
  model: string;
  /** Worst-case cost, micro-USD. */
  estimate: number;
  /** The tenant's cap for the month, micro-USD. */
  cap: number;
  /** The token counts the estimate was built from; recorded if the estimate ends up being charged. */
  promptTokens: number;
  completionTokens: number;
}

/** Money held for one in-flight request. Passed back to `settle`. */
export interface Reservation {
  readonly id: string;
  readonly tenantId: string;
  readonly period: Period;
  readonly model: string;
  /** Which store decided the request. Either way the hold is in Postgres; a settle always uses both. */
  readonly path: 'redis' | 'postgres';
  /** The Redis key generation the hold was made under (informational: a settle lands on the current one). */
  readonly epoch: number;
  readonly amount: number;
  readonly promptTokens: number;
  readonly completionTokens: number;
}

export type ReserveOutcome =
  | { status: 'allowed'; reservation: Reservation; remaining: number }
  | { status: 'denied'; remaining: number }
  /** Neither Redis nor Postgres could decide. Nothing was held. */
  | { status: 'unavailable' };

/** How a request ended. A refund releases the hold; a charge replaces it with what was really spent. */
export type SettleOutcome =
  | { kind: 'refund' }
  | { kind: 'charge'; costMicros: number; promptTokens: number; completionTokens: number; estimated: boolean };

export interface Budget {
  /** Holds `estimate` against the tenant's month, or says why not. Never throws. */
  reserve(req: ReserveRequest): Promise<ReserveOutcome>;
  /** Ends a hold: Postgres first (hold removed, charge recorded, retried), then the live balance. Never throws. */
  settle(reservation: Reservation, outcome: SettleOutcome): Promise<void>;
  /** The Redis key generation this instance is using. */
  epoch(): number;
  /** Where reservations are going right now. */
  mode(): 'redis' | 'postgres';
  /** Stops the epoch refresh and waits for in-flight settles to finish. */
  close(): Promise<void>;
}

export interface BudgetOptions {
  db: Db['db'];
  redis: Redis;
  keyPrefix: string;
  /** How long an unsettled hold lasts. */
  reservationTtlS: number;
  /** A Redis answer slower than this sends the request to the Postgres path. */
  redisTimeoutMs: number;
  /** How often this instance re-reads the epoch from Postgres. */
  epochRefreshS: number;
  /** Consecutive failed Redis calls that declare an outage without waiting for a failed PING. */
  outageFailures: number;
  log?: { warn(obj: object, msg: string): void; info(obj: object, msg: string): void; error(obj: object, msg: string): void };
  /** Pins the time that picks the month and the Redis scripts' expiry clock, in ms. Tests only. */
  clock?: () => number;
  /** While on the Postgres path, how long to wait between tries at Redis. */
  redisRetryMs?: number;
  /** Waits between tries of a Postgres write that failed (so 3 retries by default). */
  retryDelaysMs?: number[];
  /** Replaces the Postgres ledger. Tests only. */
  pgLedger?: PgLedger;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const errInfo = (err: unknown) => ({ errClass: (err as Error)?.name, code: (err as { code?: string })?.code });

export async function createBudget(opts: BudgetOptions): Promise<Budget> {
  const { log, clock } = opts;
  const now = () => (clock ? clock() : Date.now());
  const pg = opts.pgLedger ?? createPgLedger(opts.db);
  const redisLedger: RedisLedger = createRedisLedger({
    redis: opts.redis,
    keyPrefix: opts.keyPrefix,
    timeoutMs: opts.redisTimeoutMs,
    loadSnapshot: (tenantId, period) => pg.snapshot(tenantId, period),
    ...(clock ? { clock } : {}),
  });
  const ttlMs = opts.reservationTtlS * 1000;
  const redisRetryMs = opts.redisRetryMs ?? 1000;
  const retryDelays = opts.retryDelaysMs ?? [50, 200, 800];

  let epoch = await pg.readEpoch();
  let onPostgres = false;
  let nextRedisTryAt = 0;
  // Consecutive failed Redis calls, and the epoch when that run began. One failed call is not an
  // outage: it takes `outageFailures` in a row, or a failed PING after any failure.
  let failures = 0;
  let streakEpoch = epoch;
  // The epoch bump of the current outage. Decisions wait for it, so nothing is decided under the old epoch.
  let bumping: Promise<void> | null = null;
  const pending = new Set<Promise<void>>();

  const adopt = (e: number) => {
    if (e > epoch) epoch = e;
  };

  // Redis is declared down. Money is decided in Postgres until Redis answers again, and the epoch moves
  // on so the Redis balance, which will have missed what happened meanwhile, is not trusted again: the
  // first reserve after recovery rebuilds it from Postgres. The bump is compare-and-set from the epoch
  // seen when the failures began: of every instance that saw this outage, one bumps and the rest adopt.
  const declareOutage = (err: unknown) => {
    nextRedisTryAt = Date.now() + redisRetryMs;
    if (onPostgres) return;
    onPostgres = true;
    log?.warn(errInfo(err), 'redis unavailable, budget decisions moved to postgres');
    bumping = pg.bumpEpoch(streakEpoch).then(
      (r) => adopt(r.epoch),
      (e: unknown) => log?.error(errInfo(e), 'budget epoch bump failed'),
    );
  };
  const redisAnswered = () => {
    failures = 0;
    if (!onPostgres) return;
    onPostgres = false;
    bumping = null;
    log?.info({}, 'redis available again, budget decisions back on redis');
  };
  // Records a failed Redis call. True when it makes (or already is) an outage.
  async function redisFailed(err: unknown): Promise<boolean> {
    if (onPostgres) return true;
    if (failures === 0) streakEpoch = epoch;
    failures++;
    if (failures >= opts.outageFailures) {
      declareOutage(err);
      return true;
    }
    const alive = await redisLedger.ping().then(() => true, () => false);
    if (!alive) {
      declareOutage(err);
      return true;
    }
    return false;
  }

  const timer = setInterval(() => {
    pg.readEpoch().then(adopt, (e: unknown) => log?.warn(errInfo(e), 'budget epoch refresh failed'));
  }, opts.epochRefreshS * 1000);
  timer.unref();

  async function withRetries<T>(fn: () => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await fn();
      } catch (err) {
        if (attempt >= retryDelays.length) throw err;
        await sleep(retryDelays[attempt]!);
      }
    }
  }

  // Corrects the live balance after Postgres has the settle. It lands on the current epoch whatever epoch
  // the request reserved under, and is safe to repeat, so a failed try is simply tried again.
  async function settleRedis(res: Reservation, rec: SettleRecord): Promise<void> {
    adopt(rec.epoch);
    const args = {
      tenantId: res.tenantId, period: res.period, epoch, id: res.id,
      charges: rec.recorded ? rec.charges : 0, spentAfter: rec.recorded ? rec.spent : 0,
    };
    // During an outage one try is made and its failure is expected; Redis is rebuilt from Postgres on return.
    const tries = onPostgres ? 1 : Math.max(1, opts.outageFailures);
    for (let i = 0; i < tries; i++) {
      try {
        await redisLedger.settle({ ...args, epoch });
        redisAnswered();
        return;
      } catch (err) {
        if (await redisFailed(err)) {
          await bumping;
          return;
        }
      }
    }
  }

  async function settleNow(res: Reservation, outcome: SettleOutcome): Promise<void> {
    const entry: SpendEntry | null =
      outcome.kind === 'charge'
        ? {
            requestId: res.id,
            tenantId: res.tenantId,
            period: res.period,
            model: res.model,
            promptTokens: outcome.promptTokens,
            completionTokens: outcome.completionTokens,
            costMicros: outcome.costMicros,
            estimated: outcome.estimated,
          }
        : null;
    let rec: SettleRecord;
    try {
      // The hold is dropped and the charge recorded in one transaction.
      rec = await withRetries(() => pg.settle(res.id, entry));
    } catch (err) {
      // Nothing was written: the hold stays in both stores until it lapses, then the charge is lost.
      log?.error(errInfo(err), 'budget settle could not be written to postgres');
      return;
    }
    await settleRedis(res, rec);
  }

  return {
    async reserve(req) {
      const period = periodOf(now());
      const id = randomUUID();
      const hold = (path: Reservation['path'], heldEpoch: number, remaining: number): ReserveOutcome => ({
        status: 'allowed',
        remaining,
        reservation: {
          id, tenantId: req.tenantId, period, model: req.model, path, epoch: heldEpoch,
          amount: req.estimate, promptTokens: req.promptTokens, completionTokens: req.completionTokens,
        },
      });
      const pgArgs = { id, tenantId: req.tenantId, period, estimate: req.estimate, ttlMs };

      // A new epoch must be in place before anything is decided under it, on either path.
      if (bumping) await bumping;
      if (!onPostgres || Date.now() >= nextRedisTryAt) {
        if (onPostgres) nextRedisTryAt = Date.now() + redisRetryMs; // one probe per interval
        const usedEpoch = epoch;
        let admitted: { remaining: number } | null = null;
        try {
          const r = await redisLedger.reserve({
            tenantId: req.tenantId, period, epoch: usedEpoch, id, estimate: req.estimate, cap: req.cap, ttlMs,
          });
          redisAnswered();
          if (!r.allowed) return { status: 'denied', remaining: r.remaining };
          admitted = r;
        } catch (err) {
          await redisFailed(err);
        }
        if (admitted) {
          // Redis said yes. The hold is mirrored in Postgres so that the Postgres path, and any Redis
          // balance rebuilt from Postgres, count it. If it can't be written the hold is given back.
          try {
            await pg.hold(pgArgs);
            return hold('redis', usedEpoch, admitted.remaining);
          } catch (err) {
            log?.error(errInfo(err), 'budget hold could not be written to postgres');
            const releasing = redisLedger
              .settle({ tenantId: req.tenantId, period, epoch: usedEpoch, id, charges: 0, spentAfter: 0 })
              .then(() => {}, () => {}); // a hold that can't be released lapses by itself
            pending.add(releasing);
            void releasing.finally(() => pending.delete(releasing));
            return { status: 'unavailable' };
          }
        }
        if (bumping) await bumping;
      }

      try {
        const r = await pg.reserve({ ...pgArgs, cap: req.cap });
        return r.allowed ? hold('postgres', epoch, r.remaining) : { status: 'denied', remaining: r.remaining };
      } catch (err) {
        log?.error(errInfo(err), 'budget reserve failed on postgres');
        return { status: 'unavailable' };
      }
    },

    settle(reservation, outcome) {
      const p = settleNow(reservation, outcome).catch((err: unknown) => {
        log?.error(errInfo(err), 'budget settle failed');
      });
      pending.add(p);
      void p.finally(() => pending.delete(p));
      return p;
    },

    epoch: () => epoch,
    mode: () => (onPostgres ? 'postgres' : 'redis'),

    async close() {
      clearInterval(timer);
      await Promise.allSettled([...pending, ...(bumping ? [bumping] : [])]);
    },
  };
}
