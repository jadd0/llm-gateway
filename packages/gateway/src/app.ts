import Fastify, { LogController, type FastifyError, type FastifyInstance } from 'fastify';
import { auth } from './auth/plugin.ts';
import { keyStoreFromConfig } from './auth/key-store.ts';
import type { Config } from './config.ts';
import { createDb } from './db/client.ts';
import type { PgLedger } from './budget/pg-ledger.ts';
import { budgetGuard } from './budget/plugin.ts';
import { errorBody } from './errors.ts';
import { createLimiter } from './ratelimit/limiter.ts';
import { rateLimit } from './ratelimit/plugin.ts';
import { chatRoutes } from './routes/chat.ts';
import { createRedis } from './redis.ts';
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
    /** How long a client of a deadline-cut stream gets to take the last bytes. Tests only. */
    cutDrainMs?: number;
  } = {},
): FastifyInstance {
  const app = Fastify({
    logger: { level: config.logLevel, ...(extra.logStream ? { stream: extra.logStream } : {}) },
    // Nothing logs per request on the hot path.
    logController: new LogController({ disableRequestLogging: true }),
    bodyLimit: 10 * 1024 * 1024,
  });
  const upstream = createUpstream(config);
  // The app owns its Postgres pool and Redis client and closes them with itself.
  const handle = createDb({ databaseUrl: config.databaseUrl, poolSize: config.dbPoolSize });
  // One client serves the key cache and the rate limiter. Its command timeout covers the limiter's
  // own timeout, so the limiter decides when to give up, not the socket.
  const useRedis =
    config.redisUrl !== undefined && (config.authCache === 'redis' || config.rateLimitEnabled || config.budgetEnabled);
  const redis = useRedis
    ? createRedis(config.redisUrl!, {
        commandTimeoutMs: Math.max(500, config.rateLimitRedisTimeoutMs, config.budgetRedisTimeoutMs),
      })
    : null;
  const keyStore = keyStoreFromConfig(config, handle.db, config.authCache === 'redis' ? redis : null, app.log);
  app.addHook('onClose', async () => {
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
  app.register(auth, { keyStore, pepper: config.apiKeyPepper });
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
        sweepIntervalS: config.budgetSweepIntervalS,
        ...(extra.budgetClock ? { clock: extra.budgetClock } : {}),
        ...(extra.budgetPgLedger ? { pgLedger: extra.budgetPgLedger } : {}),
      },
      defaultCapMicros: config.budgetDefaultMonthlyMicros,
      defaultMaxTokens: config.rateLimitDefaultMaxTokens,
    });
  }
  app.register(chatRoutes, {
    upstream,
    maxDurationMs: config.upstreamMaxDurationMs,
    ...(extra.cutDrainMs ? { cutDrainMs: extra.cutDrainMs } : {}),
  });
  return app;
}
