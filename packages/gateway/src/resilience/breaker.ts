import { readFileSync } from 'node:fs';
import type { Redis } from 'ioredis';

const BREAKER_LUA = readFileSync(new URL('./breaker.lua', import.meta.url), 'utf8');

export interface BreakerSettings {
  /** Rolling window the failure ratio is measured over. */
  windowMs: number;
  /** Failures in the window needed before the breaker may open. */
  minFailures: number;
  /** Fraction of the window's outcomes that must have failed. */
  failureRatio: number;
  /** How long the breaker stays open before one probe is allowed. */
  openMs: number;
}

/**
 * How a call ended, for the breaker.
 * - success: the provider answered 2xx.
 * - failure: a retryable failure (a status the provider is to blame for, a refused or timed-out connection).
 * - answered: the provider answered with a status that is the caller's doing (a 400, the gateway's own 401).
 *   It is alive, so it closes a half-open breaker, but it is not counted in the window.
 * - abandoned: nothing was learned (the client left, the deadline cut the call).
 */
export type CallResult = 'success' | 'failure' | 'answered' | 'abandoned';

/** The right to make one call, and the duty to report how it went. */
export interface Permit {
  target: string;
  /** This call is the one half-open probe. */
  probe: boolean;
  source: 'redis' | 'local';
}

export type Acquired = { allowed: true; permit: Permit } | { allowed: false; retryInMs: number };

export interface Breaker {
  /** May a call to this target be made now? Never throws and never waits on Redis longer than its timeout. */
  acquire(target: string): Promise<Acquired>;
  /** Reports how a permitted call ended. Never throws. */
  record(permit: Permit, result: CallResult): Promise<void>;
}

/**
 * The state machine in memory, one per process. It is the breaker while Redis is unreachable, and the same
 * rules as breaker.lua: closed, open for `openMs`, then half-open with exactly one probe.
 */
export class LocalBreaker {
  readonly #settings: BreakerSettings;
  readonly #now: () => number;
  readonly #targets = new Map<string, { openUntil: number | null; probing: boolean; seconds: Map<number, [total: number, failed: number]> }>();

  constructor(settings: BreakerSettings, now: () => number = Date.now) {
    this.#settings = settings;
    this.#now = now;
  }

  clear(): void {
    this.#targets.clear();
  }

  #state(target: string) {
    let s = this.#targets.get(target);
    if (!s) {
      s = { openUntil: null, probing: false, seconds: new Map() };
      this.#targets.set(target, s);
    }
    return s;
  }

  acquire(target: string): Acquired {
    const s = this.#state(target);
    const now = this.#now();
    if (s.openUntil === null) return { allowed: true, permit: { target, probe: false, source: 'local' } };
    if (now < s.openUntil) return { allowed: false, retryInMs: s.openUntil - now };
    if (s.probing) return { allowed: false, retryInMs: this.#settings.openMs };
    s.probing = true;
    return { allowed: true, permit: { target, probe: true, source: 'local' } };
  }

  record(permit: Permit, result: CallResult): void {
    const s = this.#state(permit.target);
    const now = this.#now();
    const { windowMs, minFailures, failureRatio, openMs } = this.#settings;
    if (permit.probe) {
      s.probing = false;
      if (result === 'failure') s.openUntil = now + openMs;
      else if (result === 'success' || result === 'answered') this.#targets.delete(permit.target);
      return;
    }
    if (s.openUntil !== null) return; // a call that started before the breaker opened
    if (result !== 'success' && result !== 'failure') return;
    const second = Math.floor(now / 1000);
    const oldest = second - Math.floor(windowMs / 1000) + 1;
    for (const k of s.seconds.keys()) if (k < oldest) s.seconds.delete(k);
    const cell = s.seconds.get(second) ?? [0, 0];
    cell[0] += 1;
    if (result === 'failure') cell[1] += 1;
    s.seconds.set(second, cell);
    let total = 0;
    let failed = 0;
    for (const [t, f] of s.seconds.values()) {
      total += t;
      failed += f;
    }
    if (result === 'failure' && failed >= minFailures && failed >= failureRatio * total) {
      s.openUntil = now + openMs;
      s.seconds.clear();
    }
  }
}

