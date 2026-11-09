import type { Redis } from 'ioredis';
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, type Db } from '../db/client.ts';
import { createRedis } from '../redis.ts';
import { cleanup, seedKey, testConfig } from '../test-env.ts';
import { createKeyStore } from './key-store.ts';
import type { Config } from '../config.ts';

const config: Config = testConfig();
let handle: Db;
let redis: Redis;
const tenantIds: string[] = [];
let queries = 0;
// When set, the next Postgres query returns its result only after the gate opens, which lets a test
// land a revoke between a lookup's read and its cache fill.
let gate: { held: boolean; open: () => void; wait: Promise<void> } | null = null;

const storeFor = (r: Redis | null, log?: { warn: () => void; info: () => void }) =>
  createKeyStore({
    db: handle.db,
    redis: r,
    keyPrefix: config.redisKeyPrefix,
    cacheTtlS: config.authCacheTtlS,
    negativeTtlS: config.authNegativeTtlS,
    tombstoneTtlS: config.authTombstoneTtlS,
    ...(log ? { log } : {}),
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
    expect(await store.lookup(s.hash)).toEqual({ tenantId: s.tenantId, tenantName: s.tenant });
    expect(queries).toBe(1);
    expect(await redis.get(`${config.redisKeyPrefix}apikey:${s.hash}`)).toContain(s.tenantId);
    expect(await store.lookup(s.hash)).toEqual({ tenantId: s.tenantId, tenantName: s.tenant });
    expect(queries).toBe(1);
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
    const deadRedis = createRedis('redis://127.0.0.1:1');
    try {
      const store = storeFor(deadRedis, { warn: () => warns.push({}), info: () => {} });
      expect(await store.lookup(live.hash)).toEqual({ tenantId: live.tenantId, tenantName: live.tenant });
      expect(await store.lookup(live.hash)).not.toBeNull();
      expect(await store.lookup(randomBytes(32).toString('hex'))).toBeNull();
      // Revoked in Postgres while Redis is unreachable: no tombstone is possible, the key is still rejected.
      expect(await store.revoke(dead.hash)).toEqual({ revoked: true, tombstoned: false });
      expect(await store.lookup(dead.hash)).toBeNull();
      expect(warns).toHaveLength(1);
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
});
