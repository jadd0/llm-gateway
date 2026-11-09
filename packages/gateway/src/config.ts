import { z } from 'zod';
import { parseUsd } from './pricing/prices.ts';

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

// The key cache's settings, shared by the gateway and by set-limits (which reads only these).
const cacheFields = {
  REDIS_URL: z.preprocess(blankAsUnset, z.string().optional()),
  // Prepended to every Redis key so several gateways or test runs can share one Redis.
  REDIS_KEY_PREFIX: z.preprocess(blankAsUnset, z.string().default('')),
  AUTH_CACHE: z.preprocess(blankAsUnset, z.enum(['redis', 'none']).default('redis')),
  AUTH_CACHE_TTL_S: int(600, 1),
  AUTH_NEGATIVE_TTL_S: int(60, 1),
  AUTH_TOMBSTONE_TTL_S: int(1200, 1),
};

// A USD amount written as "10" or "0.01": converted to integer micro-USD with no float in between.
const usd = (def: string) =>
  z.preprocess(
    blankAsUnset,
    z
      .string()
      .default(def)
      .transform((v, ctx) => {
        const micros = parseUsd(v);
        if (micros === undefined) ctx.addIssue({ code: 'custom', message: 'must be a USD amount like 10 or 0.01' });
        return micros ?? 0;
      }),
  );

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
    ...cacheFields,
    ...pepperField,
    RATE_LIMIT_ENABLED: z.preprocess(blankAsUnset, z.enum(['true', 'false']).default('true')),
    RATE_LIMIT_DEFAULT_RPM: int(600, 1),
    RATE_LIMIT_DEFAULT_TPM: int(200_000, 1),
    RATE_LIMIT_DEFAULT_MAX_TOKENS: int(1024, 1),
    RATE_LIMIT_REDIS_TIMEOUT_MS: int(50, 1),
    BUDGET_ENABLED: z.preprocess(blankAsUnset, z.enum(['true', 'false']).default('true')),
    BUDGET_DEFAULT_MONTHLY_USD: usd('10'),
    BUDGET_RESERVATION_TTL_S: int(300, 1),
    BUDGET_REDIS_TIMEOUT_MS: int(50, 1),
    BUDGET_EPOCH_REFRESH_S: int(5, 1),
    BUDGET_OUTAGE_FAILURES: int(3, 1),
  })
  .refine((e) => e.AUTH_CACHE === 'none' || e.REDIS_URL !== undefined, {
    message: 'REDIS_URL is required when AUTH_CACHE=redis',
    path: ['REDIS_URL'],
  })
  .refine((e) => e.RATE_LIMIT_ENABLED === 'false' || e.REDIS_URL !== undefined, {
    message: 'REDIS_URL is required when RATE_LIMIT_ENABLED=true',
    path: ['REDIS_URL'],
  })
  .refine((e) => e.BUDGET_ENABLED === 'false' || e.REDIS_URL !== undefined, {
    message: 'REDIS_URL is required when BUDGET_ENABLED=true',
    path: ['REDIS_URL'],
  })
  .refine((e) => e.BUDGET_ENABLED === 'false' || e.BUDGET_RESERVATION_TTL_S * 1000 > e.UPSTREAM_TIMEOUT_MS, {
    message:
      'BUDGET_RESERVATION_TTL_S must be longer than UPSTREAM_TIMEOUT_MS (in seconds): a hold must outlive the longest call it covers',
    path: ['BUDGET_RESERVATION_TTL_S'],
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
  budgetEnabled: boolean;
  /** Monthly cap in micro-USD for tenants with none of their own. */
  budgetDefaultMonthlyMicros: number;
  budgetReservationTtlS: number;
  budgetRedisTimeoutMs: number;
  budgetEpochRefreshS: number;
  budgetOutageFailures: number;
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
    budgetEnabled: e.BUDGET_ENABLED === 'true',
    budgetDefaultMonthlyMicros: e.BUDGET_DEFAULT_MONTHLY_USD,
    budgetReservationTtlS: e.BUDGET_RESERVATION_TTL_S,
    budgetRedisTimeoutMs: e.BUDGET_REDIS_TIMEOUT_MS,
    budgetEpochRefreshS: e.BUDGET_EPOCH_REFRESH_S,
    budgetOutageFailures: e.BUDGET_OUTAGE_FAILURES,
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

// What set-limits needs: the database, and the key cache's settings when a Redis is configured. No pepper,
// and Redis is optional because the database write is the change; the cache entry is only refreshed.
export function loadCacheConfig(env: NodeJS.ProcessEnv = process.env): Pick<
  Config,
  'databaseUrl' | 'redisUrl' | 'redisKeyPrefix' | 'authCache' | 'authCacheTtlS' | 'authNegativeTtlS' | 'authTombstoneTtlS'
> {
  const e = z
    .object({ ...dbFields, ...cacheFields })
    .parse(env);
  return {
    databaseUrl: e.DATABASE_URL,
    redisUrl: e.REDIS_URL,
    redisKeyPrefix: e.REDIS_KEY_PREFIX,
    authCache: e.AUTH_CACHE,
    authCacheTtlS: e.AUTH_CACHE_TTL_S,
    authNegativeTtlS: e.AUTH_NEGATIVE_TTL_S,
    authTombstoneTtlS: e.AUTH_TOMBSTONE_TTL_S,
  };
}
