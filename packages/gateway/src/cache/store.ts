import type { Redis } from 'ioredis';
import { isStarting } from '../redis.ts';
import type { CachedCompletion } from './replay.ts';

export type Lookup = { status: 'hit'; entry: CachedCompletion } | { status: 'miss' } | { status: 'unavailable' };
export type Written = 'stored' | 'too-large' | 'unavailable';

export interface CacheStore {
  /** Never throws. A Redis that is down, or slower than the timeout, is `unavailable`. */
  get(key: string): Promise<Lookup>;
  /** Never throws. An entry whose JSON is over the size cap is not written. */
  set(key: string, entry: CachedCompletion): Promise<Written>;
}

export interface CacheStoreOptions {
  redis: Redis;
  ttlS: number;
  maxEntryBytes: number;
  timeoutMs: number;
  log?: { warn(obj: object, msg: string): void; info(obj: object, msg: string): void };
}

class Slow extends Error {
  override name = 'CacheRedisTimeout';
}

/** Resolves with the promise, or rejects `Slow` after `ms`. The late reply of a slow command is dropped. */
export function within<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Slow()), ms);
  });
  p.catch(() => {}); // a command that fails after the timeout has nobody left to tell
  return Promise.race([p, late]).finally(() => clearTimeout(timer));
}

const parse = (raw: string): CachedCompletion | undefined => {
  try {
    const v = JSON.parse(raw) as Partial<CachedCompletion> | null;
    if (typeof v?.content !== 'string' || typeof v.model !== 'string') return undefined;
    if (v.finishReason !== 'stop' && v.finishReason !== 'length') return undefined;
    const u = v.usage;
    if (u !== null && (typeof u !== 'object' || [u.promptTokens, u.completionTokens, u.totalTokens].some((n) => typeof n !== 'number'))) return undefined;
    return { content: v.content, finishReason: v.finishReason, usage: u ?? null, model: v.model };
  } catch {
    return undefined;
  }
};

export function createCacheStore(opts: CacheStoreOptions): CacheStore {
  // One warning when Redis stops answering and one note when it does again, not one per request.
  let down = false;
  const failed = (op: 'get' | 'set', err: unknown) => {
    if (isStarting(opts.redis) || down) return;
    down = true;
    opts.log?.warn({ errClass: (err as Error).name, code: (err as { code?: string }).code, op }, 'redis unavailable, response cache skipped');
  };
  const answered = () => {
    if (!down) return;
    down = false;
    opts.log?.info({}, 'redis available again, response cache back');
  };

  return {
    async get(key) {
      let raw: string | null;
      try {
        raw = await within(opts.redis.get(key), opts.timeoutMs);
      } catch (err) {
        failed('get', err);
        return { status: 'unavailable' };
      }
      answered();
      if (raw === null) return { status: 'miss' };
      const entry = parse(raw);
      return entry ? { status: 'hit', entry } : { status: 'miss' };
    },

    async set(key, entry) {
      const json = JSON.stringify(entry);
      if (Buffer.byteLength(json) > opts.maxEntryBytes) return 'too-large';
      try {
        await within(opts.redis.set(key, json, 'EX', opts.ttlS), opts.timeoutMs);
      } catch (err) {
        failed('set', err);
        return 'unavailable';
      }
      answered();
      return 'stored';
    },
  };
}
