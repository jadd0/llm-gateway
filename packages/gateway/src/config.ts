import { hostname } from 'node:os';
import { z } from 'zod';
import { parseUsd, priceFor } from './pricing/prices.ts';
import { DEFAULT_MODEL_ROUTES, parseModelRoutes, routeModel, type ModelRoutes } from './providers/router.ts';
import { checkChains, parseFallbacks, type Chains } from './resilience/fallback.ts';

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
    // Base URLs carry the API version prefix, as the providers' own SDKs expect; adapters append to them.
    // A URL with no path is refused unless OPENAI_BASE_URL_ALLOW_ROOT=true: this one carries /v1 (the gateway
    // used to add it), and a leftover `http://host:port` would send every request to a path the provider
    // does not serve. A root-mounted OpenAI-compatible upstream sets the flag.
    OPENAI_BASE_URL: z.preprocess(blankAsUnset, z.url().default('https://api.openai.com/v1')),
    OPENAI_BASE_URL_ALLOW_ROOT: z.preprocess(blankAsUnset, z.enum(['true', 'false']).default('false')),
    OPENAI_API_KEY: z.preprocess(blankAsUnset, z.string().optional()),
    ANTHROPIC_BASE_URL: z.preprocess(blankAsUnset, z.url().default('https://api.anthropic.com')),
    ANTHROPIC_API_KEY: z.preprocess(blankAsUnset, z.string().optional()),
    ANTHROPIC_VERSION: z.preprocess(blankAsUnset, z.string().default('2023-06-01')),
    GEMINI_BASE_URL: z.preprocess(blankAsUnset, z.url().default('https://generativelanguage.googleapis.com/v1beta')),
    GEMINI_API_KEY: z.preprocess(blankAsUnset, z.string().optional()),
    // The mock provider (all three of its formats). It needs no key.
    MOCK_BASE_URL: z.preprocess(blankAsUnset, z.url().default('http://127.0.0.1:9000')),
    // The mock's Anthropic and Gemini formats may live on another origin (the chaos run kills one mock and
    // keeps the other). Unset, they use MOCK_BASE_URL.
    MOCK_ANTHROPIC_BASE_URL: z.preprocess(blankAsUnset, z.url().optional()),
    MOCK_GEMINI_BASE_URL: z.preprocess(blankAsUnset, z.url().optional()),
    // Which provider serves a model: "prefix=provider" pairs, the longest matching prefix wins.
    MODEL_ROUTES: z.preprocess(
      blankAsUnset,
      z
        .string()
        .default(DEFAULT_MODEL_ROUTES)
        .transform((v, ctx): ModelRoutes => {
          const routes = parseModelRoutes(v);
          if (typeof routes === 'string') {
            ctx.addIssue({ code: 'custom', message: routes });
            return [];
          }
          return routes;
        }),
    ),
    // Ordered fallback chains: "modelA>modelB>modelC;modelX>modelY". A request for the first model of a chain
    // moves down it when that model cannot serve. Empty means no fallback.
    MODEL_FALLBACKS: z.preprocess(
      blankAsUnset,
      z
        .string()
        .default('')
        .transform((v, ctx): Chains => {
          const chains = parseFallbacks(v);
          if (typeof chains === 'string') {
            ctx.addIssue({ code: 'custom', message: chains });
            return [];
          }
          return chains;
        }),
    ),
    UPSTREAM_CONNECTIONS: int(256, 1),
    // The old single timeout is refused: it set three different limits at once.
    UPSTREAM_TIMEOUT_MS: z.preprocess(blankAsUnset, z.string().optional()),
    // Per attempt: connecting, then waiting for response headers (a non-streamed completion sends none until
    // it is finished), then silence between body bytes.
    UPSTREAM_CONNECT_TIMEOUT_MS: int(5_000, 1),
    UPSTREAM_HEADERS_TIMEOUT_MS: int(120_000, 1),
    UPSTREAM_IDLE_TIMEOUT_MS: int(30_000, 1),
    // A total deadline for the whole request, every attempt and backoff included. The per-attempt timeouts
    // only limit silence, so a slow stream that keeps trickling bytes could otherwise outlive the budget hold.
    UPSTREAM_MAX_DURATION_MS: int(240_000, 1),
    // A provider's error answer (status and headers in) is waited for this long for its body; a slower body is
    // dropped, the status kept, and the request moves on.
    UPSTREAM_ERROR_BODY_TIMEOUT_MS: int(2_000, 1),
    UPSTREAM_ERROR_BODY_MAX_BYTES: int(65_536, 1),
    RETRY_MAX_ATTEMPTS_PER_MODEL: int(3, 1),
    RETRY_BASE_MS: int(200, 1),
    RETRY_CAP_MS: int(2_000, 1),
    RETRY_AFTER_MAX_MS: int(5_000, 0),
    RETRY_MIN_REMAINING_MS: int(1_000, 0),
    BREAKER_WINDOW_MS: int(10_000, 1000),
    BREAKER_MIN_FAILURES: int(5, 1),
    BREAKER_FAILURE_RATIO: z.preprocess(blankAsUnset, z.coerce.number().gt(0).max(1).default(0.5)),
    BREAKER_OPEN_MS: int(15_000, 1),
    BREAKER_REDIS_TIMEOUT_MS: int(50, 1),
    LOG_LEVEL: z.preprocess(
      blankAsUnset,
      z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('warn'),
    ),
    ...dbFields,
    ...cacheFields,
    ...pepperField,
    // Failed authentications one client address may make per minute before it is refused with 429 ahead of
    // any key lookup. 0 turns the limit off.
    AUTH_FAIL_LIMIT_PER_MIN: int(30, 0),
    // Comma-separated addresses or CIDRs whose X-Forwarded-For is believed ('none': trust nobody).
    TRUSTED_PROXIES: z.preprocess(
      blankAsUnset,
      z
        .string()
        .default('127.0.0.1')
        .transform((v) => (v.trim().toLowerCase() === 'none' ? [] : v.split(',').map((x) => x.trim()).filter((x) => x !== ''))),
    ),
    RATE_LIMIT_ENABLED: z.preprocess(blankAsUnset, z.enum(['true', 'false']).default('true')),
    RATE_LIMIT_DEFAULT_RPM: int(600, 1),
    RATE_LIMIT_DEFAULT_TPM: int(200_000, 1),
    RATE_LIMIT_DEFAULT_MAX_TOKENS: int(1024, 1),
    MOCK_MAX_OUTPUT_TOKENS: int(4096, 1),
    RATE_LIMIT_REDIS_TIMEOUT_MS: int(50, 1),
    BUDGET_ENABLED: z.preprocess(blankAsUnset, z.enum(['true', 'false']).default('true')),
    BUDGET_DEFAULT_MONTHLY_USD: usd('10'),
    BUDGET_RESERVATION_TTL_S: int(300, 1),
    BUDGET_REDIS_TIMEOUT_MS: int(50, 1),
    BUDGET_EPOCH_REFRESH_MS: int(250, 10),
    BUDGET_OUTAGE_FAILURES: int(3, 1),
    CACHE_ENABLED: z.preprocess(blankAsUnset, z.enum(['true', 'false']).default('true')),
    CACHE_TTL_S: int(3600, 1),
    CACHE_MAX_ENTRY_BYTES: int(262_144, 1),
    CACHE_ALLOW_NONDETERMINISTIC: z.preprocess(blankAsUnset, z.enum(['true', 'false']).default('false')),
    CACHE_LOCK_MS: int(5_000, 1),
    CACHE_POLL_MS: int(250, 1),
    CACHE_WAIT_MS: int(120_000, 1),
    CACHE_REDIS_TIMEOUT_MS: int(50, 1),
    CACHE_REPLAY_CHUNK_CHARS: int(64, 1),
    // stream: every request is queued in a Redis stream and written to Postgres by the log worker.
    // inline: one awaited Postgres insert per request; the "before" of the logging benchmark, nothing else.
    LOG_MODE: z.preprocess(blankAsUnset, z.enum(['stream', 'inline']).default('stream')),
    LOG_GROUP: z.preprocess(blankAsUnset, z.string().min(1).default('log-writers')),
    LOG_BATCH_SIZE: int(500, 1),
    LOG_BATCH_WAIT_MS: int(1000, 1),
    LOG_CLAIM_IDLE_MS: int(30_000, 1),
    LOG_MAX_DELIVERIES: int(5, 1),
    LOG_BUFFER_MAX: int(10_000, 0),
    LOG_SWEEP_S: int(60, 1),
    LOG_SWEEP_GRACE_S: int(60, 0),
    LOG_STREAM_MAX: int(1_000_000, 1),
    BUDGET_ORPHAN_GRACE_S: int(600, 0),
    WORKER_CONSUMER: z.preprocess(blankAsUnset, z.string().default(`${hostname()}-${process.pid}`)),
  })
  .refine((e) => e.OPENAI_BASE_URL_ALLOW_ROOT === 'true' || new URL(e.OPENAI_BASE_URL).pathname.replace(/\/+$/, '') !== '', {
    message:
      "OPENAI_BASE_URL needs the API version path, as OpenAI's SDKs take it: https://api.openai.com/v1 (a proxy: https://host/v1). The gateway no longer adds /v1. An upstream mounted at the root of its host: set OPENAI_BASE_URL_ALLOW_ROOT=true",
    path: ['OPENAI_BASE_URL'],
  })
  .refine((e) => e.UPSTREAM_TIMEOUT_MS === undefined, {
    message:
      'UPSTREAM_TIMEOUT_MS is gone: it set three limits at once. Use UPSTREAM_CONNECT_TIMEOUT_MS, UPSTREAM_HEADERS_TIMEOUT_MS and UPSTREAM_IDLE_TIMEOUT_MS',
    path: ['UPSTREAM_TIMEOUT_MS'],
  })
  .superRefine((e, ctx) => {
    const problem = checkChains(e.MODEL_FALLBACKS, {
      routable: (m) => routeModel(e.MODEL_ROUTES, m) !== undefined,
      priced: (m) => priceFor(m) !== undefined,
      budgets: e.BUDGET_ENABLED === 'true',
    });
    if (problem) ctx.addIssue({ code: 'custom', message: problem, path: ['MODEL_FALLBACKS'] });
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
  .refine((e) => e.CACHE_ENABLED === 'false' || e.REDIS_URL !== undefined, {
    message: 'REDIS_URL is required when CACHE_ENABLED=true',
    path: ['REDIS_URL'],
  })
  .refine((e) => e.LOG_MODE === 'inline' || e.REDIS_URL !== undefined, {
    message: 'REDIS_URL is required when LOG_MODE=stream: the request log is queued in a Redis stream',
    path: ['REDIS_URL'],
  })
  .refine((e) => e.CACHE_ENABLED === 'false' || e.CACHE_WAIT_MS <= e.UPSTREAM_MAX_DURATION_MS, {
    message: 'CACHE_WAIT_MS must not be longer than UPSTREAM_MAX_DURATION_MS: no call outlasts that, so no one should wait longer for one',
    path: ['CACHE_WAIT_MS'],
  })
  .refine((e) => e.CACHE_ENABLED === 'false' || e.CACHE_WAIT_MS >= e.CACHE_LOCK_MS, {
    message: 'CACHE_WAIT_MS must not be shorter than CACHE_LOCK_MS: a waiter should outlast one lock lifetime',
    path: ['CACHE_WAIT_MS'],
  })
  .refine((e) => e.BUDGET_ENABLED === 'false' || e.BUDGET_RESERVATION_TTL_S * 1000 > e.UPSTREAM_MAX_DURATION_MS + 30_000, {
    message:
      'BUDGET_RESERVATION_TTL_S must be longer than UPSTREAM_MAX_DURATION_MS plus 30 seconds: a hold must outlive the longest call it covers',
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
  anthropicBaseUrl: string;
  anthropicApiKey: string | undefined;
  anthropicVersion: string;
  geminiBaseUrl: string;
  geminiApiKey: string | undefined;
  mockBaseUrl: string;
  mockAnthropicBaseUrl: string;
  mockGeminiBaseUrl: string;
  modelRoutes: ModelRoutes;
  modelFallbacks: Chains;
  upstreamConnections: number;
  upstreamConnectTimeoutMs: number;
  upstreamHeadersTimeoutMs: number;
  upstreamIdleTimeoutMs: number;
  upstreamMaxDurationMs: number;
  upstreamErrorBodyTimeoutMs: number;
  upstreamErrorBodyMaxBytes: number;
  retryMaxAttemptsPerModel: number;
  retryBaseMs: number;
  retryCapMs: number;
  retryAfterMaxMs: number;
  retryMinRemainingMs: number;
  breakerWindowMs: number;
  breakerMinFailures: number;
  breakerFailureRatio: number;
  breakerOpenMs: number;
  breakerRedisTimeoutMs: number;
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
  authFailLimitPerMin: number;
  trustedProxies: string[];
  rateLimitEnabled: boolean;
  rateLimitDefaultRpm: number;
  rateLimitDefaultTpm: number;
  /** Output tokens assumed when a request names no max_tokens. */
  rateLimitDefaultMaxTokens: number;
  mockMaxOutputTokens: number;
  rateLimitRedisTimeoutMs: number;
  budgetEnabled: boolean;
  /** Monthly cap in micro-USD for tenants with none of their own. */
  budgetDefaultMonthlyMicros: number;
  budgetReservationTtlS: number;
  budgetRedisTimeoutMs: number;
  budgetEpochRefreshMs: number;
  budgetOutageFailures: number;
  cacheEnabled: boolean;
  /** How long a cached answer lives. */
  cacheTtlS: number;
  /** The largest answer (as stored JSON) that is cached. */
  cacheMaxEntryBytes: number;
  /** Cache requests that do not set temperature 0 too. */
  cacheAllowNondeterministic: boolean;
  /** How long the Redis lock of the request that leads an identical-miss burst lasts between renewals; the leader renews it while its request is open, so a dead leader frees it within this. */
  cacheLockMs: number;
  /** How often a request waiting on a leader in another process looks for the fill and the lock. */
  cachePollMs: number;
  /** The most a request waits for the leader's fill before going upstream itself. */
  cacheWaitMs: number;
  cacheRedisTimeoutMs: number;
  /** Characters (code points) per content chunk when a cached answer is replayed as a stream. */
  cacheReplayChunkChars: number;
  logMode: 'stream' | 'inline';
  logGroup: string;
  logBatchSize: number;
  logBatchWaitMs: number;
  logClaimIdleMs: number;
  logMaxDeliveries: number;
  /** Request-log entries held in memory while Redis is down; past this they are dropped and counted. */
  logBufferMax: number;
  /** How often the worker sweeps lapsed holds and reconciles orphaned Redis holds (seconds). */
  logSweepS: number;
  /** A hold is swept only this long after it lapsed, so a settle queued before it lapsed has been applied (seconds). */
  logSweepGraceS: number;
  /** Approximate cap on the request-log stream's length (XADD MAXLEN ~). Spend entries are never capped. */
  logStreamMax: number;
  /** A Redis hold with no Postgres hold row is dropped only once it is this far past its expiry (seconds). */
  budgetOrphanGraceS: number;
  workerConsumer: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const e = schema.parse(env);
  return {
    host: e.GATEWAY_HOST,
    port: e.GATEWAY_PORT,
    upstreamBaseUrl: e.OPENAI_BASE_URL,
    upstreamApiKey: e.OPENAI_API_KEY,
    anthropicBaseUrl: e.ANTHROPIC_BASE_URL,
    anthropicApiKey: e.ANTHROPIC_API_KEY,
    anthropicVersion: e.ANTHROPIC_VERSION,
    geminiBaseUrl: e.GEMINI_BASE_URL,
    geminiApiKey: e.GEMINI_API_KEY,
    mockBaseUrl: e.MOCK_BASE_URL,
    mockAnthropicBaseUrl: e.MOCK_ANTHROPIC_BASE_URL ?? e.MOCK_BASE_URL,
    mockGeminiBaseUrl: e.MOCK_GEMINI_BASE_URL ?? e.MOCK_BASE_URL,
    modelRoutes: e.MODEL_ROUTES,
    modelFallbacks: e.MODEL_FALLBACKS,
    upstreamConnections: e.UPSTREAM_CONNECTIONS,
    upstreamConnectTimeoutMs: e.UPSTREAM_CONNECT_TIMEOUT_MS,
    upstreamHeadersTimeoutMs: e.UPSTREAM_HEADERS_TIMEOUT_MS,
    upstreamIdleTimeoutMs: e.UPSTREAM_IDLE_TIMEOUT_MS,
    upstreamMaxDurationMs: e.UPSTREAM_MAX_DURATION_MS,
    upstreamErrorBodyTimeoutMs: e.UPSTREAM_ERROR_BODY_TIMEOUT_MS,
    upstreamErrorBodyMaxBytes: e.UPSTREAM_ERROR_BODY_MAX_BYTES,
    retryMaxAttemptsPerModel: e.RETRY_MAX_ATTEMPTS_PER_MODEL,
    retryBaseMs: e.RETRY_BASE_MS,
    retryCapMs: e.RETRY_CAP_MS,
    retryAfterMaxMs: e.RETRY_AFTER_MAX_MS,
    retryMinRemainingMs: e.RETRY_MIN_REMAINING_MS,
    breakerWindowMs: e.BREAKER_WINDOW_MS,
    breakerMinFailures: e.BREAKER_MIN_FAILURES,
    breakerFailureRatio: e.BREAKER_FAILURE_RATIO,
    breakerOpenMs: e.BREAKER_OPEN_MS,
    breakerRedisTimeoutMs: e.BREAKER_REDIS_TIMEOUT_MS,
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
    authFailLimitPerMin: e.AUTH_FAIL_LIMIT_PER_MIN,
    trustedProxies: e.TRUSTED_PROXIES,
    rateLimitEnabled: e.RATE_LIMIT_ENABLED === 'true',
    rateLimitDefaultRpm: e.RATE_LIMIT_DEFAULT_RPM,
    rateLimitDefaultTpm: e.RATE_LIMIT_DEFAULT_TPM,
    rateLimitDefaultMaxTokens: e.RATE_LIMIT_DEFAULT_MAX_TOKENS,
    mockMaxOutputTokens: e.MOCK_MAX_OUTPUT_TOKENS,
    rateLimitRedisTimeoutMs: e.RATE_LIMIT_REDIS_TIMEOUT_MS,
    budgetEnabled: e.BUDGET_ENABLED === 'true',
    budgetDefaultMonthlyMicros: e.BUDGET_DEFAULT_MONTHLY_USD,
    budgetReservationTtlS: e.BUDGET_RESERVATION_TTL_S,
    budgetRedisTimeoutMs: e.BUDGET_REDIS_TIMEOUT_MS,
    budgetEpochRefreshMs: e.BUDGET_EPOCH_REFRESH_MS,
    budgetOutageFailures: e.BUDGET_OUTAGE_FAILURES,
    cacheEnabled: e.CACHE_ENABLED === 'true',
    cacheTtlS: e.CACHE_TTL_S,
    cacheMaxEntryBytes: e.CACHE_MAX_ENTRY_BYTES,
    cacheAllowNondeterministic: e.CACHE_ALLOW_NONDETERMINISTIC === 'true',
    cacheLockMs: e.CACHE_LOCK_MS,
    cachePollMs: e.CACHE_POLL_MS,
    cacheWaitMs: e.CACHE_WAIT_MS,
    cacheRedisTimeoutMs: e.CACHE_REDIS_TIMEOUT_MS,
    cacheReplayChunkChars: e.CACHE_REPLAY_CHUNK_CHARS,
    logMode: e.LOG_MODE,
    logGroup: e.LOG_GROUP,
    logBatchSize: e.LOG_BATCH_SIZE,
    logBatchWaitMs: e.LOG_BATCH_WAIT_MS,
    logClaimIdleMs: e.LOG_CLAIM_IDLE_MS,
    logMaxDeliveries: e.LOG_MAX_DELIVERIES,
    logBufferMax: e.LOG_BUFFER_MAX,
    logSweepS: e.LOG_SWEEP_S,
    logSweepGraceS: e.LOG_SWEEP_GRACE_S,
    logStreamMax: e.LOG_STREAM_MAX,
    budgetOrphanGraceS: e.BUDGET_ORPHAN_GRACE_S,
    workerConsumer: e.WORKER_CONSUMER,
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
