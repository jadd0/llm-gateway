import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { inArray } from 'drizzle-orm';
import type { Redis } from 'ioredis';
import { createKey, createTenant } from './cli/keys.ts';
import { hashKey } from './auth/keys.ts';
import { loadConfig, type Config } from './config.ts';
import type { Db } from './db/client.ts';
import { tenants } from './db/schema.ts';

// Test helpers: the same DATABASE_URL and REDIS_URL the dev server reads (.env.local), unless the
// environment already sets them (CI). The pepper and Redis key prefix are random per call, so test
// files running in parallel, and other worktrees on the same Redis, never see each other's keys.
try {
  process.loadEnvFile(new URL('../../../.env.local', import.meta.url));
} catch {
  // No .env.local (CI): the variables come from the environment.
}

export function testConfig(overrides: Record<string, string> = {}): Config {
  // OPENAI_BASE_URL carries its /v1 path like the real one; a test names it in full.
  const upstreamUrl = overrides.OPENAI_BASE_URL ?? 'http://127.0.0.1:9/v1';
  return loadConfig({
    ...process.env,
    // No test carries a real provider key, whatever the developer's .env.local holds.
    OPENAI_API_KEY: '',
    ANTHROPIC_API_KEY: '',
    GEMINI_API_KEY: '',
    MODEL_ROUTES: '',
    LOG_LEVEL: 'silent',
    // A developer's old .env.local may still carry the removed single timeout; no test depends on it.
    UPSTREAM_TIMEOUT_MS: '',
    API_KEY_PEPPER: randomBytes(24).toString('hex'),
    REDIS_KEY_PREFIX: `test-${randomBytes(6).toString('hex')}:`,
    AUTH_CACHE: 'redis',
    // Off unless a test asks for it, so tests of other parts are not subject to a spend cap.
    BUDGET_ENABLED: 'false',
    // Likewise the response cache: off unless a test asks, so repeated identical requests reach the upstream.
    CACHE_ENABLED: 'false',
    // And the semantic step: off unless a test asks, and never reaching a real embedder or a developer's key.
    SEMANTIC_ENABLED: 'false',
    VOYAGE_API_KEY: '',
    // One attempt per model and a breaker that does not open, unless a test asks for retries and breaking, so
    // tests of other parts see one upstream call per request.
    RETRY_MAX_ATTEMPTS_PER_MODEL: '1',
    BREAKER_MIN_FAILURES: '1000000',
    // Test files run in parallel against one Postgres with a hundred connections; a gateway under test does not need 20.
    DB_POOL_SIZE: '5',
    // A budget that sees Redis time out declares an outage and moves the one shared epoch, under every
    // other test file's balances. On a loaded machine 50 ms is routine, so tests wait longer unless they ask.
    BUDGET_REDIS_TIMEOUT_MS: '5000',
    ...overrides,
    OPENAI_BASE_URL: upstreamUrl,
    // The mock adds its own /v1 for the OpenAI format, so it gets the origin. Tests stand one stub in for
    // "the upstream": the mock-* models reach it too unless a test says otherwise.
    MOCK_BASE_URL: overrides.MOCK_BASE_URL ?? new URL(upstreamUrl).origin,
  });
}

// A tenant with a random name and one fresh key, written through the same functions the CLI uses.
export async function seedKey(db: Db['db'], config: Config, limits: { rpm?: number; tpm?: number } = {}) {
  const tenant = await createTenant(db, `t-${randomBytes(6).toString('hex')}`);
  const created = await createKey(db, config.apiKeyPepper, tenant.name, undefined, limits);
  return { ...created, tenantId: tenant.id, hash: hashKey(config.apiKeyPepper, created.key) };
}

// Test cleanup: tenants cascade to their keys; Redis keys are found by the run's own prefix.
export async function cleanup(db: Db['db'], redis: Redis | null, tenantIds: string[], prefix: string) {
  if (tenantIds.length) await db.delete(tenants).where(inArray(tenants.id, tenantIds));
  if (redis) {
    const keys = await redis.keys(`${prefix}*`);
    if (keys.length) await redis.del(...keys);
  }
}

/**
 * Test files that move the rollup fold mark (it is one row, shared by every test in the database) hold this
 * lock for their whole run, so two of them never see each other's mark. Returns the release function.
 */
export async function lockRollupState(databaseUrl: string): Promise<() => Promise<void>> {
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  await client.query('SELECT pg_advisory_lock(7011)');
  return async () => {
    await client.query('SELECT pg_advisory_unlock(7011)');
    await client.end();
  };
}
