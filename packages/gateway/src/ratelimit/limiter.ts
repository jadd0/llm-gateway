import { readFileSync } from 'node:fs';
import type { Redis } from 'ioredis';
import { isStarting } from '../redis.ts';

const TAKE_LUA = readFileSync(new URL('./token-bucket.lua', import.meta.url), 'utf8');
const ADJUST_LUA = readFileSync(new URL('./token-bucket-adjust.lua', import.meta.url), 'utf8');

export interface BucketInfo {
  limit: number;
  remaining: number;
  /** Milliseconds until the bucket is full again. */
  resetMs: number;
}

export interface Buckets {
  requests: BucketInfo;
  tokens: BucketInfo;
}

export type TakeResult =
  | { status: 'allowed'; buckets: Buckets }
  /** `limited` is the bucket that made the request wait the longest. */
  | { status: 'denied'; buckets: Buckets; retryAfterMs: number; limited: 'requests' | 'tokens' }
  /** Redis could not answer in time: the request is served and not limited. */
  | { status: 'skipped' };

export interface Limiter {
  /** Charges one request and `cost` tokens to the key's two buckets, or neither. Never throws. */
  take(keyId: string, rpm: number, tpm: number, cost: number): Promise<TakeResult>;
  /** Moves the token bucket by `delta` (positive refunds, negative debits). Never throws. */
  adjust(keyId: string, tpm: number, delta: number): Promise<void>;
}

export interface LimiterOptions {
  redis: Redis;
  keyPrefix: string;
  /** A Redis answer slower than this counts as an outage for that request. */
  timeoutMs: number;
  log?: { warn(obj: object, msg: string): void; info(obj: object, msg: string): void };
  /**
   * Pins the clock the script uses, in ms. Production leaves it unset so the script reads Redis TIME,
   * which every gateway instance shares; tests pin it so a slow machine cannot refill a bucket mid-burst.
   */
  clock?: () => number;
}

type Commands = Redis & {
  rlTake(k1: string, k2: string, ...args: Array<string | number>): Promise<number[]>;
  rlAdjust(k: string, ...args: Array<string | number>): Promise<number>;
};

class RedisTimeout extends Error {
  override name = 'RedisTimeout';
}

export function createLimiter(opts: LimiterOptions): Limiter {
  const { redis, keyPrefix, timeoutMs, log, clock } = opts;
  redis.defineCommand('rlTake', { numberOfKeys: 2, lua: TAKE_LUA });
  redis.defineCommand('rlAdjust', { numberOfKeys: 1, lua: ADJUST_LUA });
  const cmd = redis as Commands;

  // The hash tag {keyId} puts both buckets of a key in one Redis Cluster slot.
  const keys = (keyId: string) => [`${keyPrefix}rl:{${keyId}}:req`, `${keyPrefix}rl:{${keyId}}:tok`] as const;

  // One warn when Redis stops answering, one info when it answers again; nothing in between.
  let down = false;
  const failed = (err: unknown) => {
    // A client that has not finished its first connection is connecting, not down.
    if (isStarting(redis) || down) return;
    down = true;
    log?.warn(
      { errClass: (err as Error).name, code: (err as { code?: string }).code },
      'redis unavailable, rate limiting is off until it answers again',
    );
  };
  const ok = () => {
    if (!down) return;
    down = false;
    log?.info({}, 'redis available again, rate limiting resumed');
  };

  const withTimeout = <T>(p: Promise<T>): Promise<T> =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new RedisTimeout('no reply in time')), timeoutMs);
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

  return {
    async take(keyId, rpm, tpm, cost) {
      const [kReq, kTok] = keys(keyId);
      const args: Array<string | number> = [rpm, tpm, cost];
      if (clock) args.push(clock());
      let call: Promise<number[]> | undefined;
      try {
        call = cmd.rlTake(kReq, kTok, ...args);
        const r = await withTimeout(call);
        ok();
        const [allowed, remReq, remTok, wait, resetReq, resetTok, short] = r as [
          number, number, number, number, number, number, number,
        ];
        const buckets: Buckets = {
          requests: { limit: rpm, remaining: remReq, resetMs: resetReq },
          tokens: { limit: tpm, remaining: remTok, resetMs: resetTok },
        };
        if (allowed === 1) return { status: 'allowed', buckets };
        return { status: 'denied', buckets, retryAfterMs: wait, limited: short === 2 ? 'tokens' : 'requests' };
      } catch (err) {
        failed(err);
        // The request is served unlimited, but Redis may still run the script. If it does and admits the
        // request, the charge is taken for a request that was never counted against the key: hand it back.
        if (err instanceof RedisTimeout && call !== undefined) {
          call.then(
            (late) => {
              if (late[0] === 1) void refundBoth();
            },
            () => {}, // the command failed, so nothing was charged
          );
        }
        return { status: 'skipped' };
      }

      async function refundBoth(): Promise<void> {
        try {
          const extra: Array<string | number> = clock ? [clock()] : [];
          await Promise.all([cmd.rlAdjust(kReq, rpm, 1, ...extra), cmd.rlAdjust(kTok, tpm, cost, ...extra)]);
        } catch (err) {
          failed(err);
        }
      }
    },

    async adjust(keyId, tpm, delta) {
      if (delta === 0) return;
      try {
        const args: Array<string | number> = [tpm, delta];
        if (clock) args.push(clock());
        await withTimeout(cmd.rlAdjust(keys(keyId)[1], ...args));
        ok();
      } catch (err) {
        failed(err);
      }
    },
  };
}
