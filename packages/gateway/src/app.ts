import { randomUUID } from 'node:crypto';
import Fastify, { LogController, type FastifyError, type FastifyInstance } from 'fastify';
import { auth } from './auth/plugin.ts';
import { keyStoreFromConfig } from './auth/key-store.ts';
import { createIpLimiter } from './auth/ip-limit.ts';
import type { Config } from './config.ts';
import { createDb } from './db/client.ts';
import type { PgLedger } from './budget/pg-ledger.ts';
import { budgetGuard } from './budget/plugin.ts';
import { errorBody } from './errors.ts';
import { responseCache } from './cache/plugin.ts';
import { createSingleFlight } from './cache/single-flight.ts';
import { createCacheStore, type CacheStore } from './cache/store.ts';
import { createLimiter } from './ratelimit/limiter.ts';
import { rateLimit } from './ratelimit/plugin.ts';
import { chatRoutes } from './routes/chat.ts';
import { createRedis } from './redis.ts';
import { createBreaker, probeLockTtlMs, type Breaker } from './resilience/breaker.ts';
import { chainFor } from './resilience/fallback.ts';
import { requestLogCollector } from './requestlog/collector.ts';
import { createInlineSink } from './requestlog/inline-sink.ts';
import { createStreamSink, nullSink } from './requestlog/sink.ts';
import { createUpstream } from './upstream.ts';

