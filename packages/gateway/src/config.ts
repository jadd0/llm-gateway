import { z } from 'zod';

// A blank value in an env file (`KEY=`) means "not set", so the default applies.
const blankAsUnset = (v: unknown) => (typeof v === 'string' && v.trim() === '' ? undefined : v);

const int = (def: number, min = 0) =>
  z.preprocess(blankAsUnset, z.coerce.number().int().min(min).default(def));

const dbFields = {
  DATABASE_URL: z.string().min(1),
  DB_POOL_SIZE: int(20, 1),
};
// The server-side secret mixed into every key hash. The gateway refuses to start without it.
const pepperField = { API_KEY_PEPPER: z.string().min(32) };

const schema = z
  .object({
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
    ...dbFields,
    REDIS_URL: z.preprocess(blankAsUnset, z.string().optional()),
    // Prepended to every Redis key so several gateways or test runs can share one Redis.
    REDIS_KEY_PREFIX: z.preprocess(blankAsUnset, z.string().default('')),
    ...pepperField,
    AUTH_CACHE: z.preprocess(blankAsUnset, z.enum(['redis', 'none']).default('redis')),
    AUTH_CACHE_TTL_S: int(600, 1),
    AUTH_NEGATIVE_TTL_S: int(60, 1),
    AUTH_TOMBSTONE_TTL_S: int(1200, 1),
    RATE_LIMIT_ENABLED: z.preprocess(blankAsUnset, z.enum(['true', 'false']).default('true')),
    RATE_LIMIT_DEFAULT_RPM: int(600, 1),
    RATE_LIMIT_DEFAULT_TPM: int(200_000, 1),
    RATE_LIMIT_DEFAULT_MAX_TOKENS: int(1024, 1),
    RATE_LIMIT_REDIS_TIMEOUT_MS: int(50, 1),
  })
  .refine((e) => e.AUTH_CACHE === 'none' || e.REDIS_URL !== undefined, {
    message: 'REDIS_URL is required when AUTH_CACHE=redis',
    path: ['REDIS_URL'],
  })
  .refine((e) => e.RATE_LIMIT_ENABLED === 'false' || e.REDIS_URL !== undefined, {
    message: 'REDIS_URL is required when RATE_LIMIT_ENABLED=true',
    path: ['REDIS_URL'],
  })
  .refine((e) => e.AUTH_TOMBSTONE_TTL_S > e.AUTH_CACHE_TTL_S, {
    message: 'AUTH_TOMBSTONE_TTL_S must be longer than AUTH_CACHE_TTL_S',
    path: ['AUTH_TOMBSTONE_TTL_S'],
  });

export interface Config {
  host: string;
  port: number;
  upstreamBaseUrl: string;
  upstreamApiKey: string | undefined;
  upstreamConnections: number;
  upstreamTimeoutMs: number;
  logLevel: string;
  databaseUrl: string;
  dbPoolSize: number;
  redisUrl: string | undefined;
  redisKeyPrefix: string;
  apiKeyPepper: string;
  authCache: 'redis' | 'none';
  authCacheTtlS: number;
  authNegativeTtlS: number;
  authTombstoneTtlS: number;
  rateLimitEnabled: boolean;
  rateLimitDefaultRpm: number;
  rateLimitDefaultTpm: number;
  /** Output tokens assumed when a request names no max_tokens. */
  rateLimitDefaultMaxTokens: number;
  rateLimitRedisTimeoutMs: number;
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
    databaseUrl: e.DATABASE_URL,
    dbPoolSize: e.DB_POOL_SIZE,
    redisUrl: e.REDIS_URL,
    redisKeyPrefix: e.REDIS_KEY_PREFIX,
    apiKeyPepper: e.API_KEY_PEPPER,
    authCache: e.AUTH_CACHE,
    authCacheTtlS: e.AUTH_CACHE_TTL_S,
    authNegativeTtlS: e.AUTH_NEGATIVE_TTL_S,
    authTombstoneTtlS: e.AUTH_TOMBSTONE_TTL_S,
    rateLimitEnabled: e.RATE_LIMIT_ENABLED === 'true',
    rateLimitDefaultRpm: e.RATE_LIMIT_DEFAULT_RPM,
    rateLimitDefaultTpm: e.RATE_LIMIT_DEFAULT_TPM,
    rateLimitDefaultMaxTokens: e.RATE_LIMIT_DEFAULT_MAX_TOKENS,
    rateLimitRedisTimeoutMs: e.RATE_LIMIT_REDIS_TIMEOUT_MS,
  };
}

// Only what a database-only command (migrations, create-tenant, list-keys) needs: no pepper, no Redis.
export function loadDbConfig(env: NodeJS.ProcessEnv = process.env): { databaseUrl: string } {
  return { databaseUrl: z.object(dbFields).parse(env).DATABASE_URL };
}

// create-key needs the database and the pepper, nothing else.
export function loadPepperConfig(env: NodeJS.ProcessEnv = process.env): { databaseUrl: string; apiKeyPepper: string } {
  const e = z.object({ ...dbFields, ...pepperField }).parse(env);
  return { databaseUrl: e.DATABASE_URL, apiKeyPepper: e.API_KEY_PEPPER };
}
