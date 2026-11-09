import { buildApp } from './app.ts';
import { loadConfig } from './config.ts';
import { describeProviders } from './upstream.ts';

const config = loadConfig();
const app = buildApp(config);

let closing = false;
const shutdown = (signal: string) => {
  if (closing) return;
  closing = true;
  app.log.warn({ signal }, 'shutting down');
  // Stops accepting, lets in-flight requests finish, sends the request-log entries still buffered, then exits.
  app.close().then(
    () => process.exit(0),
    () => process.exit(1),
  );
};
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

await app.listen({ port: config.port, host: config.host });
const providers = describeProviders(config)
  .map((p) => `${p.provider} ${p.baseUrl}${p.configured ? '' : ' (no key)'}`)
  .join(', ');
console.log(`gateway on http://${config.host}:${config.port}; providers: ${providers}; request log: ${config.logMode}`);
