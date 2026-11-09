import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { eq } from 'drizzle-orm';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { keyStoreFromConfig } from '../auth/key-store.ts';
import { hashKey } from '../auth/keys.ts';
import { createDb, type Db } from '../db/client.ts';
import { apiKeys, tenants } from '../db/schema.ts';
import { cleanup, testConfig } from '../test-env.ts';

const run = promisify(execFile);
const cliPath = fileURLToPath(new URL('./keys.ts', import.meta.url));
const config = testConfig();
let handle: Db;
let redis: Redis;
const tenantNames: string[] = [];

// Runs the real CLI as a child process with this test run's config in its environment.
const cli = (...args: string[]) =>
  run(process.execPath, [cliPath, ...args], {
    env: {
      ...process.env,
      DATABASE_URL: config.databaseUrl,
      REDIS_URL: config.redisUrl!,
      REDIS_KEY_PREFIX: config.redisKeyPrefix,
      API_KEY_PEPPER: config.apiKeyPepper,
    },
  });

const newTenant = async () => {
  const name = `cli-${randomBytes(6).toString('hex')}`;
  tenantNames.push(name);
  await cli('create-tenant', name);
  return name;
};

beforeAll(() => {
  handle = createDb({ databaseUrl: config.databaseUrl, poolSize: 2 });
  redis = new Redis(config.redisUrl!);
});

afterAll(async () => {
  for (const name of tenantNames) {
    const [t] = await handle.db.select().from(tenants).where(eq(tenants.name, name));
    if (t) await cleanup(handle.db, null, [t.id], '');
  }
  await cleanup(handle.db, redis, [], config.redisKeyPrefix);
  redis.disconnect();
  await handle.close();
});

describe('keys CLI', () => {
  it('create-key prints the key once and stores only its hash', async () => {
    const tenant = await newTenant();
    const { stdout, stderr } = await cli('create-key', tenant, 'ci');
    const key = stdout.trim();
    expect(key).toMatch(/^gw_[A-Za-z0-9_-]{43}$/);
    expect(stderr).not.toContain(key);

    const rows = await handle.db.select().from(apiKeys).where(eq(apiKeys.keyHash, hashKey(config.apiKeyPepper, key)));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.prefix).toBe(key.slice(0, 12));
    expect(JSON.stringify(rows[0])).not.toContain(key);
    // The key appears nowhere in the table, in any column.
    const raw = await handle.pool.query('select count(*)::int as n from api_keys where api_keys::text like $1', [`%${key}%`]);
    expect(raw.rows[0].n).toBe(0);
    // Listing shows the prefix, never the key.
    const listed = await cli('list-keys', tenant);
    expect(listed.stdout).toContain(key.slice(0, 12));
    expect(listed.stdout).not.toContain(key);
  });

  it('revoke-key by prefix revokes exactly one key', async () => {
    const tenant = await newTenant();
    const a = (await cli('create-key', tenant)).stdout.trim();
    const b = (await cli('create-key', tenant)).stdout.trim();
    expect(a.slice(0, 12)).not.toBe(b.slice(0, 12));
    const store = keyStoreFromConfig(config, handle.db, redis);
    const hashA = hashKey(config.apiKeyPepper, a);
    const hashB = hashKey(config.apiKeyPepper, b);
    // Both are valid and cached before the revoke.
    expect(await store.lookup(hashA)).not.toBeNull();
    expect(await store.lookup(hashB)).not.toBeNull();

    // Two active rows sharing a prefix: revoking by it is refused and revokes neither.
    const [t] = await handle.db.select().from(tenants).where(eq(tenants.name, tenant));
    const shared = `gw_${randomBytes(3).toString('hex')}`;
    await handle.db.insert(apiKeys).values([
      { tenantId: t!.id, keyHash: randomBytes(32).toString('hex'), prefix: `${shared}AAAAAA` },
      { tenantId: t!.id, keyHash: randomBytes(32).toString('hex'), prefix: `${shared}BBBBBB` },
    ]);
    await expect(cli('revoke-key', shared)).rejects.toThrow(/matches 2 active keys/);
    await expect(cli('revoke-key', 'gw_')).rejects.toThrow(/at least 6/);
    const stillActive = await handle.db.select().from(apiKeys).where(eq(apiKeys.tenantId, t!.id));
    expect(stillActive.filter((r) => r.revokedAt !== null)).toHaveLength(0);
    expect(stillActive).toHaveLength(4);
    expect(await store.lookup(hashA)).not.toBeNull();
    expect(await store.lookup(hashB)).not.toBeNull();

    const out = await cli('revoke-key', a.slice(0, 12));
    expect(out.stdout).toContain(a.slice(0, 12));
    expect(await store.lookup(hashA)).toBeNull();
    expect(await store.lookup(hashB)).not.toBeNull();
    const rows = await handle.db.select({ h: apiKeys.keyHash, r: apiKeys.revokedAt }).from(apiKeys);
    expect(rows.find((r) => r.h === hashA)!.r).not.toBeNull();
    expect(rows.find((r) => r.h === hashB)!.r).toBeNull();
  });
});
