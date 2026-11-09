import { readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { describe, expect, it } from 'vitest';
import { loadConfig } from './config.ts';

const env = (extra: Record<string, string>) => ({
  DATABASE_URL: 'postgres://u:p@127.0.0.1:1/db',
  REDIS_URL: 'redis://127.0.0.1:1',
  API_KEY_PEPPER: 'x'.repeat(40),
  ...extra,
});

describe('budget settings', () => {
  it('a reservation TTL that does not outlast the longest upstream call plus 30 s stops the gateway starting', () => {
    // The longest a call can last is UPSTREAM_MAX_DURATION_MS; its hold needs 30 s more to be settled in.
    const bad = { BUDGET_RESERVATION_TTL_S: '270', UPSTREAM_MAX_DURATION_MS: '240000' };
    expect(() => loadConfig(env(bad))).toThrow(/BUDGET_RESERVATION_TTL_S must be longer than UPSTREAM_MAX_DURATION_MS/);
    expect(() => loadConfig(env({ BUDGET_RESERVATION_TTL_S: '5', UPSTREAM_MAX_DURATION_MS: '240000' }))).toThrow();
    expect(loadConfig(env({ BUDGET_RESERVATION_TTL_S: '271', UPSTREAM_MAX_DURATION_MS: '240000' })).budgetReservationTtlS).toBe(271);
    // The idle timeout is not what the hold must outlast.
    expect(loadConfig(env({ UPSTREAM_IDLE_TIMEOUT_MS: '600000' })).upstreamIdleTimeoutMs).toBe(600_000);
    // Budgets off: nothing to hold, nothing to check.
    expect(loadConfig(env({ BUDGET_ENABLED: 'false', BUDGET_RESERVATION_TTL_S: '1' })).budgetEnabled).toBe(false);
    // The default total deadline is covered by the default hold.
    expect(loadConfig(env({}))).toMatchObject({ upstreamMaxDurationMs: 240_000, budgetReservationTtlS: 300 });
  });

  it('defaults, and the monthly cap is read as exact micro-USD', () => {
    const c = loadConfig(env({}));
    expect(c).toMatchObject({ budgetEnabled: true, budgetReservationTtlS: 300, budgetOutageFailures: 3, budgetDefaultMonthlyMicros: 10_000_000 });
    expect(loadConfig(env({ BUDGET_DEFAULT_MONTHLY_USD: '0.000001' })).budgetDefaultMonthlyMicros).toBe(1);
    expect(() => loadConfig(env({ BUDGET_DEFAULT_MONTHLY_USD: '1e3' }))).toThrow();
  });
});

describe('provider settings', () => {
  it('defaults name each provider, keys are unset, and blank values mean unset', () => {
    const c = loadConfig(env({ ANTHROPIC_API_KEY: '', GEMINI_API_KEY: ' ' }));
    expect(c).toMatchObject({
      upstreamBaseUrl: 'https://api.openai.com/v1',
      anthropicBaseUrl: 'https://api.anthropic.com',
      anthropicVersion: '2023-06-01',
      geminiBaseUrl: 'https://generativelanguage.googleapis.com/v1beta',
      mockBaseUrl: 'http://127.0.0.1:9000',
      anthropicApiKey: undefined,
      geminiApiKey: undefined,
    });
    expect(c.modelRoutes.map(([prefix]) => prefix).slice(0, 3)).toEqual(['mock-anthropic-', 'mock-gemini-', 'mock-openai-']);
  });

  it('MODEL_ROUTES is validated at start-up', () => {
    expect(loadConfig(env({ MODEL_ROUTES: 'x-=anthropic' })).modelRoutes).toEqual([['x-', 'anthropic']]);
    expect(() => loadConfig(env({ MODEL_ROUTES: 'x-=cohere' }))).toThrow(/names unknown provider .*cohere/);
    expect(() => loadConfig(env({ MODEL_ROUTES: 'nonsense' }))).toThrow(/model prefix/);
  });
});

describe('OPENAI_BASE_URL', () => {
  it('without a path it stops the gateway starting, naming the fix; with one (a proxy prefix too) it loads', () => {
    for (const bad of ['http://127.0.0.1:9000', 'http://127.0.0.1:9000/', 'https://proxy.example.com']) {
      expect(() => loadConfig(env({ OPENAI_BASE_URL: bad })), bad).toThrow(/OPENAI_BASE_URL needs the API version path.*https:\/\/api\.openai\.com\/v1/s);
    }
    expect(loadConfig(env({ OPENAI_BASE_URL: 'http://127.0.0.1:9000/v1' })).upstreamBaseUrl).toBe('http://127.0.0.1:9000/v1');
    expect(loadConfig(env({ OPENAI_BASE_URL: 'https://openrouter.ai/api/v1/' })).upstreamBaseUrl).toBe('https://openrouter.ai/api/v1/');
    expect(loadConfig(env({})).upstreamBaseUrl).toBe('https://api.openai.com/v1');
    expect(loadConfig(env({ OPENAI_BASE_URL: '' })).upstreamBaseUrl).toBe('https://api.openai.com/v1');
  });
});

describe('resilience settings', () => {
  it('defaults match the plan', () => {
    expect(loadConfig(env({}))).toMatchObject({
      upstreamConnectTimeoutMs: 5000,
      upstreamHeadersTimeoutMs: 120_000,
      upstreamIdleTimeoutMs: 30_000,
      retryMaxAttemptsPerModel: 3,
      retryBaseMs: 200,
      retryCapMs: 2000,
      retryAfterMaxMs: 5000,
      retryMinRemainingMs: 1000,
      breakerWindowMs: 10_000,
      breakerMinFailures: 5,
      breakerFailureRatio: 0.5,
      breakerOpenMs: 15_000,
      breakerRedisTimeoutMs: 50,
      modelFallbacks: [],
      mockAnthropicBaseUrl: 'http://127.0.0.1:9000',
      mockGeminiBaseUrl: 'http://127.0.0.1:9000',
    });
    const c = loadConfig(env({ MOCK_BASE_URL: 'http://127.0.0.1:9100', MOCK_GEMINI_BASE_URL: 'http://127.0.0.1:9101' }));
    expect([c.mockBaseUrl, c.mockAnthropicBaseUrl, c.mockGeminiBaseUrl]).toEqual([
      'http://127.0.0.1:9100', 'http://127.0.0.1:9100', 'http://127.0.0.1:9101',
    ]);
  });

  it('the old single timeout is refused with a message naming the three that replace it', () => {
    expect(() => loadConfig(env({ UPSTREAM_TIMEOUT_MS: '30000' }))).toThrow(
      /UPSTREAM_CONNECT_TIMEOUT_MS.*UPSTREAM_HEADERS_TIMEOUT_MS.*UPSTREAM_IDLE_TIMEOUT_MS/s,
    );
    // A blank value is "not set", as for every other setting.
    expect(loadConfig(env({ UPSTREAM_TIMEOUT_MS: '' })).upstreamIdleTimeoutMs).toBe(30_000);
  });
});

describe('response cache settings', () => {
  it('defaults, and .env.example alone (plus a pepper) loads to the same cache settings', () => {
    const defaults = {
      cacheEnabled: true,
      cacheTtlS: 3600,
      cacheMaxEntryBytes: 262_144,
      cacheAllowNondeterministic: false,
      cacheLockMs: 5_000,
      cachePollMs: 250,
      cacheWaitMs: 120_000,
      cacheRedisTimeoutMs: 50,
      cacheReplayChunkChars: 64,
    };
    expect(loadConfig(env({}))).toMatchObject(defaults);
    const example = parseEnv(readFileSync(new URL('../../../.env.example', import.meta.url), 'utf8'));
    for (const name of ['CACHE_ENABLED', 'CACHE_TTL_S', 'CACHE_MAX_ENTRY_BYTES', 'CACHE_ALLOW_NONDETERMINISTIC', 'CACHE_LOCK_MS', 'CACHE_POLL_MS', 'CACHE_WAIT_MS', 'CACHE_REDIS_TIMEOUT_MS', 'CACHE_REPLAY_CHUNK_CHARS']) {
      expect(example[name], name).toBeDefined();
    }
    expect(loadConfig({ ...example, API_KEY_PEPPER: 'x'.repeat(40) })).toMatchObject(defaults);
  });

  it('needs Redis, and a wait between the lock and the longest upstream call', () => {
    const noRedis = { DATABASE_URL: 'postgres://u:p@127.0.0.1:1/db', API_KEY_PEPPER: 'x'.repeat(40), AUTH_CACHE: 'none', RATE_LIMIT_ENABLED: 'false', BUDGET_ENABLED: 'false' };
    expect(() => loadConfig(noRedis)).toThrow(/REDIS_URL is required when CACHE_ENABLED=true/);
    expect(loadConfig({ ...noRedis, CACHE_ENABLED: 'false' }).cacheEnabled).toBe(false);
    expect(() => loadConfig(env({ CACHE_LOCK_MS: '5000', CACHE_WAIT_MS: '2000' }))).toThrow(/CACHE_WAIT_MS must not be shorter than CACHE_LOCK_MS/);
    expect(() => loadConfig(env({ UPSTREAM_MAX_DURATION_MS: '60000', CACHE_WAIT_MS: '120000' }))).toThrow(/CACHE_WAIT_MS must not be longer than UPSTREAM_MAX_DURATION_MS/);
    // With the cache off its wait is not in play, so a short upstream limit needs no cache setting.
    expect(loadConfig(env({ CACHE_ENABLED: 'false', UPSTREAM_MAX_DURATION_MS: '300' })).upstreamMaxDurationMs).toBe(300);
  });
});
