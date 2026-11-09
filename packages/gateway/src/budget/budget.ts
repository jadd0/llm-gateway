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
  /** `model` is the one that served, when a fallback made it differ from the one the hold was made for. */
  | { kind: 'charge'; costMicros: number; promptTokens: number; completionTokens: number; estimated: boolean; model?: string };

/** A response served from the cache: nothing is held or charged, the ledger just remembers it. */
export interface CacheHitRecord {
  tenantId: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
  /** What the same usage would have cost at `model`, micro-USD. */
  savedMicros: number;
  /** Which cache served it. */
  cacheKind: 'exact' | 'semantic';
}

export interface Budget {
  /** Holds `estimate` against the tenant's month, or says why not. Never throws. */
  reserve(req: ReserveRequest): Promise<ReserveOutcome>;
  /** Ends a hold: Postgres first (hold removed, charge recorded, retried), then the live balance. Never throws. */
  settle(reservation: Reservation, outcome: SettleOutcome): Promise<void>;
  /** Writes the zero-cost ledger row for a cache hit. Never throws. */
  recordHit(hit: CacheHitRecord): Promise<void>;
  /** Deletes lapsed holds from Postgres (bounded). Run on a timer; exposed for tests. Returns how many went. */
  sweepExpired(): Promise<number>;
  /** Re-reads the epoch from Postgres and adopts it if newer. Run on a timer; exposed for tests. */
  refreshEpoch(): Promise<void>;
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
  /** How often this instance re-reads the epoch from Postgres (one tiny select, never per request). */
  epochRefreshMs: number;
  /** Consecutive failed Redis calls that declare an outage without waiting for a failed PING. */
  outageFailures: number;
  /** How often lapsed holds are deleted from Postgres, in seconds. */
  sweepIntervalS?: number;
  /** The most lapsed holds one sweep deletes. */
  sweepLimit?: number;
  log?: { warn(obj: object, msg: string): void; info(obj: object, msg: string): void; error(obj: object, msg: string): void };
  /** Pins the time that picks the month and the Redis scripts' expiry clock, in ms. Tests only. */
  clock?: () => number;
  /** First wait after a failed epoch bump; doubles per failure up to 2 s. 0 retries on every request. */
  bumpBackoffBaseMs?: number;
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
    onRebuild: (a) => onRebuild(a),
    ...(clock ? { clock } : {}),
  });
  const ttlMs = opts.reservationTtlS * 1000;
  const redisRetryMs = opts.redisRetryMs ?? 1000;
  const retryDelays = opts.retryDelaysMs ?? [50, 200, 800];

  await pg.ensureEpoch();
  let epoch = await pg.readEpoch();
  let onPostgres = false;
  let nextRedisTryAt = 0;
  // Consecutive failed Redis calls, and the epoch when that run began. One failed call is not an
  // outage: it takes `outageFailures` in a row, or a failed PING after any failure.
  let failures = 0;
  let streakEpoch = epoch;
  // The epoch bump of the current outage. False from the moment an outage is declared until the bump has
  // committed and this instance has adopted the new epoch. The Redis path is not used meanwhile, even if
  // Redis answers: its balance is the old epoch's, which missed what Postgres decided.
  let bumpDone = true;
  let bumping: Promise<void> | null = null;
  const pending = new Set<Promise<void>>();
  // Balances this instance has used successfully at the current epoch. One that goes missing again at the
  // same epoch did not expire and was not replaced by a bump: Redis lost it (a restart or a flush).
  const seen = new Set<string>();
  const seenKey = (tenantId: string, period: string, e: number) => `${tenantId}|${period}|${e}`;
  const markSeen = (tenantId: string, period: string, e: number) => {
    if (seen.size > 100_000) seen.clear();
    seen.add(seenKey(tenantId, period, e));
  };
  // Consecutive failed epoch bumps, for the back-off.
  let bumpFailures = 0;
  let nextBumpAt = 0;

  const adopt = (e: number) => {
    if (e > epoch) {
      // Every balance at the old epoch is behind; the next reserve finds no balance at the new one and
      // rebuilds it from Postgres.
      epoch = e;
      seen.clear();
    }
  };

  // Redis lost a balance this instance had been using, so every instance's balances are suspect. Move the
  // epoch on (the same compare-and-set as an outage: of everyone who noticed, one bumps, the rest adopt),
  // so all of them rebuild together from Postgres instead of each trusting what it rebuilt at its own moment.
  // Every tenant whose balance vanished comes through here; they share one bump attempt (and its back-off).
  const onRebuild = (a: { tenantId: string; period: string; epoch: number }) => {
    const k = seenKey(a.tenantId, a.period, a.epoch);
    if (!seen.delete(k)) return; // never used here: a new tenant or month, or the first use after a bump
    const p = startBump(a.epoch);
    pending.add(p);
    void p.finally(() => pending.delete(p));
  };

  // Redis is declared down. Money is decided in Postgres until Redis answers again, and the epoch moves
  // on so the Redis balance, which will have missed what happened meanwhile, is not trusted again: the
  // first reserve after recovery rebuilds it from Postgres. The bump is compare-and-set from the epoch
  // seen when the failures began: of every instance that saw this outage, one bumps and the rest adopt.
  // One bump attempt at a time; a failed one is simply tried again by the next caller.
  // At most one attempt is in flight per instance, whoever asks (an outage, or any number of lost balances).
  const startBump = (from: number): Promise<void> => {
    // After a failure the next attempt waits (exponentially, at most 2 s): a database that is struggling
    // is not hit with an UPDATE per request.
    if (!bumping && Date.now() < nextBumpAt) return Promise.resolve();
    bumping ??= pg.bumpEpoch(from).then(
      (r) => {
        adopt(r.epoch);
        // An outage's bump is done once the epoch is past the one its failures began at.
        if (epoch > streakEpoch) bumpDone = true;
        bumpFailures = 0;
      },
      (e: unknown) => {
        bumpFailures++;
        nextBumpAt = Date.now() + Math.min(2000, (opts.bumpBackoffBaseMs ?? 50) * 2 ** (bumpFailures - 1));
        log?.error(errInfo(e), 'budget epoch bump failed, staying on postgres');
      },
    ).finally(() => {
      bumping = null;
    });
    return bumping;
  };
  const declareOutage = (err: unknown) => {
    nextRedisTryAt = Date.now() + redisRetryMs;
    if (onPostgres) return;
    onPostgres = true;
    bumpDone = false;
    log?.warn(errInfo(err), 'redis unavailable, budget decisions moved to postgres');
    void startBump(streakEpoch);
  };
  const redisAnswered = () => {
    failures = 0;
    // Back to Redis only once the new epoch is in place.
    if (!onPostgres || !bumpDone) return;
    onPostgres = false;
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

  const refreshEpoch = () =>
    pg.readEpoch().then(adopt, (e: unknown) => log?.warn(errInfo(e), 'budget epoch refresh failed'));
  const timer = setInterval(() => void refreshEpoch(), opts.epochRefreshMs);
  timer.unref();

  // Holds are removed when they settle; one whose gateway died is only removed when it lapses. Redis
  // forgets it on its own, Postgres has to be told: a bounded delete, whichever path is in use.
  const sweepLimit = opts.sweepLimit ?? 1000;
  const sweepExpired = () => pg.sweepExpired(sweepLimit);
  const sweeper = setInterval(
    () => void sweepExpired().catch((e: unknown) => log?.warn(errInfo(e), 'budget hold sweep failed')),
    (opts.sweepIntervalS ?? 60) * 1000,
  );
  sweeper.unref();

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
    if (rec.epoch !== null) adopt(rec.epoch);
    // A charge's totals are passed on even when this call found it already recorded (a retry after a lost
    // reply): the live balance takes them only if it is behind.
    const args = { tenantId: res.tenantId, period: res.period, epoch, id: res.id, charges: rec.charges, spentAfter: rec.spent };
    // During an outage one try is made and its failure is expected; Redis is rebuilt from Postgres on return.
    const tries = onPostgres ? 1 : Math.max(1, opts.outageFailures);
    for (let i = 0; i < tries; i++) {
      try {
        const applied = await redisLedger.settle({ ...args, epoch });
        redisAnswered();
        // 'rebuild' means there is no balance at this epoch: nothing to have seen. Marking it would make the
        // next rebuild look like a lost balance and move the epoch again.
        if (applied !== 'rebuild') markSeen(res.tenantId, res.period, epoch);
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
            model: outcome.model ?? res.model,
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

      let usedEpoch = epoch; // the key a Redis attempt uses
      // True once a Redis reserve was sent and did not come back with an answer: its script may have run and
      // left a hold that nothing else knows of.
      let redisMayHaveRun = false;
      const redisReserve = async (): Promise<{ allowed: boolean; remaining: number } | 'failed'> => {
        usedEpoch = epoch;
        try {
          const r = await redisLedger.reserve({
            tenantId: req.tenantId, period, epoch: usedEpoch, id, estimate: req.estimate, cap: req.cap, ttlMs,
          });
          redisAnswered();
          markSeen(req.tenantId, period, usedEpoch);
          return r;
        } catch (err) {
          await redisFailed(err);
          return 'failed';
        }
      };

      // An outage's epoch bump must have landed before anything is decided: while it hasn't (or failed), the
      // Redis balance is the old epoch's and only Postgres can be trusted.
      if (!bumpDone) await startBump(streakEpoch);
      const tryRedis = bumpDone && (!onPostgres || Date.now() >= nextRedisTryAt);
      if (tryRedis) {
        if (onPostgres) nextRedisTryAt = Date.now() + redisRetryMs; // one probe per interval
        // The hold goes to Postgres first. A snapshot (a rebuild) or a Postgres-path reserve that runs
        // between the two steps then counts it; the other order leaves a window where neither store has it.
        try {
          await pg.hold(pgArgs);
        } catch (err) {
          log?.error(errInfo(err), 'budget hold could not be written to postgres');
          return { status: 'unavailable' };
        }
        const outcome = await redisReserve();
        if (outcome !== 'failed' && !outcome.allowed) {
          // Not needed after all. If it can't be dropped it lapses by itself, which only errs towards refusing.
          await pg.release(id).catch((e: unknown) => log?.warn(errInfo(e), 'budget hold could not be dropped'));
          return { status: 'denied', remaining: outcome.remaining };
        }
        if (outcome !== 'failed') return hold('redis', usedEpoch, outcome.remaining);
        redisMayHaveRun = true;
        if (!bumpDone) await startBump(streakEpoch);
      }

      // Anything but an admission leaves nothing behind: a Redis hold the failed attempt may have made is
      // released (the request's settle would do it for an admitted one), and so is the Postgres row.
      const cleanUp = async (): Promise<void> => {
        const work = [
          pg.release(id).catch((e: unknown) => log?.warn(errInfo(e), 'budget hold could not be dropped')),
          ...(redisMayHaveRun ? [redisLedger.release(req.tenantId, period, usedEpoch, id)] : []),
        ];
        await Promise.all(work);
      };
      try {
        // Decided on Postgres. A hold written above for the Redis attempt is replaced, not counted twice.
        const r = await pg.reserve({ ...pgArgs, cap: req.cap });
        if (r.allowed) return hold('postgres', epoch, r.remaining);
        await cleanUp();
        return { status: 'denied', remaining: r.remaining };
      } catch (err) {
        log?.error(errInfo(err), 'budget reserve failed on postgres');
        await cleanUp();
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

    recordHit(hit) {
      const p = withRetries(() => pg.recordHit({ requestId: randomUUID(), period: periodOf(now()), ...hit })).catch((err: unknown) => {
        log?.error(errInfo(err), 'cache hit could not be written to the ledger');
      });
      pending.add(p);
      void p.finally(() => pending.delete(p));
      return p;
    },

    sweepExpired,
    refreshEpoch,
    epoch: () => epoch,
    mode: () => (onPostgres ? 'postgres' : 'redis'),

    async close() {
      clearInterval(timer);
      clearInterval(sweeper);
      await Promise.allSettled([...pending, ...(bumping ? [bumping] : [])]);
    },
  };
}
