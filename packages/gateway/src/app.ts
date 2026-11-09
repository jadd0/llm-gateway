import Fastify, { LogController, type FastifyError, type FastifyInstance } from 'fastify';
import { auth } from './auth/plugin.ts';
import { keyStoreFromConfig } from './auth/key-store.ts';
import type { Config } from './config.ts';
import { createDb } from './db/client.ts';
import { errorBody } from './errors.ts';
import { chatRoutes } from './routes/chat.ts';
import { createRedis } from './redis.ts';
import { createUpstream } from './upstream.ts';

export function buildApp(
  config: Config,
  extra: { logStream?: NodeJS.WritableStream } = {},
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
  const redis = config.authCache === 'redis' && config.redisUrl ? createRedis(config.redisUrl) : null;
  const keyStore = keyStoreFromConfig(config, handle.db, redis, app.log);
  app.addHook('onClose', async () => {
    // Close everything even if one close fails.
    redis?.disconnect();
    await Promise.allSettled([upstream.close(), handle.close()]);
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
  app.register(chatRoutes, { upstream });
  return app;
}
