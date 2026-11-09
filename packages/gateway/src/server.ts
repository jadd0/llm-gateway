import { buildApp } from './app.ts';
import { loadConfig } from './config.ts';

const config = loadConfig();
const app = buildApp(config);

let closing = false;
const shutdown = (signal: string) => {
  if (closing) return;
  closing = true;
  app.log.warn({ signal }, 'shutting down');
  app.close().then(
    () => process.exit(0),
    () => process.exit(1),
  );
};
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

await app.listen({ port: config.port, host: '0.0.0.0' });
console.log(`gateway on http://0.0.0.0:${config.port} -> ${config.upstreamBaseUrl}`);