export function buildApp(
  config: Config,
  extra: {
    logStream?: NodeJS.WritableStream;
    /** Pins the rate limiter's clock (ms). Tests only: production reads Redis TIME. */
    rateLimitClock?: () => number;
    /** Pins the budget's clock (ms): the month it charges and the Redis scripts' expiry clock. Tests only. */
    budgetClock?: () => number;
    /** Replaces the budget's Postgres ledger. Tests only. */
    budgetPgLedger?: PgLedger;
    /** Pins the circuit breaker's clock (ms). Tests only: production reads Redis TIME. */
    breakerClock?: () => number;
    /** Wraps the circuit breaker. Tests only. */
    wrapBreaker?: (breaker: Breaker) => Breaker;
    /** Wraps the response cache's store. Tests only. */
    wrapCacheStore?: (store: CacheStore) => CacheStore;
    /** Pins the `created` time of a replayed cache hit (ms). Tests only. */
    cacheClock?: () => number;
    /** How long a client of a deadline-cut stream gets to take the last bytes. Tests only. */
    cutDrainMs?: number;
  } = {},
): FastifyInstance {
  const app = Fastify({
    logger: { level: config.logLevel, ...(extra.logStream ? { stream: extra.logStream } : {}) },
    // Nothing logs per request on the hot path.
    logController: new LogController({ disableRequestLogging: true }),
    bodyLimit: 10 * 1024 * 1024,
    // A uuid per request: the primary key of its log row and the id of its budget hold.
    genReqId: () => randomUUID(),
    // X-Forwarded-For is believed only when the socket peer is one of these; otherwise request.ip is the peer.
    trustProxy: config.trustedProxies.length > 0 ? config.trustedProxies : false,
  });
  const upstream = createUpstream(config);
  // The app owns its Postgres pool and Redis client and closes them with itself.
  const handle = createDb({ databaseUrl: config.databaseUrl, poolSize: config.dbPoolSize });
  // One client serves the key cache and the rate limiter. Its command timeout covers the limiter's
  // own timeout, so the limiter decides when to give up, not the socket.
  // The circuit breaker is always on and shares its state through Redis, so a configured Redis is always used.
  const useRedis = config.redisUrl !== undefined;
  const redis = useRedis
    ? createRedis(config.redisUrl!, {
        commandTimeoutMs: Math.max(500, config.rateLimitRedisTimeoutMs, config.budgetRedisTimeoutMs, config.breakerRedisTimeoutMs, config.cacheRedisTimeoutMs),
      })
    : null;
  const ipLimiter =
    redis !== null && config.authFailLimitPerMin > 0
      ? createIpLimiter({
          redis,
          keyPrefix: config.redisKeyPrefix,
          limitPerMin: config.authFailLimitPerMin,
          timeoutMs: config.rateLimitRedisTimeoutMs,
          log: app.log,
          ...(extra.rateLimitClock ? { clock: extra.rateLimitClock } : {}),
        })
      : undefined;
  const keyStore = keyStoreFromConfig(
    config,
    handle.db,
    config.authCache === 'redis' ? redis : null,
    app.log,
    ipLimiter ? (ip) => ipLimiter.take(ip) : undefined,
  );
  // Request-log entries go to the Redis stream, or (the benchmark's "before") straight to Postgres.
  const logSink =
    config.logMode === 'inline'
      ? createInlineSink(handle.db, app.log)
      : redis !== null
        ? createStreamSink({ redis, keyPrefix: config.redisKeyPrefix, bufferMax: config.logBufferMax, log: app.log })
        : nullSink;
  app.addHook('onClose', async () => {
    // Entries still being built, in flight or buffered are sent before Redis is let go.
    await app.requestLogIdle().catch(() => {});
    await logSink.close().catch((err: unknown) => {
      app.log.error({ errClass: (err as Error)?.name, code: (err as { code?: string })?.code }, 'request log close failed');
    });
    // Close everything even if one close fails.
    redis?.disconnect();
    const closed = await Promise.allSettled([upstream.close(), handle.close()]);
    for (const r of closed) {
      if (r.status === 'rejected') {
        app.log.error({ errClass: (r.reason as Error)?.name, code: (r.reason as { code?: string })?.code }, 'close failed');
      }
    }
  });
  // Fastify's own request errors (unsupported content-type, oversized body) and unknown routes
  // use the OpenAI error shape too.
  app.setErrorHandler((err: FastifyError, _request, reply) => {
    const status = typeof err.statusCode === 'number' ? err.statusCode : 500;
    reply.log.warn({ errClass: err.name, code: err.code }, 'request error');
    if (status >= 400 && status < 500) {
      const message =
        status === 415 ? 'content-type must be application/json' : 'request could not be processed';
      return reply.code(status).send(errorBody(message, 'invalid_request_error'));
    }
    return reply.code(500).send(errorBody('internal error', 'gateway_error'));
  });
  app.setNotFoundHandler((_request, reply) =>
    reply.code(404).send(errorBody('unknown route', 'invalid_request_error')),
  );
  // First, so that every request, a refused one included, is logged.
  app.register(requestLogCollector, { sink: logSink, mode: config.logMode });
  app.register(auth, { keyStore, pepper: config.apiKeyPepper, ...(ipLimiter ? { ipLimiter } : {}) });
  if (config.rateLimitEnabled && redis !== null) {
    const limiter = createLimiter({
      redis,
      keyPrefix: config.redisKeyPrefix,
      timeoutMs: config.rateLimitRedisTimeoutMs,
      log: app.log,
      ...(extra.rateLimitClock ? { clock: extra.rateLimitClock } : {}),
    });
    app.register(rateLimit, {
      limiter,
      defaultRpm: config.rateLimitDefaultRpm,
      defaultTpm: config.rateLimitDefaultTpm,
      defaultMaxTokens: config.rateLimitDefaultMaxTokens,
    });
  }
  // After the rate limiter, before the budget: an answer already in the cache costs nothing, so it is served
  // without a hold, even to a tenant whose budget is spent.
  if (config.cacheEnabled && redis !== null) {
    app.register(responseCache, {
      store: (extra.wrapCacheStore ?? ((s: CacheStore) => s))(
        createCacheStore({
          redis,
          ttlS: config.cacheTtlS,
          maxEntryBytes: config.cacheMaxEntryBytes,
          timeoutMs: config.cacheRedisTimeoutMs,
          log: app.log,
        }),
      ),
      singleFlight: createSingleFlight({
        redis,
        lockMs: config.cacheLockMs,
        waitMs: config.cacheWaitMs,
        pollMs: config.cachePollMs,
        timeoutMs: config.cacheRedisTimeoutMs,
        log: app.log,
      }),
      keyPrefix: config.redisKeyPrefix,
      defaultMaxTokens: config.rateLimitDefaultMaxTokens,
      allowNondeterministic: config.cacheAllowNondeterministic,
      maxEntryBytes: config.cacheMaxEntryBytes,
      replayChunkChars: config.cacheReplayChunkChars,
      resolve: (model) => {
        const target = upstream.resolve(model);
        return target ? { translates: target.adapter.translates } : undefined;
      },
      ...(extra.cacheClock ? { clock: extra.cacheClock } : {}),
    });
  }
  // After the rate limiter: a request over its limits is refused before any money is held for it.
  if (config.budgetEnabled && redis !== null) {
    app.register(budgetGuard, {
      budget: {
        db: handle.db,
        redis,
        keyPrefix: config.redisKeyPrefix,
        reservationTtlS: config.budgetReservationTtlS,
        redisTimeoutMs: config.budgetRedisTimeoutMs,
        epochRefreshMs: config.budgetEpochRefreshMs,
        outageFailures: config.budgetOutageFailures,
        ...(extra.budgetClock ? { clock: extra.budgetClock } : {}),
        ...(extra.budgetPgLedger ? { pgLedger: extra.budgetPgLedger } : {}),
      },
      defaultCapMicros: config.budgetDefaultMonthlyMicros,
      defaultMaxTokens: config.rateLimitDefaultMaxTokens,
      mockMaxOutputTokens: config.mockMaxOutputTokens,
      isRoutable: (model) => upstream.resolve(model) !== undefined,
      sendsNoOutputLimit: (model) => upstream.resolve(model)?.adapter.translates === false,
      chainFor: (model) => chainFor(config.modelFallbacks, model),
    });
  }
  // Shared in Redis when there is one, so every gateway process sees the same open or closed provider; each
  // process keeps its own in-memory breaker for as long as Redis cannot answer.
  const breaker = (extra.wrapBreaker ?? ((b: Breaker) => b))(createBreaker({
    redis,
    keyPrefix: config.redisKeyPrefix,
    settings: {
      windowMs: config.breakerWindowMs,
      minFailures: config.breakerMinFailures,
      failureRatio: config.breakerFailureRatio,
      openMs: config.breakerOpenMs,
    },
    redisTimeoutMs: config.breakerRedisTimeoutMs,
    // A probe that never reports back frees the breaker once the longest attempt it could be making has
    // lapsed, but never later than one cooldown.
    probeTtlMs: probeLockTtlMs(config.upstreamConnectTimeoutMs + config.upstreamHeadersTimeoutMs, config.breakerOpenMs),
    log: app.log,
    ...(extra.breakerClock ? { clock: extra.breakerClock } : {}),
  }));
  app.register(chatRoutes, {
    upstream,
    breaker,
    chains: config.modelFallbacks,
    retry: {
      maxAttempts: config.retryMaxAttemptsPerModel,
      baseMs: config.retryBaseMs,
      capMs: config.retryCapMs,
      retryAfterMaxMs: config.retryAfterMaxMs,
      minRemainingMs: config.retryMinRemainingMs,
    },
    maxDurationMs: config.upstreamMaxDurationMs,
    defaultMaxTokens: config.rateLimitDefaultMaxTokens,
    errorBodyTimeoutMs: config.upstreamErrorBodyTimeoutMs,
    errorBodyMaxBytes: config.upstreamErrorBodyMaxBytes,
    ...(extra.cutDrainMs ? { cutDrainMs: extra.cutDrainMs } : {}),
  });
  return app;
}
