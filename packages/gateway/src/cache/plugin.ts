import { randomUUID } from 'node:crypto';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { chatRequest } from '../request-body.ts';
import type { Usage } from '../usage/sse-usage.ts';
import { cacheKey, isCacheable, normalise, scopeOf } from './key.ts';
import { replayBody, replayStream, type CachedCompletion } from './replay.ts';
import type { SingleFlight } from './single-flight.ts';
import type { CacheStore } from './store.ts';

/** What the route needs to put its answer in the cache once it has one. */
export interface CacheFill {
  /** The largest answer worth collecting (bytes of its stored JSON). */
  readonly maxEntryBytes: number;
  /** Writes the answer, then lets identical requests that are waiting for it go. Never throws. Only the first call counts. */
  store(entry: CachedCompletion): Promise<void>;
  /** Nothing is going to be stored: waiting identical requests go upstream. A no-op once `store` has begun. */
  abandon(): void;
}

/** A hit, as the ledger needs it. */
export interface CacheHit {
  /** The request that was answered from the cache: the ledger row's saving is noted on its log entry. */
  request?: FastifyRequest;
  tenantId: string;
  /** The model that served the answer the first time. */
  model: string;
  usage: Usage | null;
}

declare module 'fastify' {
  interface FastifyRequest {
    /** Set when this request's answer should be cached once the provider has served it; null otherwise. */
    cacheFill: CacheFill | null;
  }
  interface FastifyContextConfig {
    /** A route opts in to the response cache with `config: { cached: true }`. */
    cached?: boolean;
  }
  interface FastifyInstance {
    /** Present when budgets are on: writes the zero-cost ledger row for a hit. */
    recordCacheHit?: (hit: CacheHit) => Promise<void>;
  }
}

export interface CachePluginOptions {
  store: CacheStore;
  singleFlight: SingleFlight;
  /** Redis key prefix. */
  keyPrefix: string;
  /** The output limit a translating provider (Anthropic, Gemini) is given when the request names none: part of the key for those. */
  defaultMaxTokens: number;
  allowNondeterministic: boolean;
  maxEntryBytes: number;
  replayChunkChars: number;
  /** The provider a model name is served by, or undefined when none is: an unroutable name is the route's 400, not a cache question. */
  resolve(model: string): { translates: boolean } | undefined;
  /** Unix ms. Pins `created` of a replayed reply. Tests only. */
  clock?: () => number;
}

const cachePlugin: FastifyPluginAsync<CachePluginOptions> = async (app, opts) => {
  app.decorateRequest('cacheFill', null);
  app.addHook('onClose', () => opts.singleFlight.close());
  const now = opts.clock ?? Date.now;

  // preHandler, after the rate limiter and before the budget: the caller is known and has been admitted, and a
  // hit never reaches the budget or the provider.
  app.addHook('preHandler', async (request, reply) => {
    if (!request.routeOptions.config.cached || request.tenant === null) return;
    const tenant = request.tenant;
    const checked = chatRequest(request);
    const provider = checked.ok ? opts.resolve(checked.value.model) : undefined;
    if (!checked.ok || !provider) return void reply.header('x-gateway-cache', 'uncacheable');
    const body = checked.value as Record<string, unknown>;

    // Opt-outs are the client's: no-store neither reads nor writes, no-cache skips the read and refreshes the entry.
    const directives = new Set(
      String(request.headers['cache-control'] ?? '')
        .toLowerCase()
        .split(',')
        .map((d) => d.trim()),
    );
    if (directives.has('no-store')) return void reply.header('x-gateway-cache', 'bypass');
    if (!isCacheable(body, { allowNondeterministic: opts.allowNondeterministic }).ok) {
      return void reply.header('x-gateway-cache', 'uncacheable');
    }

    const key = cacheKey(opts.keyPrefix, scopeOf(tenant), normalise(body, provider.translates ? opts.defaultMaxTokens : null));
    const lookup = () => opts.store.get(key);
    const refresh = directives.has('no-cache');
    const streamed = body.stream === true;
    const includeUsage = (body.stream_options as { include_usage?: unknown } | null | undefined)?.include_usage === true;

    if (!refresh) {
      const found = await lookup();
      if (found.status === 'unavailable') return void reply.header('x-gateway-cache', 'unavailable');
      if (found.status === 'hit') return hit(request, reply, found.entry, streamed, includeUsage);
    }

    // A miss. The first of several identical non-streamed misses leads; the rest wait for its fill. A stream
    // cannot be shared without holding it, so streamed misses neither lead nor wait.
    let leader: Extract<Awaited<ReturnType<SingleFlight['acquire']>>, { role: 'leader' }> | undefined;
    if (!streamed && !refresh) {
      const role = await opts.singleFlight.acquire(key);
      if (role.role === 'follower') {
        const entry = await role.wait(lookup);
        if (entry) return hit(request, reply, entry, streamed, includeUsage);
      } else if (role.role === 'leader') {
        leader = role;
      }
    }
    reply.header('x-gateway-cache', refresh ? 'refresh' : 'miss');

    let state: 'open' | 'storing' | 'ended' = 'open';
    const fill: CacheFill = {
      maxEntryBytes: opts.maxEntryBytes,
      async store(entry) {
        if (state !== 'open') return;
        state = 'storing';
        let written: Awaited<ReturnType<CacheStore['set']>> = 'unavailable';
        try {
          written = await opts.store.set(key, entry);
        } finally {
          state = 'ended';
          leader?.finish(written === 'stored' ? 'filled' : 'failed');
        }
      },
      abandon() {
        if (state !== 'open') return;
        state = 'ended';
        leader?.finish('failed');
      },
    };
    request.cacheFill = fill;
    // However the request ends (a refusal by a later hook, a client that left, an error) a leader is let go: its
    // fill is abandoned, and if that cannot be (a write is in flight) its lock stops being renewed.
    if (leader) {
      reply.raw.once('close', () => {
        fill.abandon();
        leader.closed();
      });
    }
  });

  // A hit: no provider, no budget hold. It counts as one request against the key's rpm and gives the token
  // estimate back; the ledger gets a zero-cost row with what it saved.
  function hit(request: FastifyRequest, reply: FastifyReply, entry: CachedCompletion, streamed: boolean, includeUsage: boolean) {
    void request.rateLimit?.settle(0);
    if (entry.usage) request.reqlog.note({ promptTokens: entry.usage.promptTokens, completionTokens: entry.usage.completionTokens });
    if (app.recordCacheHit) {
      void app.recordCacheHit({ request, tenantId: request.tenant!.tenantId, model: entry.model, usage: entry.usage }).catch(() => {});
    }
    const who = { id: `chatcmpl-cache-${randomUUID()}`, created: Math.floor(now() / 1000) };
    reply.header('x-gateway-cache', 'hit').header('x-gateway-model', entry.model).header('x-gateway-attempts', '0');
    if (streamed) {
      return reply
        .code(200)
        .header('content-type', 'text/event-stream')
        .header('cache-control', 'no-cache')
        .header('x-accel-buffering', 'no')
        .send(replayStream(entry, who, { chunkChars: opts.replayChunkChars, includeUsage }));
    }
    return reply.code(200).send(replayBody(entry, who));
  }
};

// Same effect as fastify-plugin: the hook applies to every route in the app.
export const responseCache = Object.assign(cachePlugin, { [Symbol.for('skip-override')]: true });
