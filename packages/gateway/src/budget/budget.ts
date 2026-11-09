import { randomUUID } from 'node:crypto';
import type { Redis } from 'ioredis';
import type { Db } from '../db/client.ts';
import { periodOf, type Period } from './period.ts';
import { createPgLedger, type PgLedger, type SettleRecord, type SpendEntry } from './pg-ledger.ts';
import { createRedisLedger, type RedisLedger } from './redis-ledger.ts';
import type { SpendEntry as QueuedSpend } from '../requestlog/entry.ts';

/** What a request asks the budget to hold. */
export interface ReserveRequest {
  /** Names the hold and its ledger row. Unset: a fresh id. The route passes the request's own id, so the ledger and the request log join on it. */
  id?: string;
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
}

export interface Budget {
  /** Holds `estimate` against the tenant's month, or says why not. Never throws. */
  reserve(req: ReserveRequest): Promise<ReserveOutcome>;
  /**
   * Ends a hold. With Redis up, one script queues the settle for the log worker and moves the live balance;
   * the worker writes the ledger. Otherwise (Redis down, or the script failed) the ledger is written here in a
   * Postgres transaction, retried, and the live balance caught up after. Never throws.
   */
  settle(reservation: Reservation, outcome: SettleOutcome): Promise<void>;
  /** Queues the zero-cost ledger row for a cache hit (written directly if Redis cannot take it). Never throws. */
  recordHit(hit: CacheHitRecord): Promise<void>;
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
  // Settles already made or under way, by hold id. Bounded: only recent ones can be repeated.
  const settles = new Map<string, Promise<void>>();
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

  // Catches the live balance up after a settle written straight to Postgres: releases the hold if the balance
  // still has it and adds the cost. It lands on the current epoch whatever epoch the request reserved under,
  // and does nothing for a balance that already took the settle, so a failed try is simply tried again.
  async function catchUpRedis(res: Reservation, rec: SettleRecord, costMicros: number): Promise<void> {
    if (rec.epoch !== null) adopt(rec.epoch);
    // During an outage one try is made and its failure is expected; Redis is rebuilt from Postgres on return.
    const tries = onPostgres ? 1 : Math.max(1, opts.outageFailures);
    for (let i = 0; i < tries; i++) {
      try {
        const applied = await redisLedger.apply(epoch, [{ tenantId: res.tenantId, period: res.period, id: res.id, costMicros }]);
        redisAnswered();
        if (applied === 'rebuild') return;
        markSeen(res.tenantId, res.period, epoch);
        return;
      } catch (err) {
        if (await redisFailed(err)) {
          await bumping;
          return;
        }
      }
    }
  }

  // True when the settle is recorded (queued, or written to Postgres); false when nothing could be written.
  async function settleNow(res: Reservation, outcome: SettleOutcome): Promise<boolean> {
    const queued: QueuedSpend =
      outcome.kind === 'charge'
        ? {
            kind: 'charge', id: res.id, tenantId: res.tenantId, period: res.period, model: outcome.model ?? res.model,
            promptTokens: outcome.promptTokens, completionTokens: outcome.completionTokens,
            costMicros: outcome.costMicros, estimated: outcome.estimated, savedMicros: 0,
          }
        : { kind: 'refund', id: res.id, tenantId: res.tenantId, period: res.period, model: res.model, promptTokens: 0, completionTokens: 0, costMicros: 0, estimated: false, savedMicros: 0 };

    // The normal path: one Redis script queues the entry and moves the balance. If it cannot (Redis is down, or
    // timed out and may or may not have run), the ledger is written here instead; the worker's insert of the
    // entry, if it did land, then changes nothing.
    if (!onPostgres && bumpDone) {
      try {
        const applied = await redisLedger.settle({ tenantId: res.tenantId, period: res.period, epoch, entry: queued });
        redisAnswered();
        // 'rebuild' means there is no balance at this epoch: nothing to have seen. Marking it would make the
        // next rebuild look like a lost balance and move the epoch again.
        if (applied !== 'rebuild') markSeen(res.tenantId, res.period, epoch);
        return true;
      } catch (err) {
        await redisFailed(err);
      }
    }

    const entry: SpendEntry | null =
      outcome.kind === 'charge'
        ? {
            requestId: res.id, tenantId: res.tenantId, period: res.period, model: queued.model,
            promptTokens: queued.promptTokens, completionTokens: queued.completionTokens,
            costMicros: queued.costMicros, estimated: queued.estimated,
          }
        : null;
    let rec: SettleRecord;
    try {
      // The hold is dropped and the charge recorded in one transaction.
      rec = await withRetries(() => pg.settle(res.id, entry));
    } catch (err) {
      // Nothing was written: the hold stays in both stores until it lapses, then the worker charges its estimate.
      log?.error(errInfo(err), 'budget settle could not be written to postgres');
      return false;
    }
    await catchUpRedis(res, rec, queued.costMicros);
    return true;
  }

