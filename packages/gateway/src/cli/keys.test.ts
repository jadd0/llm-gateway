import { execFile } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { eq } from 'drizzle-orm';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { keyStoreFromConfig } from '../auth/key-store.ts';
import { hashKey } from '../auth/keys.ts';
import { createDb, type Db } from '../db/client.ts';
import { periodOf } from '../budget/period.ts';
import { apiKeys, spendLedger, tenants, tenantSpend } from '../db/schema.ts';
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

  it('create-key --rpm --tpm stores the limits; set-limits changes them, in Postgres and in the cache', async () => {
    const tenant = await newTenant();
    const key = (await cli('create-key', tenant, '--rpm', '100', '--tpm', '50000')).stdout.trim();
    const hash = hashKey(config.apiKeyPepper, key);
    const row = async () => (await handle.db.select().from(apiKeys).where(eq(apiKeys.keyHash, hash)))[0]!;
    expect(await row()).toMatchObject({ rpmLimit: 100, tpmLimit: 50_000 });

    // The gateway has the key cached with the old limits.
    const store = keyStoreFromConfig(config, handle.db, redis);
    expect(await store.lookup(hash)).toMatchObject({ rpmLimit: 100, tpmLimit: 50_000 });

    const out = await cli('set-limits', key.slice(0, 12), '--rpm', '5');
    expect(out.stdout).toContain('rpm 5, tpm 50000');
    expect(await row()).toMatchObject({ rpmLimit: 5, tpmLimit: 50_000 }); // tpm untouched
    expect(await store.lookup(hash)).toMatchObject({ rpmLimit: 5, tpmLimit: 50_000 });

    await cli('set-limits', key.slice(0, 12), '--tpm', 'default');
    expect(await row()).toMatchObject({ rpmLimit: 5, tpmLimit: null });
    expect(await store.lookup(hash)).toMatchObject({ rpmLimit: 5, tpmLimit: null });
  });

  it('set-limits needs no pepper and no Redis for its database write; with a cache configured but no Redis it warns and exits 1', async () => {
    const tenant = await newTenant();
    const key = (await cli('create-key', tenant, '--rpm', '9')).stdout.trim();
    const row = async () =>
      (await handle.db.select().from(apiKeys).where(eq(apiKeys.keyHash, hashKey(config.apiKeyPepper, key))))[0];
    // AUTH_CACHE=none: nothing is cached, so there is nothing to refresh.
    const none = await cliWith({ API_KEY_PEPPER: '', REDIS_URL: '', AUTH_CACHE: 'none' }, 'set-limits', key.slice(0, 12), '--tpm', '4000');
    expect(none.stdout).toContain('rpm 9, tpm 4000');
    expect(await row()).toMatchObject({ rpmLimit: 9, tpmLimit: 4000 });
    // AUTH_CACHE=redis (the default) but no REDIS_URL: the database is written, the cache could not be.
    await expect(
      cliWith({ API_KEY_PEPPER: '', REDIS_URL: '' }, 'set-limits', key.slice(0, 12), '--rpm', '11'),
    ).rejects.toMatchObject({ stderr: expect.stringContaining('key cache was not refreshed') });
    expect(await row()).toMatchObject({ rpmLimit: 11, tpmLimit: 4000 });
  });

  it('limits that are not whole numbers are refused, and so is a revoked key', async () => {
    const tenant = await newTenant();
    const key = (await cli('create-key', tenant)).stdout.trim();
    for (const bad of ['0', '-1', '1.5', 'abc', '']) {
      await expect(cli('set-limits', key.slice(0, 12), `--rpm=${bad}`)).rejects.toMatchObject({
        stderr: expect.stringContaining('--rpm must be a whole number'),
      });
    }
    await expect(cli('set-limits', key.slice(0, 12))).rejects.toMatchObject({
      stderr: expect.stringContaining('give --rpm and/or --tpm'),
    });
    await cli('revoke-key', key.slice(0, 12));
    await expect(cli('set-limits', key.slice(0, 12), '--rpm', '5')).rejects.toMatchObject({
      stderr: expect.stringContaining('is revoked'),
    });
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

  it('set-budget then show-spend', async () => {
    const tenant = await newTenant();
    const key = (await cli('create-key', tenant)).stdout.trim();
    const hash = hashKey(config.apiKeyPepper, key);
    const store = keyStoreFromConfig(config, handle.db, redis);
    expect((await store.lookup(hash))!.monthlyBudgetMicros).toBeNull(); // cached with no cap of its own

    const set = await cli('set-budget', tenant, '--monthly-usd', '0.01');
    expect(set.stdout).toContain('monthly budget $0.010000');
    const [row] = await handle.db.select().from(tenants).where(eq(tenants.name, tenant));
    expect(row!.monthlyBudgetMicros).toBe(10_000);
    expect((await store.lookup(hash))!.monthlyBudgetMicros).toBe(10_000); // the cached entry was overwritten

    const period = periodOf(Date.now());
    expect((await cli('show-spend', tenant)).stdout).toContain(`${tenant} ${period}: spent $0.000000 (cap $0.010000)`);
    await handle.db.insert(tenantSpend).values({ tenantId: row!.id, period, spentMicros: 1_234_567 });
    await handle.db.insert(tenantSpend).values({ tenantId: row!.id, period: '2020-01', spentMicros: 5 });
    expect((await cli('show-spend', tenant)).stdout).toContain('spent $1.234567');
    expect((await cli('show-spend', tenant, '--period', '2020-01')).stdout).toContain('2020-01: spent $0.000005');

    await cli('set-budget', tenant, '--monthly-usd', 'default');
    expect((await handle.db.select().from(tenants).where(eq(tenants.name, tenant)))[0]!.monthlyBudgetMicros).toBeNull();
    expect((await cli('show-spend', tenant)).stdout).toContain('(default cap)');
  });

  it('a budget that is not a plain USD amount is refused, as is an unknown tenant or period', async () => {
    const tenant = await newTenant();
    for (const bad of ['0.0000001', '1e3', '-5', '', 'ten', '1,5']) {
      await expect(cli('set-budget', tenant, `--monthly-usd=${bad}`)).rejects.toMatchObject({
        stderr: expect.stringContaining('--monthly-usd must be a USD amount'),
      });
    }
    await expect(cli('set-budget', tenant)).rejects.toMatchObject({ stderr: expect.stringContaining('usage:') });
    await expect(cli('set-budget', 'no-such-tenant', '--monthly-usd', '1')).rejects.toMatchObject({
      stderr: expect.stringContaining('no tenant named'),
    });
    await expect(cli('show-spend', tenant, '--period', '2026-13')).rejects.toMatchObject({
      stderr: expect.stringContaining('--period must look like'),
    });
    const [row] = await handle.db.select().from(tenants).where(eq(tenants.name, tenant));
    expect(row!.monthlyBudgetMicros).toBeNull(); // nothing was written by the refused calls
  });

  it('set-cache-sharing toggles the flag and refreshes the key cache', async () => {
    const tenant = await newTenant();
    const key = (await cli('create-key', tenant)).stdout.trim();
    const hash = hashKey(config.apiKeyPepper, key);
    const store = keyStoreFromConfig(config, handle.db, redis);
    expect((await store.lookup(hash))!.cacheShared).toBe(false); // cached as private

    expect((await cli('set-cache-sharing', tenant, 'on')).stdout).toContain(`${tenant}: response cache shared`);
    const [row] = await handle.db.select().from(tenants).where(eq(tenants.name, tenant));
    expect(row!.cacheShared).toBe(true);
    expect((await store.lookup(hash))!.cacheShared).toBe(true); // the cached entry was overwritten

    expect((await cli('set-cache-sharing', tenant, 'off')).stdout).toContain('response cache private');
    expect((await store.lookup(hash))!.cacheShared).toBe(false);

    for (const bad of ['yes', 'ON', '']) {
      await expect(cli('set-cache-sharing', tenant, bad)).rejects.toMatchObject({ stderr: expect.stringContaining('"on" or "off"') });
    }
    await expect(cli('set-cache-sharing', tenant)).rejects.toMatchObject({ stderr: expect.stringContaining('usage:') });
    await expect(cli('set-cache-sharing', 'no-such-tenant', 'on')).rejects.toMatchObject({ stderr: expect.stringContaining('no tenant named') });
    expect((await handle.db.select().from(tenants).where(eq(tenants.name, tenant)))[0]!.cacheShared).toBe(false);
  });

  it('set-semantic-cache toggles the switch and refreshes the key cache', async () => {
    const tenant = await newTenant();
    const key = (await cli('create-key', tenant)).stdout.trim();
    const hash = hashKey(config.apiKeyPepper, key);
    const store = keyStoreFromConfig(config, handle.db, redis);
    expect((await store.lookup(hash))!.semanticCache).toBe(true); // on by default

    expect((await cli('set-semantic-cache', tenant, 'off')).stdout).toContain(`${tenant}: semantic cache off`);
    expect((await handle.db.select().from(tenants).where(eq(tenants.name, tenant)))[0]!.semanticCache).toBe(false);
    expect((await store.lookup(hash))!.semanticCache).toBe(false); // the cached entry was overwritten
    expect((await cli('set-semantic-cache', tenant, 'on')).stdout).toContain('semantic cache on');
    expect((await store.lookup(hash))!.semanticCache).toBe(true);

    for (const bad of ['yes', 'ON', '']) {
      await expect(cli('set-semantic-cache', tenant, bad)).rejects.toMatchObject({ stderr: expect.stringContaining('"on" or "off"') });
    }
    await expect(cli('set-semantic-cache', tenant)).rejects.toMatchObject({ stderr: expect.stringContaining('usage:') });
    await expect(cli('set-semantic-cache', 'no-such-tenant', 'on')).rejects.toMatchObject({ stderr: expect.stringContaining('no tenant named') });
  });

  it('show-spend prints cache hits and what they saved, not counting ordinary rows', async () => {
    const tenant = await newTenant();
    const [row] = await handle.db.select().from(tenants).where(eq(tenants.name, tenant));
    const period = periodOf(Date.now());
    const base = { tenantId: row!.id, period, model: 'mock-1', promptTokens: 10, completionTokens: 5, estimated: false };
    await handle.db.insert(spendLedger).values([
      { ...base, requestId: randomUUID(), costMicros: 400 },
      { ...base, requestId: randomUUID(), costMicros: 0, cached: true, cacheKind: 'exact', savedMicros: 400 },
      { ...base, requestId: randomUUID(), costMicros: 0, cached: true, cacheKind: 'semantic', savedMicros: 350 },
    ]);
    expect((await cli('show-spend', tenant)).stdout).toContain('cache hits 2 (exact 1, semantic 1), saved $0.000750');
  });
});
