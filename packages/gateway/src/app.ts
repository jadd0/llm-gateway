import Fastify, { LogController, type FastifyInstance } from 'fastify';
import type { Config } from './config.ts';
import { chatRoutes } from './routes/chat.ts';
import { createUpstream } from './upstream.ts';

export function buildApp(config: Config): FastifyInstance {
  const app = Fastify({
    logger: { level: config.logLevel },
    // Nothing logs per request on the hot path.
    logController: new LogController({ disableRequestLogging: true }),
    bodyLimit: 10 * 1024 * 1024,
  });
  const upstream = createUpstream(config);
  app.addHook('onClose', async () => {
    await upstream.close();
  });
  app.register(chatRoutes, { upstream });
  return app;
}
