import { readFileSync } from 'node:fs';
import { isIPv6 } from 'node:net';
import type { Redis } from 'ioredis';
import { isStarting, replyWithin } from '../redis.ts';
import type { PostgresGuard } from './key-store.ts';

// The per-key limiter's bounded-adjust script, used here to hand a token back (delta +1, capped at capacity).
const ADJUST_LUA = readFileSync(new URL('../ratelimit/token-bucket-adjust.lua', import.meta.url), 'utf8');
const TAKE_LUA = readFileSync(new URL('./ip-take.lua', import.meta.url), 'utf8');

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

export interface IpLimiter {
  /**
   * Takes one token from the client's bucket, atomically, or refuses when it holds none. A token taken
   * for a key that then proves valid is handed back through the result's refund(), so only failed
   * authentications cost anything. When Redis cannot answer in time the request goes on unlimited.
   * Never throws.
   */
  take(ip: string, now?: number): ReturnType<PostgresGuard>;
}

type Commands = Redis & {
  ipAdjust(k: string, ...args: Array<string | number>): Promise<number>;
  ipTake(k: string, ...args: Array<string | number>): Promise<[number, number]>;
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
  redis.defineCommand('ipTake', { numberOfKeys: 1, lua: TAKE_LUA });
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

  const withTimeout = <T>(p: Promise<T>): Promise<T> => replyWithin(p, timeoutMs, () => new RedisTimeout('no reply in time'));

  const at = (now?: number) => now ?? clock?.();

  const refund = async (ip: string, now?: number): Promise<void> => {
    try {
      const t = at(now);
      await withTimeout(cmd.ipAdjust(key(ip), limitPerMin, 1, ...(t === undefined ? [] : [t])));
      recovered();
    } catch (err) {
      outage(err);
    }
  };

  return {
    async take(ip: string, now?: number) {
      let call: Promise<[number, number]> | undefined;
      try {
        const t = at(now);
        call = cmd.ipTake(key(ip), limitPerMin, ...(t === undefined ? [] : [t]));
        const [taken, waitMs] = await withTimeout(call);
        recovered();
        if (taken === 1) return { refused: false, refund: () => refund(ip, now) };
        return { refused: true, retryAfterMs: waitMs };
      } catch (err) {
        outage(err);
        // The request goes on unlimited, but Redis may still run the script and take a token for a request
        // that was never counted: hand it back.
        if (err instanceof RedisTimeout && call !== undefined) {
          call.then(
            (late) => {
              if (late[0] === 1) void refund(ip, now);
            },
            () => {}, // the command failed, so nothing was taken
          );
        }
        return { refused: false, refund: async () => {} };
      }
    },
  };
}
