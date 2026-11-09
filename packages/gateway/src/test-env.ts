import { randomBytes } from 'node:crypto';
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
  const upstreamUrl = overrides.OPENAI_BASE_URL ?? 'http://127.0.0.1:9';
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
    ...overrides,
    // Tests give the upstream's origin; OPENAI_BASE_URL needs a path, so /v1 is added when none is given.
    // The mock adds its own /v1 for the OpenAI format, so it gets the origin. Tests stand one stub in for
    // "the upstream": the mock-* models reach it too unless a test says otherwise.
    OPENAI_BASE_URL: new URL(upstreamUrl).pathname === '/' ? `${upstreamUrl.replace(/\/+$/, '')}/v1` : upstreamUrl,
    MOCK_BASE_URL: overrides.MOCK_BASE_URL ?? upstreamUrl,
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
