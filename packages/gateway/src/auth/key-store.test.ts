import { eq } from 'drizzle-orm';
import { apiKeys, tenants } from '../db/schema.ts';
import { hashKey } from './keys.ts';
import type { Redis } from 'ioredis';
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, type Db } from '../db/client.ts';
import { createRedis } from '../redis.ts';
import { cleanup, seedKey, testConfig } from '../test-env.ts';
import { keyStoreFromConfig, type KeyStoreOptions } from './key-store.ts';
import type { Config } from '../config.ts';

const config: Config = testConfig();
let handle: Db;
let redis: Redis;
const tenantIds: string[] = [];
let queries = 0;
// When set, the next Postgres query returns its result only after the gate opens, which lets a test
// land a revoke between a lookup's read and its cache fill.
let gate: { held: boolean; open: () => void; wait: Promise<void> } | null = null;

const storeFor = (r: Redis | null, log?: KeyStoreOptions['log']) =>
  keyStoreFromConfig(config, handle.db, r, log);

const caller = (
  s: { tenantId: string; tenant: string; keyId: string },
  limits: { rpm?: number; tpm?: number; budget?: number } = {},
) => ({
  tenantId: s.tenantId,
  tenantName: s.tenant,
  keyId: s.keyId,
  rpmLimit: limits.rpm ?? null,
  tpmLimit: limits.tpm ?? null,
  monthlyBudgetMicros: limits.budget ?? null,
  cacheShared: false,
});

const seed = async () => {
  const s = await seedKey(handle.db, config);
  tenantIds.push(s.tenantId);
  return s;
};

beforeAll(() => {
  handle = createDb({ databaseUrl: config.databaseUrl, poolSize: 5 });
  redis = createRedis(config.redisUrl!);
  const real = handle.pool.query.bind(handle.pool) as (...a: unknown[]) => Promise<unknown>;
  (handle.pool as unknown as { query: unknown }).query = async (...args: unknown[]) => {
    queries++;
    const result = await real(...args);
    if (gate && !gate.held) {
      gate.held = true;
      await gate.wait;
    }
    return result;
  };
});

afterAll(async () => {
  await cleanup(handle.db, redis, tenantIds, config.redisKeyPrefix);
  redis.disconnect();
  await handle.close();
});

