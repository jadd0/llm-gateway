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
  return loadConfig({
    ...process.env,
    OPENAI_BASE_URL: 'http://127.0.0.1:9',
    LOG_LEVEL: 'silent',
    API_KEY_PEPPER: randomBytes(24).toString('hex'),
    REDIS_KEY_PREFIX: `test-${randomBytes(6).toString('hex')}:`,
    AUTH_CACHE: 'redis',
    // Off unless a test asks for it, so tests of other parts are not subject to a spend cap.
    BUDGET_ENABLED: 'false',
    ...overrides,
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
