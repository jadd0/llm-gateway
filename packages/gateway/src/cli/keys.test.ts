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
const cli = (...args: string[]) => cliWith({}, ...args);
const cliWith = (extra: Record<string, string>, ...args: string[]) =>
  run(process.execPath, [cliPath, ...args], {
    env: {
      ...process.env,
      DATABASE_URL: config.databaseUrl,
      REDIS_URL: config.redisUrl!,
      REDIS_KEY_PREFIX: config.redisKeyPrefix,
      API_KEY_PEPPER: config.apiKeyPepper,
      ...extra,
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

// Each test spawns real CLI processes (node start-up, DB and Redis connects), and a revoke against an
// unreachable Redis waits waitReady's full 2 s, so the 5 s default is too tight under load.
describe('keys CLI', { timeout: 30_000 }, () => {
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
    await expect(cli('revoke-key', shared)).rejects.toThrow(/matches 2 keys/);
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

  it('revoke-key prefers the one active key when revoked keys share its prefix', async () => {
    const tenant = await newTenant();
    const [t] = await handle.db.select().from(tenants).where(eq(tenants.name, tenant));
    const shared = `gw_${randomBytes(3).toString('hex')}`;
    const activeHash = randomBytes(32).toString('hex');
    await handle.db.insert(apiKeys).values([
      { tenantId: t!.id, keyHash: randomBytes(32).toString('hex'), prefix: `${shared}OLD001`, revokedAt: new Date() },
      { tenantId: t!.id, keyHash: activeHash, prefix: `${shared}LIVE01` },
    ]);
    const out = await cli('revoke-key', shared);
    expect(out.stdout).toContain(`${shared}LIVE01`);
    const [row] = await handle.db.select().from(apiKeys).where(eq(apiKeys.keyHash, activeHash));
    expect(row!.revokedAt).not.toBeNull();
  });

  it('revoke-key is repeatable: a second run rewrites the tombstone, and a failed one can be retried', async () => {
    const tenant = await newTenant();
    const key = (await cli('create-key', tenant)).stdout.trim();
    const prefix = key.slice(0, 12);
    const hash = hashKey(config.apiKeyPepper, key);
    const redisKey = `${config.redisKeyPrefix}apikey:${hash}`;
    const store = keyStoreFromConfig(config, handle.db, redis);
    expect(await store.lookup(hash)).not.toBeNull(); // cached as valid

    // Redis unreachable: Postgres is updated, the command fails, the cached copy is still valid.
    await expect(cliWith({ REDIS_URL: 'redis://127.0.0.1:1' }, 'revoke-key', prefix)).rejects.toThrow(/redis unreachable/);
    expect(await redis.get(redisKey)).toContain('tenantId');

    // Run again with Redis up: succeeds and clears the cached valid entry.
    const again = await cli('revoke-key', prefix);
    expect(again.stdout).toContain('was already revoked; tombstone refreshed');
    expect(await redis.get(redisKey)).toBe('revoked');

    // A third run refreshes the tombstone after it went missing.
    await redis.del(redisKey);
    expect((await cli('revoke-key', prefix)).stdout).toContain('tombstone refreshed');
    expect(await redis.get(redisKey)).toBe('revoked');

    // Only a prefix matching nothing is an error.
    await expect(cli('revoke-key', 'gw_nomatch0000')).rejects.toThrow(/no key with prefix/);
  });
});