describe('key store', () => {
  it('cache miss reads Postgres then serves the next lookup from Redis', async () => {
    const s = await seed();
    const store = storeFor(redis);
    queries = 0;
    expect(await store.lookup(s.hash)).toEqual(caller(s));
    expect(queries).toBe(1);
    expect(await redis.get(`${config.redisKeyPrefix}apikey:${s.hash}`)).toContain(s.tenantId);
    expect(await store.lookup(s.hash)).toEqual(caller(s));
    expect(queries).toBe(1);
  });

  it('limits are carried in the cached entry and a limit change is visible on the next lookup', async () => {
    const s = await seedKey(handle.db, config, { rpm: 100, tpm: 50_000 });
    tenantIds.push(s.tenantId);
    const store = storeFor(redis);
    expect(await store.lookup(s.hash)).toEqual(caller(s, { rpm: 100, tpm: 50_000 }));
    expect(await redis.get(`${config.redisKeyPrefix}apikey:${s.hash}`)).toContain('"rpmLimit":100');
    expect(await store.setLimits(s.hash, { rpm: 7, tpm: null })).toMatchObject({ updated: true, cached: true, rpm: 7, tpm: null });
    queries = 0;
    expect(await store.lookup(s.hash)).toEqual(caller(s, { rpm: 7 }));
    expect(queries).toBe(0); // served from the overwritten cache entry, not Postgres
    // A second gateway (its own store, same Redis) sees the change too.
    expect(await storeFor(redis).lookup(s.hash)).toEqual(caller(s, { rpm: 7 }));
  });

  it('two concurrent set-limits on different fields both stick', async () => {
    const s = await seedKey(handle.db, config, { rpm: 10, tpm: 20 });
    tenantIds.push(s.tenantId);
    const store = storeFor(redis);
    for (let round = 0; round < 20; round++) {
      await Promise.all([store.setLimits(s.hash, { rpm: 100 + round }), store.setLimits(s.hash, { tpm: 200 + round })]);
      const [row] = await handle.db.select().from(apiKeys).where(eq(apiKeys.keyHash, s.hash));
      expect(row).toMatchObject({ rpmLimit: 100 + round, tpmLimit: 200 + round });
    }
    await expect(store.setLimits(s.hash, {})).rejects.toThrow('no limits given');
  });

  it('setLimits never overwrites a tombstone and ignores revoked keys', async () => {
    const s = await seed();
    const store = storeFor(redis);
    expect(await store.lookup(s.hash)).not.toBeNull();
    await store.revoke(s.hash);
    expect(await store.setLimits(s.hash, { rpm: 1, tpm: 1 })).toMatchObject({ updated: false, cached: false });
    expect(await store.lookup(s.hash)).toBeNull();
    // The tombstone alone, with an active row (a revoke that lost the race to a limit change): it wins.
    const t = await seed();
    const key = `${config.redisKeyPrefix}apikey:${t.hash}`;
    await redis.set(key, 'revoked', 'EX', 60);
    expect(await store.setLimits(t.hash, { rpm: 1, tpm: 1 })).toMatchObject({ updated: true, cached: true });
    expect(await redis.get(key)).toBe('revoked');
  });

  it('unknown key is negatively cached', async () => {
    const store = storeFor(redis);
    const hash = randomBytes(32).toString('hex');
    queries = 0;
    expect(await store.lookup(hash)).toBeNull();
    expect(await store.lookup(hash)).toBeNull();
    expect(queries).toBe(1);
    expect(await redis.get(`${config.redisKeyPrefix}apikey:${hash}`)).toBe('unknown');
    const ttl = await redis.ttl(`${config.redisKeyPrefix}apikey:${hash}`);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(config.authNegativeTtlS);
  });

  it('revoke takes effect on the very next lookup', async () => {
    const s = await seed();
    const store = storeFor(redis);
    expect(await store.lookup(s.hash)).not.toBeNull(); // cached as valid
    expect(await store.revoke(s.hash)).toEqual({ revoked: true, tombstoned: true });
    expect(await store.lookup(s.hash)).toBeNull();
    // Revoking again finds no active key.
    expect((await store.revoke(s.hash)).revoked).toBe(false);
  });

  it('revoke racing a cache fill cannot leave the key cached as valid', async () => {
    const s = await seed();
    const store = storeFor(redis);
    let open!: () => void;
    const wait = new Promise<void>((r) => (open = r));
    gate = { held: false, open, wait };
    // The lookup misses Redis and reads Postgres (valid), then stalls before filling the cache.
    const stale = store.lookup(s.hash);
    const end = Date.now() + 2000;
    while (!gate.held && Date.now() < end) await new Promise((r) => setTimeout(r, 5));
    expect(gate.held).toBe(true);
    const g = gate;
    gate = null;
    expect((await store.revoke(s.hash)).revoked).toBe(true);
    g.open();
    // The racing request itself read Postgres before the revoke, so it may see the key as valid.
    await stale;
    // Its NX fill must have lost to the tombstone.
    expect(await redis.get(`${config.redisKeyPrefix}apikey:${s.hash}`)).toBe('revoked');
    expect(await store.lookup(s.hash)).toBeNull();
  });

  it('Redis down falls back to Postgres and still rejects a revoked key', async () => {
    const live = await seed();
    const dead = await seed();
    const warns: object[] = [];
    const deadRedis = createRedis('redis://127.0.0.1:1', { startupGraceMs: 0 });
    try {
      const store = storeFor(deadRedis, { warn: () => warns.push({}), info: () => {} });
      expect(await store.lookup(live.hash)).toEqual(caller(live));
      expect(await store.lookup(live.hash)).not.toBeNull();
      expect(await store.lookup(randomBytes(32).toString('hex'))).toBeNull();
      expect(warns).toHaveLength(1); // three failed reads, one warn
      // Revoked in Postgres while Redis is unreachable: no tombstone is possible, the key is still rejected.
      expect(await store.revoke(dead.hash)).toEqual({ revoked: true, tombstoned: false });
      expect(await store.lookup(dead.hash)).toBeNull();
      expect(warns).toHaveLength(2); // plus the failed tombstone write
    } finally {
      deadRedis.disconnect();
    }
  });

  it('AUTH_CACHE=none queries Postgres on every lookup', async () => {
    const s = await seed();
    const store = storeFor(null);
    queries = 0;
    await store.lookup(s.hash);
    await store.lookup(s.hash);
    expect(queries).toBe(2);
  });

  it('revoke right after the Redis client is created still tombstones', async () => {
    const s = await seed();
    const fresh = createRedis(config.redisUrl!);
    try {
      expect(fresh.status).not.toBe('ready');
      expect(await storeFor(fresh).revoke(s.hash)).toEqual({ revoked: true, tombstoned: true });
      expect(await redis.get(`${config.redisKeyPrefix}apikey:${s.hash}`)).toBe('revoked');
    } finally {
      fresh.disconnect();
    }
  });

  it('a lookup on a client that is still connecting logs no outage', async () => {
    const s = await seed();
    const warns: object[] = [];
    const fresh = createRedis(config.redisUrl!);
    try {
      const store = storeFor(fresh, { warn: () => warns.push({}), info: () => {} });
      expect(await store.lookup(s.hash)).not.toBeNull(); // served from Postgres
      expect(warns).toHaveLength(0);
    } finally {
      fresh.disconnect();
    }
  });

  it('a corrupt cached value is treated as a miss and overwritten', async () => {
    const s = await seed();
    const key = `${config.redisKeyPrefix}apikey:${s.hash}`;
    await redis.set(key, '{not json', 'EX', 60);
    const warns: object[] = [];
    const store = storeFor(redis, { warn: () => warns.push({}), info: () => {} });
    queries = 0;
    expect(await store.lookup(s.hash)).toEqual(caller(s));
    expect(queries).toBe(1);
    expect(warns).toHaveLength(0);
    expect(await redis.get(key)).toContain(s.tenantId);
  });

  it('a cached entry from before budgets existed is a miss, so the real cap is read', async () => {
    const s = await seed();
    const key = `${config.redisKeyPrefix}apikey:${s.hash}`;
    await redis.set(
      key,
      JSON.stringify({ tenantId: s.tenantId, tenantName: s.tenant, keyId: s.keyId, rpmLimit: null, tpmLimit: null }),
      'EX',
      60,
    );
    await handle.db.update(tenants).set({ monthlyBudgetMicros: 12_345 }).where(eq(tenants.id, s.tenantId));
    queries = 0;
    expect(await storeFor(redis).lookup(s.hash)).toEqual(caller(s, { budget: 12_345 }));
    expect(queries).toBe(1);
    expect(await redis.get(key)).toContain('"monthlyBudgetMicros":12345');
  });

  it("setBudget overwrites the cached entry of every active key of the tenant and not a revoked one's", async () => {
    const a = await seed();
    const { createKey } = await import('../cli/keys.ts');
    const b = await createKey(handle.db, config.apiKeyPepper, a.tenant);
    const c = await createKey(handle.db, config.apiKeyPepper, a.tenant);
    const hashB = hashKey(config.apiKeyPepper, b.key);
    const hashC = hashKey(config.apiKeyPepper, c.key);
    const store = storeFor(redis);
    for (const h of [a.hash, hashB, hashC]) expect((await store.lookup(h))!.monthlyBudgetMicros).toBeNull();
    await store.revoke(hashC);
    expect(await store.setBudget(a.tenantId, 5_000_000)).toEqual({ updated: true, cached: true });
    queries = 0;
    expect((await store.lookup(a.hash))!.monthlyBudgetMicros).toBe(5_000_000);
    expect((await store.lookup(hashB))!.monthlyBudgetMicros).toBe(5_000_000);
    expect(queries).toBe(0); // both served from the overwritten entries
    expect(await store.lookup(hashC)).toBeNull(); // the tombstone survived
    expect(await store.setBudget(a.tenantId, null)).toEqual({ updated: true, cached: true });
    expect((await store.lookup(a.hash))!.monthlyBudgetMicros).toBeNull();
    expect(await store.setBudget('00000000-0000-4000-8000-000000000000', 1)).toEqual({ updated: false, cached: false });
  });

  it('a cached entry from before the response cache (no sharing flag) is a miss that reads the real flag', async () => {
    const s = await seed();
    const key = `${config.redisKeyPrefix}apikey:${s.hash}`;
    const store = storeFor(redis);
    expect((await store.lookup(s.hash))!.cacheShared).toBe(false);
    const { cacheShared: _dropped, ...old } = JSON.parse((await redis.get(key))!);
    await redis.set(key, JSON.stringify(old), 'EX', 60);
    expect(await store.setCacheShared(s.tenantId, true)).toEqual({ updated: true, cached: true });
    await redis.set(key, JSON.stringify(old), 'EX', 60); // an old-format entry again
    expect((await store.lookup(s.hash))!.cacheShared).toBe(true);
    expect(await redis.get(key)).toContain('"cacheShared":true');
    expect(await store.setCacheShared('00000000-0000-4000-8000-000000000000', true)).toEqual({ updated: false, cached: false });
  });

  it('a tombstone written after a corrupt value was read survives the fill', async () => {
    const s = await seed();
    const key = `${config.redisKeyPrefix}apikey:${s.hash}`;
    await redis.set(key, '{not json', 'EX', 60);
    const store = storeFor(redis);
    let open!: () => void;
    const wait = new Promise<void>((r) => (open = r));
    gate = { held: false, open, wait };
    const stale = store.lookup(s.hash); // reads the corrupt value, then Postgres (valid), then stalls
    const end = Date.now() + 2000;
    while (!gate.held && Date.now() < end) await new Promise((r) => setTimeout(r, 5));
    expect(gate.held).toBe(true);
    const g = gate;
    gate = null;
    expect((await store.revoke(s.hash)).tombstoned).toBe(true); // overwrites the corrupt value
    g.open();
    await stale;
    expect(await redis.get(key)).toBe('revoked');
    expect(await store.lookup(s.hash)).toBeNull();
  });

  it('one warn per outage start: a failed write, then cache hits, then a read outage', async () => {
    const warns: Array<{ op: string }> = [];
    const infos: object[] = [];
    const tenant = JSON.stringify({ tenantId: 't', tenantName: 'n', keyId: 'k', rpmLimit: null, tpmLimit: 7, monthlyBudgetMicros: null, cacheShared: false });
    let mode: 'miss' | 'hit' | 'down' = 'miss';
    const flaky = {
      status: 'ready',
      get: async () => {
        if (mode === 'down') throw new Error('ECONNRESET');
        return mode === 'hit' ? tenant : null;
      },
      set: async () => {
        throw Object.assign(new Error('READONLY'), { code: 'READONLY' });
      },
    } as unknown as Redis;
    const store = storeFor(flaky, { warn: (o) => warns.push(o as { op: string }), info: (o) => infos.push(o) });
    const hash = randomBytes(32).toString('hex');
    await store.lookup(hash); // miss: Postgres, then the fill fails
    mode = 'hit';
    for (let i = 0; i < 5; i++) expect(await store.lookup(hash)).toEqual({ tenantId: 't', tenantName: 'n', keyId: 'k', rpmLimit: null, tpmLimit: 7, monthlyBudgetMicros: null, cacheShared: false });
    expect(warns.map((w) => w.op)).toEqual(['set']);
    mode = 'down';
    await store.lookup(hash);
    await store.lookup(hash);
    expect(warns.map((w) => w.op)).toEqual(['set', 'get']);
    expect(infos).toHaveLength(0);
    mode = 'hit';
    await store.lookup(hash);
    expect(infos).toHaveLength(1); // the read outage ended
  });

  it('writes failing while reads succeed log one warn, not one per request', async () => {
    const warns: object[] = [];
    const infos: object[] = [];
    const readOnly = {
      status: 'ready',
      get: async () => null,
      set: async () => {
        throw Object.assign(new Error('READONLY'), { code: 'READONLY' });
      },
    } as unknown as Redis;
    const store = storeFor(readOnly, { warn: () => warns.push({}), info: () => infos.push({}) });
    for (let i = 0; i < 5; i++) expect(await store.lookup(randomBytes(32).toString('hex'))).toBeNull();
    expect(warns).toHaveLength(1);
    expect(infos).toHaveLength(0);
  });

  it('a valid cache-miss lookup does not wait for its token to be handed back', async () => {
    const s = await seed();
    let refunds = 0;
    const store = keyStoreFromConfig(config, handle.db, redis, undefined, async () => ({
      refused: false,
      refund: () => new Promise<void>((resolve) => setTimeout(() => (refunds++, resolve()), 400)),
    }));
    const started = performance.now();
    const tenant = await store.lookup(hashKey(config.apiKeyPepper, s.key), '203.0.113.5');
    const took = performance.now() - started;
    expect(tenant?.tenantId).toBe(s.tenantId);
    expect(refunds).toBe(0); // still in flight when the lookup returned
    expect(took).toBeLessThan(300);
    await new Promise((r) => setTimeout(r, 500));
    expect(refunds).toBe(1);
  });
});
