import { replyWithin } from '../redis.ts';
import type { CachedCompletion } from '../cache/replay.ts';
import type { CacheStore, Lookup } from '../cache/store.ts';
import type { Embedder } from './embedder.ts';
import type { SemanticSplit } from './context.ts';
import type { SemanticStore } from './store.ts';

export interface SemanticHit {
  entry: CachedCompletion;
  /** Cosine similarity of the served prompt to the request's, at most 1. */
  similarity: number;
}

export interface SemanticLookup {
  /**
   * After an exact miss: the cached answer of the stored prompt nearest to this one, if it is close enough.
   * Never throws; anything that goes wrong (no embedding in time, Postgres slow or down, Redis down) is a miss
   * or `unavailable`, and the request goes on to the provider.
   */
  find(scope: string, split: SemanticSplit): Promise<Lookup<SemanticHit>>;
}

export interface SemanticLookupOptions {
  embedder: Embedder;
  store: SemanticStore;
  /** Where the answers are: the response cache, read by the key a row names. */
  cache: Pick<CacheStore, 'get'>;
  threshold: number;
  /** false: only a vector made by the same model as the query's is a candidate. */
  crossModel: boolean;
  /** A last user message longer than this is not looked up. */
  maxChars: number;
  /** Time allowed for the nearest-neighbour query. */
  pgTimeoutMs: number;
  /** Unix ms. Expiry is judged on this clock, the one that wrote `expires_at`. */
  clock?: () => number;
  log?: { warn(obj: object, msg: string): void; info(obj: object, msg: string): void };
}

class Slow extends Error {
  override name = 'SemanticQueryTimeout';
}

const errInfo = (err: unknown) => ({ errClass: (err as Error)?.name, code: (err as { code?: string })?.code });

export function createSemanticLookup(opts: SemanticLookupOptions): SemanticLookup {
  const now = opts.clock ?? Date.now;
  let down = false;
  const failed = (err: unknown) => {
    if (down) return;
    down = true;
    opts.log?.warn({ ...errInfo(err), op: 'nearest' }, 'semantic lookup failed, skipping the semantic step');
  };
  const answered = () => {
    if (!down) return;
    down = false;
    opts.log?.info({}, 'semantic lookup working again');
  };

  return {
    async find(scope, split) {
      if (split.text.length > opts.maxChars) return { status: 'miss' };
      const embedded = await opts.embedder.embed(split.text);
      if (!embedded) return { status: 'unavailable' };

      let near;
      try {
        near = await replyWithin(
          opts.store.nearest({
            scope,
            contextHash: split.contextHash,
            embedding: embedded.vector,
            now: new Date(now()),
            ...(opts.crossModel ? {} : { embedder: embedded.embedder }),
          }),
          opts.pgTimeoutMs,
          () => new Slow(),
        );
      } catch (err) {
        failed(err);
        return { status: 'unavailable' };
      }
      answered();
      if (!near || near.similarity < opts.threshold) return { status: 'miss' };

      const found = await opts.cache.get(near.exactKey);
      if (found.status === 'unavailable') return { status: 'unavailable' };
      if (found.status === 'miss') {
        // The answer is gone (evicted, expired, replaced by something unreadable): the row points at nothing.
        await opts.store.remove(near.id).catch((err: unknown) => opts.log?.warn({ ...errInfo(err), op: 'remove' }, 'semantic row could not be removed'));
        return { status: 'miss' };
      }
      return { status: 'hit', entry: { entry: found.entry, similarity: Math.min(1, near.similarity) } };
    },
  };
}