  return {
    async reserve(req) {
      const period = periodOf(now());
      const id = req.id ?? randomUUID();
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
          // Not needed after all. If it can't be dropped, the worker's sweeper charges it at its estimate once it lapses.
          await pg.release(id).catch((e: unknown) => log?.warn(errInfo(e), 'budget hold could not be dropped'));
          return { status: 'denied', remaining: outcome.remaining };
        }
        if (outcome !== 'failed') return hold('redis', usedEpoch, outcome.remaining);
        redisMayHaveRun = true;
        if (!bumpDone) await startBump(streakEpoch);
      }

      // Anything but an admission leaves nothing behind: a Redis hold the failed attempt may have made is
      // released (the request's settle would do it for an admitted one), and so is the Postgres row. The row was
      // written before Redis was asked, so a balance rebuilt meanwhile (at a newer epoch this instance has not
      // adopted yet) may have imported it as a hold: it is released there too, or it would sit in that balance
      // with nothing to settle it. The worker's reconcile catches what this misses.
      const cleanUp = async (): Promise<void> => {
        const release = async () => {
          if (!redisMayHaveRun) return;
          const latest = await pg.readEpoch().catch(() => usedEpoch);
          for (const e of new Set([usedEpoch, epoch, latest])) await redisLedger.release(req.tenantId, period, e, id);
        };
        await Promise.all([pg.release(id).catch((e: unknown) => log?.warn(errInfo(e), 'budget hold could not be dropped')), release()]);
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
      // A request is settled once. The script that moves the balance adds a charge each time it runs, so a
      // second call for the same hold (a bug in a caller) is answered with the first call's result.
      const prior = settles.get(reservation.id);
      if (prior) return prior.then(() => undefined);
      const p = settleNow(reservation, outcome).then(
        (ok) => {
          // Nothing was written: a later call may try again.
          if (!ok) settles.delete(reservation.id);
        },
        (err: unknown) => {
          settles.delete(reservation.id);
          log?.error(errInfo(err), 'budget settle failed');
        },
      );
      settles.set(reservation.id, p);
      if (settles.size > 10_000) settles.delete(settles.keys().next().value!);
      pending.add(p);
      void p.finally(() => pending.delete(p));
      return p;
    },

    recordHit(hit) {
      const id = randomUUID();
      const period = periodOf(now());
      const queued: QueuedSpend = {
        kind: 'hit', id, tenantId: hit.tenantId, period, model: hit.model, promptTokens: hit.promptTokens,
        completionTokens: hit.completionTokens, costMicros: 0, estimated: false, savedMicros: hit.savedMicros,
      };
      const p = (async () => {
        if (!onPostgres && bumpDone) {
          try {
            await redisLedger.enqueue(queued);
            return;
          } catch (err) {
            await redisFailed(err);
          }
        }
        await withRetries(() => pg.recordHit({ requestId: id, period, ...hit }));
      })().catch((err: unknown) => {
        log?.error(errInfo(err), 'cache hit could not be written to the ledger');
      });
      pending.add(p);
      void p.finally(() => pending.delete(p));
      return p;
    },

    refreshEpoch,
    epoch: () => epoch,
    mode: () => (onPostgres ? 'postgres' : 'redis'),

    async close() {
      clearInterval(timer);
      await Promise.allSettled([...pending, ...(bumping ? [bumping] : [])]);
    },
  };
}