type Commands = Redis & { brk(k1: string, k2: string, ...args: Array<string | number>): Promise<number[]> };

export interface BreakerOptions {
  /** Without Redis the breaker is purely local. */
  redis: Redis | null;
  keyPrefix: string;
  settings: BreakerSettings;
  /** A Redis answer slower than this counts as Redis being down for that call. */
  redisTimeoutMs: number;
  /** How long to leave Redis alone after it failed, so a dead Redis costs one timeout per interval, not per call. */
  redisRetryMs?: number;
  /** How long a half-open probe may hold the lock if it never reports back. */
  probeTtlMs: number;
  log?: { warn(obj: object, msg: string): void; info(obj: object, msg: string): void };
  /** Pins the clock (ms) used by both the script and the local breaker. Tests only: production reads Redis TIME. */
  clock?: () => number;
}

class RedisTimeout extends Error {
  override name = 'RedisTimeout';
}

export function createBreaker(opts: BreakerOptions): Breaker {
  const { redis, keyPrefix, settings, redisTimeoutMs, probeTtlMs, log, clock } = opts;
  const redisRetryMs = opts.redisRetryMs ?? 1000;
  const local = new LocalBreaker(settings, clock);
  const cmd = redis as Commands | null;
  if (cmd) cmd.defineCommand('brk', { numberOfKeys: 2, lua: BREAKER_LUA });
  // The hash tag puts both keys of a target in one Redis Cluster slot.
  const keys = (target: string) => [`${keyPrefix}breaker:{${target}}`, `${keyPrefix}breaker:{${target}}:probe`] as const;

  // Redis is tried first for every call. After a failure it is left alone for `redisRetryMs` and then tried
  // by one call at a time; while it is unusable the local breaker decides.
  let down = false;
  let skipUntil = 0;
  let trial = false;

  const withTimeout = <T>(p: Promise<T>): Promise<T> =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new RedisTimeout('no reply in time')), redisTimeoutMs);
      p.then(
        (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        (e: unknown) => {
          clearTimeout(timer);
          reject(e);
        },
      );
    });

  async function viaRedis(run: (c: Commands) => Promise<number[]>): Promise<number[] | undefined> {
    if (!cmd) return undefined;
    const wasDown = down;
    if (wasDown) {
      if (Date.now() < skipUntil || trial) return undefined;
      trial = true;
    }
    try {
      const reply = await withTimeout(run(cmd));
      if (wasDown) {
        // Redis answered again: what the local breaker learned is dropped, Redis is the one state.
        down = false;
        local.clear();
        log?.info({}, 'redis available again, circuit breakers are shared again');
      }
      return reply;
    } catch (err) {
      skipUntil = Date.now() + redisRetryMs;
      if (!down) {
        down = true;
        log?.warn(
          { errClass: (err as Error).name, code: (err as { code?: string }).code },
          'redis unavailable, circuit breakers are per process until it answers again',
        );
      }
      return undefined;
    } finally {
      if (wasDown) trial = false;
    }
  }

  return {
    async acquire(target) {
      const [k1, k2] = keys(target);
      const args: Array<string | number> = ['acquire', probeTtlMs];
      if (clock) args.push(clock());
      const r = await viaRedis((c) => c.brk(k1, k2, ...args));
      if (r === undefined) return local.acquire(target);
      const [code, ms] = r as [number, number];
      if (code === 0) return { allowed: false, retryInMs: ms };
      return { allowed: true, permit: { target, probe: code === 2, source: 'redis' } };
    },

    async record(permit, result) {
      if (permit.source === 'local') {
        local.record(permit, result);
        return;
      }
      const [k1, k2] = keys(permit.target);
      const code = { success: 's', failure: 'f', answered: 'n', abandoned: 'a' }[result];
      const args: Array<string | number> = [
        'record', code, permit.probe ? 1 : 0, settings.windowMs, settings.minFailures, settings.failureRatio, settings.openMs,
      ];
      if (clock) args.push(clock());
      const r = await viaRedis((c) => c.brk(k1, k2, ...args));
      // Redis went away between the permit and the report: the local breaker still learns what happened.
      if (r === undefined) local.record({ ...permit, source: 'local' }, result);
    },
  };
}
