import { randomUUID } from 'node:crypto';
import type { Redis } from 'ioredis';
import type { Db } from '../db/client.ts';
import { periodOf, type Period } from './period.ts';
import { createPgLedger, type PgLedger, type SpendEntry } from './pg-ledger.ts';
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
  /** Which ledger holds the money; a settle goes to the same one. */
  readonly path: 'redis' | 'postgres';
  /** The Redis key generation the hold was made under. */
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
  /** Ends a hold. Records the charge in Postgres, retrying, and corrects the live balance. Never throws. */
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
    loadSpent: (tenantId, period) => pg.spent(tenantId, period),
    doneTtlS: opts.reservationTtlS * 2,
    ...(clock ? { clock } : {}),
  });
  const ttlMs = opts.reservationTtlS * 1000;
  const redisRetryMs = opts.redisRetryMs ?? 1000;
  const retryDelays = opts.retryDelaysMs ?? [50, 200, 800];

  let epoch = await pg.readEpoch();
  let onPostgres = false;
  let nextRedisTryAt = 0;
  // The epoch bump of the current outage. The Postgres path waits for it, so no request is decided
  // there under the old epoch.
  let bumping: Promise<void> | null = null;
  const pending = new Set<Promise<void>>();

  // Redis failed (or stopped answering). Money is decided in Postgres until Redis answers again, and the
  // epoch moves on so the Redis balance, which will have missed everything charged meanwhile, is not
  // trusted again: the first reserve after recovery rebuilds it from Postgres. One bump per outage.
  const enterPostgres = (err: unknown) => {
    nextRedisTryAt = Date.now() + redisRetryMs;
    if (onPostgres) return;
    onPostgres = true;
    log?.warn(errInfo(err), 'redis unavailable, budget decisions moved to postgres');
    bumping = pg.bumpEpoch().then(
      (e) => {
        epoch = Math.max(epoch, e);
      },
      (e: unknown) => log?.error(errInfo(e), 'budget epoch bump failed'),
    );
  };
  const redisAnswered = () => {
    if (!onPostgres) return;
    onPostgres = false;
    bumping = null;
    log?.info({}, 'redis available again, budget decisions back on redis');
  };

  const timer = setInterval(() => {
    pg.readEpoch().then(
      (e) => {
        if (e > epoch) epoch = e;
      },
      (e: unknown) => log?.warn(errInfo(e), 'budget epoch refresh failed'),
    );
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

    if (res.path === 'postgres') {
      // Dropping the hold and recording the charge are one transaction.
      try {
        await withRetries(() => pg.settle(res.id, entry));
      } catch (err) {
        log?.error(errInfo(err), 'budget settle could not be written to postgres');
      }
      return;
    }

    // Postgres first: if the live balance is later lost and rebuilt, Postgres must already have this
    // charge. The Redis correction follows whether or not the write succeeded, so the hold is released.
    if (entry !== null) {
      try {
        await withRetries(() => pg.record(entry));
      } catch (err) {
        log?.error(errInfo(err), 'budget settle could not be written to postgres');
      }
    }
    try {
      await redisLedger.settle({
        tenantId: res.tenantId,
        period: res.period,
        epoch: res.epoch,
        id: res.id,
        actual: entry?.costMicros ?? 0,
      });
      redisAnswered();
    } catch (err) {
      // The balance missed this settle: abandon it (new epoch) so it is rebuilt from Postgres.
      enterPostgres(err);
      await bumping;
    }
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

      // A new epoch must be in place before anything is decided under it, on either path.
      if (bumping) await bumping;
      if (!onPostgres || Date.now() >= nextRedisTryAt) {
        if (onPostgres) nextRedisTryAt = Date.now() + redisRetryMs; // one probe per interval
        const usedEpoch = epoch;
        try {
          const r = await redisLedger.reserve({
            tenantId: req.tenantId, period, epoch: usedEpoch, id, estimate: req.estimate, cap: req.cap, ttlMs,
          });
          redisAnswered();
          return r.allowed ? hold('redis', usedEpoch, r.remaining) : { status: 'denied', remaining: r.remaining };
        } catch (err) {
          enterPostgres(err);
        }
      }

      try {
        if (bumping) await bumping;
        const r = await pg.reserve({
          id, tenantId: req.tenantId, period, estimate: req.estimate, cap: req.cap, ttlMs,
        });
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
