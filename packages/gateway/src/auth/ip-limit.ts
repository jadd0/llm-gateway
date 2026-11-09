import { readFileSync } from 'node:fs';
import { isIPv6 } from 'node:net';
import type { Redis } from 'ioredis';
import { isStarting } from '../redis.ts';

// The same two scripts as the per-key limiter: a conditional take and a bounded adjust.
const TAKE_LUA = readFileSync(new URL('../ratelimit/token-bucket.lua', import.meta.url), 'utf8');
const ADJUST_LUA = readFileSync(new URL('../ratelimit/token-bucket-adjust.lua', import.meta.url), 'utf8');

export type IpAdmit =
  | { status: 'allowed' }
  | { status: 'denied'; retryAfterMs: number }
  /** Redis could not answer in time: the request goes on to the key check, unlimited. */
  | { status: 'skipped' };

export interface IpLimiter {
  /**
   * Charges one failed-authentication token to the client's bucket, or says the bucket is empty. Called
   * before the key is looked up, so a refused client costs no Postgres query. Never throws.
   */
  admit(ip: string, now?: number): Promise<IpAdmit>;
  /** Hands the token back once the key turned out valid, so only failed authentications count. Never throws. */
  succeeded(ip: string, now?: number): Promise<void>;
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
  ipTake(k1: string, k2: string, ...args: Array<string | number>): Promise<number[]>;
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
  redis.defineCommand('ipTake', { numberOfKeys: 2, lua: TAKE_LUA });
  redis.defineCommand('ipAdjust', { numberOfKeys: 1, lua: ADJUST_LUA });
  const cmd = redis as Commands;
  // The bucket lives in the request-bucket key; the script's token bucket is charged nothing.
  const keys = (ip: string) => [`${keyPrefix}ipfail:{${ipBucketId(ip)}}:req`, `${keyPrefix}ipfail:{${ipBucketId(ip)}}:tok`] as const;

  let down = false;
  const failed = (err: unknown) => {
    if (isStarting(redis) || down) return;
    down = true;
    log?.warn(
      { errClass: (err as Error).name, code: (err as { code?: string }).code },
      'redis unavailable, per-address limiting of failed authentications is off until it answers again',
    );
  };
  const ok = () => {
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

  const refund = async (ip: string, now?: number): Promise<void> => {
    const [kReq] = keys(ip);
    const at = now ?? clock?.();
    await withTimeout(cmd.ipAdjust(kReq, limitPerMin, 1, ...(at === undefined ? [] : [at])));
  };

  return {
    async admit(ip, now) {
      const [kReq, kTok] = keys(ip);
      const at = now ?? clock?.();
      let call: Promise<number[]> | undefined;
      try {
        call = cmd.ipTake(kReq, kTok, limitPerMin, 1, 0, ...(at === undefined ? [] : [at]));
        const r = await withTimeout(call);
        ok();
        if (r[0] === 1) return { status: 'allowed' };
        return { status: 'denied', retryAfterMs: r[3] ?? 0 };
      } catch (err) {
        failed(err);
        // A take the script still runs after we gave up would charge a request we let through: hand it back.
        if (err instanceof RedisTimeout && call !== undefined) {
          call.then(
            (late) => {
              if (late[0] === 1) void refund(ip).catch(() => {});
            },
            () => {},
          );
        }
        return { status: 'skipped' };
      }
    },

    async succeeded(ip, now) {
      try {
        await refund(ip, now);
        ok();
      } catch (err) {
        failed(err);
      }
    },
  };
}
