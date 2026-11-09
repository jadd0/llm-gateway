import { z } from 'zod';

// A blank value in an env file (`KEY=`) means "not set", so the default applies.
const blankAsUnset = (v: unknown) => (typeof v === 'string' && v.trim() === '' ? undefined : v);

const int = (def: number, min = 0) =>
  z.preprocess(blankAsUnset, z.coerce.number().int().min(min).default(def));

const schema = z.object({
  GATEWAY_HOST: z.preprocess(blankAsUnset, z.string().default('127.0.0.1')),
  GATEWAY_PORT: int(8080, 0),
  OPENAI_BASE_URL: z.preprocess(blankAsUnset, z.url().default('http://127.0.0.1:9000')),
  OPENAI_API_KEY: z.preprocess(blankAsUnset, z.string().optional()),
  UPSTREAM_CONNECTIONS: int(256, 1),
  UPSTREAM_TIMEOUT_MS: int(30_000, 1),
  LOG_LEVEL: z.preprocess(
    blankAsUnset,
    z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('warn'),
  ),
});

export interface Config {
  host: string;
  port: number;
  upstreamBaseUrl: string;
  upstreamApiKey: string | undefined;
  upstreamConnections: number;
  upstreamTimeoutMs: number;
  logLevel: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const e = schema.parse(env);
  return {
    host: e.GATEWAY_HOST,
    port: e.GATEWAY_PORT,
    upstreamBaseUrl: e.OPENAI_BASE_URL,
    upstreamApiKey: e.OPENAI_API_KEY,
    upstreamConnections: e.UPSTREAM_CONNECTIONS,
    upstreamTimeoutMs: e.UPSTREAM_TIMEOUT_MS,
    logLevel: e.LOG_LEVEL,
  };
}
