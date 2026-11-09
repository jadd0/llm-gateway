import { randomUUID } from 'node:crypto';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { chatRequest } from '../request-body.ts';
import type { Usage } from '../usage/sse-usage.ts';
import { splitForSemantic } from '../semantic/context.ts';
import type { SemanticFill } from '../semantic/fill.ts';
import type { SemanticHit, SemanticLookup } from '../semantic/lookup.ts';
import { cacheKey, isCacheable, normalise, scopeOf } from './key.ts';
import { replayBody, replayStream, type CachedCompletion } from './replay.ts';
import type { SingleFlight } from './single-flight.ts';

/** What a leader hands its followers when a similar prompt served it: the entry's key and how close the prompt was. */
const sharedHit = (v: unknown): { exactKey: string; similarity: number } | undefined => {
  const r = v as { exactKey?: unknown; similarity?: unknown } | null | undefined;
  return typeof r?.exactKey === 'string' && typeof r.similarity === 'number' ? { exactKey: r.exactKey, similarity: r.similarity } : undefined;
};
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
  /** Which lookup found it. */
  kind: 'exact' | 'semantic';
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
  /** Present when the semantic cache is on: what runs after an exact miss and after an entry is stored. */
  semantic?: { lookup: SemanticLookup; fill: SemanticFill };
  /** How long a stored answer lives: a semantic row expires with it. */
  ttlS: number;
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

    const scope = scopeOf(tenant);
    const normalised = normalise(body, provider.translates ? opts.defaultMaxTokens : null);
    const key = cacheKey(opts.keyPrefix, scope, normalised);
    // The semantic step needs the cache on for the app, the tenant and this request, and a request whose last
    // message is plain user text. A request that opts out never has its prompt sent to an embedder.
    const semantic =
      opts.semantic && tenant.semanticCache && String(request.headers['x-gateway-semantic'] ?? '').trim().toLowerCase() !== 'off'
        ? splitForSemantic(normalised)
        : undefined;
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
    let state: 'open' | 'storing' | 'ended' = 'open';
    const fill: CacheFill = {
      maxEntryBytes: opts.maxEntryBytes,
      async store(entry) {
        if (state !== 'open') return;
        state = 'storing';
        let written: Awaited<ReturnType<CacheStore['set']>> = 'unavailable';
        try {
          written = await opts.store.set(key, entry);
          // Queued, not awaited: the embedding happens after this request is done with.
          if (written === 'stored' && semantic) opts.semantic!.fill.enqueue({ scope, split: semantic, exactKey: key, ttlS: opts.ttlS });
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
    if (!streamed && !refresh) {
      const role = await opts.singleFlight.acquire(key);
      if (role.role === 'leader') {
        leader = role;
        // Registered before anything else is awaited (the semantic lookup below can take a while): however the
        // request ends (a refusal by a later hook, a client that left, an error) a leader is let go. Its fill is
        // abandoned, and if that cannot be (a write is in flight) its lock stops being renewed.
        reply.raw.once('close', () => {
          fill.abandon();
          role.closed();
        });
      } else if (role.role === 'follower') {
        const entry = await role.wait(lookup);
        if (entry) return hit(request, reply, entry, streamed, includeUsage);
        // The leader may have been served by a similar prompt instead (in this process or another). That is
        // shared only with a follower that is itself on the semantic cache; nothing is written under the exact
        // key, where a request that opted out, or a tenant that is off, would read it as an exact answer.
        const shared = semantic ? sharedHit(await role.shared()) : undefined;
        if (shared) {
          const found = await opts.store.get(shared.exactKey);
          if (found.status === 'hit') return hit(request, reply, found.entry, streamed, includeUsage, shared.similarity);
        }
      }
    }
    // After an exact miss: the semantic lookup. A follower whose leader shared a semantic answer was served above;
    // any other request that is going upstream (the leader, a request that cannot lead, a follower whose leader
    // failed, lives in another process or timed out) looks for itself, so a similar answer is never passed over.
    // Anything but a hit (no embedding in time, Postgres or Redis slow, a guard that refused the nearest prompt)
    // is a plain miss.
    let refusedBy: string | undefined;
    if (semantic && !refresh) {
      const near = await opts.semantic!.lookup.find(scope, semantic);
      if (near.status === 'hit') {
        // Followers of this flight are told which entry served it, so they need not ask again.
        leader?.finish('failed', { exactKey: near.entry.exactKey, similarity: near.entry.similarity });
        return hit(request, reply, near.entry.entry, streamed, includeUsage, near.entry.similarity);
      }
      if (near.status === 'miss') refusedBy = near.guard;
    }
    if (refusedBy) reply.header('x-gateway-semantic-guard', refusedBy);
    reply.header('x-gateway-cache', refresh ? 'refresh' : 'miss');
    request.cacheFill = fill;
  });

  // A hit: no provider, no budget hold. It counts as one request against the key's rpm and gives the token
  // estimate back; the ledger gets a zero-cost row with what it saved.
  function hit(request: FastifyRequest, reply: FastifyReply, entry: CachedCompletion, streamed: boolean, includeUsage: boolean, similarity?: number) {
    const kind: CacheHit['kind'] = similarity === undefined ? 'exact' : 'semantic';
    void request.rateLimit?.settle(0);
    if (entry.usage) request.reqlog.note({ promptTokens: entry.usage.promptTokens, completionTokens: entry.usage.completionTokens });
    if (app.recordCacheHit) {
      void app.recordCacheHit({ request, tenantId: request.tenant!.tenantId, model: entry.model, usage: entry.usage, kind }).catch(() => {});
    }
    const who = { id: `chatcmpl-cache-${randomUUID()}`, created: Math.floor(now() / 1000) };
    reply.header('x-gateway-cache', kind === 'semantic' ? 'semantic-hit' : 'hit').header('x-gateway-model', entry.model).header('x-gateway-attempts', '0');
    if (similarity !== undefined) reply.header('x-gateway-similarity', similarity.toFixed(3));
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
