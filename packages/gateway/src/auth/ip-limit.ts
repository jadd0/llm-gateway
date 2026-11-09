import { readFileSync } from 'node:fs';
import { isIPv6 } from 'node:net';
import type { Redis } from 'ioredis';
import { isStarting } from '../redis.ts';

// The per-key limiter's bounded-adjust script: delta 0 reads the bucket (after refill), -1 charges a failure.
const ADJUST_LUA = readFileSync(new URL('../ratelimit/token-bucket-adjust.lua', import.meta.url), 'utf8');

export type IpAdmit =
  | { status: 'allowed' }
  | { status: 'denied'; retryAfterMs: number }
  /** Redis could not answer in time: the request goes on to the key check, unlimited. */
  | { status: 'skipped' };

export interface IpLimiter {
  /**
   * Whether the client's bucket still has a token. Read-only: a valid request is never charged, so a busy
   * legitimate client is not limited however many requests it has in flight. Called before the key is
   * looked up, so a refused client costs no Postgres query. Never throws.
   */
  admit(ip: string, now?: number): Promise<IpAdmit>;
  /** Charges one failed authentication. Never throws. */
  failed(ip: string, now?: number): Promise<void>;
}

export interface IpLimiterOptions {
  redis: Redis;
  keyPrefix: string;
  /** Failed authentications one address may make per minute. */
  limitPerMin: number;
  /** A Redis answer slower than this counts as an outage for that request. */
  timeoutMs: number;
  log?: { warn(obj: object, msg: string): void; info(obj: object, msg: string): void };
  /** Pins the scripts' clock in ms. Tests only: production reads Redis TIME. */
  clock?: () => number;
}

type Commands = Redis & {
  ipAdjust(k: string, ...args: Array<string | number>): Promise<number>;
};

class RedisTimeout extends Error {
  override name = 'RedisTimeout';
}

/**
 * One bucket per client. An IPv6 client owns a whole /64 (what one subscriber is routinely given), so
 * rotating the low 64 bits does not buy a fresh bucket.
 */
export function ipBucketId(ip: string): string {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  if (mapped) return mapped[1]!;
  if (!isIPv6(ip)) return ip;
  const [head = '', tail] = ip.split('::');
  const first = head === '' ? [] : head.split(':');
  const rest = tail === undefined || tail === '' ? [] : tail.split(':');
  const groups =
    tail === undefined ? first : [...first, ...Array<string>(Math.max(0, 8 - first.length - rest.length)).fill('0'), ...rest];
  return groups
    .slice(0, 4)
    .map((g) => g.toLowerCase().replace(/^0+(?=.)/, ''))
    .join(':')
    .concat('::/64');
}

export function createIpLimiter(opts: IpLimiterOptions): IpLimiter {
  const { redis, keyPrefix, limitPerMin, timeoutMs, log, clock } = opts;
  redis.defineCommand('ipAdjust', { numberOfKeys: 1, lua: ADJUST_LUA });
  const cmd = redis as Commands;
  const key = (ip: string) => `${keyPrefix}ipfail:{${ipBucketId(ip)}}`;

  let down = false;
  const outage = (err: unknown) => {
    if (isStarting(redis) || down) return;
    down = true;
    log?.warn(
      { errClass: (err as Error).name, code: (err as { code?: string }).code },
      'redis unavailable, per-address limiting of failed authentications is off until it answers again',
    );
  };
  const recovered = () => {
    if (!down) return;
    down = false;
    log?.info({}, 'redis available again, per-address limiting resumed');
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

  // Moves the bucket by delta and returns the whole tokens left (negative once failures outrun the refill).
  const move = (ip: string, delta: number, now?: number): Promise<number> => {
    const at = now ?? clock?.();
    return withTimeout(cmd.ipAdjust(key(ip), limitPerMin, delta, ...(at === undefined ? [] : [at])));
  };

  return {
    async admit(ip, now) {
      try {
        const left = await move(ip, 0, now);
        recovered();
        if (left >= 1) return { status: 'allowed' };
        // Time for the bucket to climb back to one token at limitPerMin tokens a minute.
        return { status: 'denied', retryAfterMs: Math.ceil(((1 - left) * 60_000) / limitPerMin) };
      } catch (err) {
        outage(err);
        return { status: 'skipped' };
      }
    },

    async failed(ip, now) {
      try {
        await move(ip, -1, now);
        recovered();
      } catch (err) {
        outage(err);
      }
    },
  };
}
