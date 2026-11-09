import { and, eq, isNull, sql } from 'drizzle-orm';
import type { Redis } from 'ioredis';
import type { Config } from '../config.ts';
import type { Db } from '../db/client.ts';
import { isStarting, waitReady } from '../redis.ts';
import { apiKeys, tenants } from '../db/schema.ts';

export interface Tenant {
  tenantId: string;
  tenantName: string;
  /** The API key's own id: what its rate-limit buckets are named after. */
  keyId: string;
  /** Per-minute limits set on this key; null means the gateway-wide default. */
  rpmLimit: number | null;
  tpmLimit: number | null;
  /** The tenant's monthly spend cap in micro-USD; null means the gateway-wide default. */
  monthlyBudgetMicros: number | null;
}

/** A limit that is left out is left as it is; null sets the key back to the gateway default. */
export interface Limits {
  rpm?: number | null | undefined;
  tpm?: number | null | undefined;
}

export interface KeyStore {
  /** The tenant a key hash belongs to, or null for unknown and revoked keys. */
  lookup(keyHash: string): Promise<Tenant | null>;
  /**
   * Revokes in Postgres, then writes a tombstone to Redis. `revoked` is false when no active key had
   * this hash; `tombstoned` is false when Redis was unreachable, in which case a cached copy of the
   * key can keep working until its cache TTL runs out.
   */
  revoke(keyHash: string): Promise<{ revoked: boolean; tombstoned: boolean }>;
  /**
   * Writes the limits in Postgres, then overwrites the cached entry so the next request on any
   * gateway sees them. `updated` is false when no active key had this hash; `cached` is false when
   * Redis was unreachable, in which case a cached copy keeps the old limits until its TTL runs out.
   */
  setLimits(
    keyHash: string,
    limits: Limits,
  ): Promise<{ updated: boolean; cached: boolean; rpm: number | null; tpm: number | null }>;
  /**
   * Writes the tenant's monthly cap (null = the gateway default) in Postgres, then overwrites the
   * cached entry of each of its active keys. `updated` is false when there is no such tenant;
   * `cached` is false when Redis was unreachable for any of them, in which case a cached copy keeps
   * the old cap until its TTL runs out.
   */
  setBudget(tenantId: string, micros: number | null): Promise<{ updated: boolean; cached: boolean }>;
}

export interface KeyStoreOptions {
  db: Db['db'];
  /** null disables the cache: every lookup queries Postgres. */
  redis: Redis | null;
  keyPrefix: string;
  cacheTtlS: number;
  negativeTtlS: number;
  tombstoneTtlS: number;
  log?: { warn(obj: object, msg: string): void; info(obj: object, msg: string): void };
}

const DEL_IF_EQUAL = "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end";
// Overwrites a cache entry unless it is a tombstone: a revoke that lands between the Postgres update
// and this write must still win.
const SET_UNLESS_REVOKED =
  "if redis.call('get', KEYS[1]) == ARGV[1] then return 0 end redis.call('set', KEYS[1], ARGV[2], 'EX', ARGV[3]) return 1";
const REVOKED = 'revoked';
const UNKNOWN = 'unknown';

export function createKeyStore(opts: KeyStoreOptions): KeyStore {
  const { db, redis } = opts;
  const redisKey = (hash: string) => `${opts.keyPrefix}apikey:${hash}`;

  // A failed read is an outage (warned once, ended by the next successful read). A failed write is
  // tracked on its own, so a write that keeps failing while reads succeed (out of memory, read-only
  // replica) warns once instead of on every request, and a workload of pure cache hits still ends a
  // read outage. A successful write ends the write outage.
  const down = { get: false, set: false };
  const redisFailed = (op: 'get' | 'set', err: unknown) => {
    // A client that has not finished its first connection is connecting, not down.
    if (redis !== null && isStarting(redis)) return;
    if (down[op]) return;
    down[op] = true;
    opts.log?.warn(
      { errClass: (err as Error).name, code: (err as { code?: string }).code, op },
      'redis unavailable, auth falling back to postgres',
    );
  };
  const redisOk = (op: 'get' | 'set') => {
    if (!down[op]) return;
    down[op] = false;
    opts.log?.info({ op }, 'redis available again');
  };

  async function fromPostgres(hash: string): Promise<Tenant | null> {
    const rows = await db
      .select({
        tenantId: tenants.id,
        tenantName: tenants.name,
        keyId: apiKeys.id,
        rpmLimit: apiKeys.rpmLimit,
        tpmLimit: apiKeys.tpmLimit,
        monthlyBudgetMicros: tenants.monthlyBudgetMicros,
      })
      .from(apiKeys)
      .innerJoin(tenants, eq(tenants.id, apiKeys.tenantId))
      .where(and(eq(apiKeys.keyHash, hash), isNull(apiKeys.revokedAt)))
      .limit(1);
    return rows[0] ?? null;
  }

  const parseTenant = (raw: string): Tenant | undefined => {
    try {
      const v = JSON.parse(raw) as Partial<Tenant> | null;
      const limit = (n: unknown) => (n === null ? null : Number.isInteger(n) ? (n as number) : undefined);
      if (typeof v?.tenantId !== 'string' || typeof v.tenantName !== 'string' || typeof v.keyId !== 'string') {
        return undefined;
      }
      const rpmLimit = limit(v.rpmLimit);
      const tpmLimit = limit(v.tpmLimit);
      // An entry from before budgets existed has no such field: a miss, so the real cap is read.
      const monthlyBudgetMicros = limit(v.monthlyBudgetMicros);
      if (rpmLimit === undefined || tpmLimit === undefined || monthlyBudgetMicros === undefined) return undefined;
      return { tenantId: v.tenantId, tenantName: v.tenantName, keyId: v.keyId, rpmLimit, tpmLimit, monthlyBudgetMicros };
    } catch {
      return undefined;
    }
  };

  return {
    async lookup(hash) {
      if (redis === null) return fromPostgres(hash);

      const key = redisKey(hash);
      let cached: string | null;
      try {
        cached = await redis.get(key);
        redisOk('get');
      } catch (err) {
        // Postgres is the source of truth, so a dead cache costs latency, never correctness.
        redisFailed('get', err);
        return fromPostgres(hash);
      }
      if (cached === REVOKED || cached === UNKNOWN) return null;
      let corrupt: string | undefined;
      if (cached !== null) {
        const hit = parseTenant(cached);
        if (hit) return hit;
        corrupt = cached; // not a value this store wrote: treat as a miss and replace it
      }

      const tenant = await fromPostgres(hash);
      try {
        const value = tenant ? JSON.stringify(tenant) : UNKNOWN;
        const ttl = tenant ? opts.cacheTtlS : opts.negativeTtlS;
        // A corrupt entry is removed only if it is still the same corrupt string, so a tombstone
        // written since the read survives. Every fill is NX: it never overwrites a tombstone.
        if (corrupt !== undefined) await redis.eval(DEL_IF_EQUAL, 1, key, corrupt);
        await redis.set(key, value, 'EX', ttl, 'NX');
        redisOk('set');
      } catch (err) {
        redisFailed('set', err);
      }
      return tenant;
    },

    async revoke(hash) {
      // Postgres first: once this returns, no fill can ever re-cache the key as valid.
      const updated = await db
        .update(apiKeys)
        .set({ revokedAt: sql`now()` })
        .where(and(eq(apiKeys.keyHash, hash), isNull(apiKeys.revokedAt)))
        .returning({ id: apiKeys.id });
      let tombstoned = false;
      if (redis !== null) {
        // A client created a moment ago may not be connected yet; commands sent before then fail.
        if (!(await waitReady(redis, 2000))) {
          redisFailed('set', new Error('redis not ready'));
        } else {
          try {
            // Plain SET (no NX): it must overwrite a cached "valid" entry.
            await redis.set(redisKey(hash), REVOKED, 'EX', opts.tombstoneTtlS);
            tombstoned = true;
            redisOk('set');
          } catch (err) {
            redisFailed('set', err);
          }
        }
      }
      return { revoked: updated.length > 0, tombstoned };
    },

    async setLimits(hash, limits) {
      if (limits.rpm === undefined && limits.tpm === undefined) throw new Error('no limits given');
      // Postgres first, and only the named columns are written, so two changes to different limits
      // cannot undo each other. The cache is rewritten from the row, so a concurrent fill can only
      // ever carry the new limits or lose to them.
      const updated = await db
        .update(apiKeys)
        .set({
          ...(limits.rpm !== undefined ? { rpmLimit: limits.rpm } : {}),
          ...(limits.tpm !== undefined ? { tpmLimit: limits.tpm } : {}),
        })
        .where(and(eq(apiKeys.keyHash, hash), isNull(apiKeys.revokedAt)))
        .returning({ id: apiKeys.id, rpm: apiKeys.rpmLimit, tpm: apiKeys.tpmLimit });
      if (updated.length === 0) return { updated: false, cached: false, rpm: null, tpm: null };
      let cached = false;
      if (redis !== null) {
        const tenant = await fromPostgres(hash);
        if (tenant !== null) {
          if (!(await waitReady(redis, 2000))) {
            redisFailed('set', new Error('redis not ready'));
          } else {
            try {
              // Not NX: it must replace the entry that holds the old limits.
              await redis.eval(SET_UNLESS_REVOKED, 1, redisKey(hash), REVOKED, JSON.stringify(tenant), opts.cacheTtlS);
              cached = true;
              redisOk('set');
            } catch (err) {
              redisFailed('set', err);
            }
          }
        }
      }
      return { updated: true, cached, rpm: updated[0]!.rpm, tpm: updated[0]!.tpm };
    },

    async setBudget(tenantId, micros) {
      const updated = await db
        .update(tenants)
        .set({ monthlyBudgetMicros: micros })
        .where(eq(tenants.id, tenantId))
        .returning({ id: tenants.id });
      if (updated.length === 0) return { updated: false, cached: false };
      if (redis === null) return { updated: true, cached: false };
      // The cap is on the tenant but the cache is per key: rewrite every active key's entry from the row.
      const hashes = await db
        .select({ keyHash: apiKeys.keyHash })
        .from(apiKeys)
        .where(and(eq(apiKeys.tenantId, tenantId), isNull(apiKeys.revokedAt)));
      let cached = true;
      if (hashes.length > 0 && !(await waitReady(redis, 2000))) {
        redisFailed('set', new Error('redis not ready'));
        return { updated: true, cached: false };
      }
      for (const { keyHash } of hashes) {
        const tenant = await fromPostgres(keyHash);
        if (tenant === null) continue; // revoked since the list was read
        try {
          await redis.eval(SET_UNLESS_REVOKED, 1, redisKey(keyHash), REVOKED, JSON.stringify(tenant), opts.cacheTtlS);
          redisOk('set');
        } catch (err) {
          redisFailed('set', err);
          cached = false;
        }
      }
      return { updated: true, cached };
    },
  };
}

// The one place a key store is built from config, so the gateway and the CLI cannot disagree on
// the Redis prefix or TTLs.
export function keyStoreFromConfig(
  config: Pick<Config, 'redisKeyPrefix' | 'authCacheTtlS' | 'authNegativeTtlS' | 'authTombstoneTtlS'>,
  db: Db['db'],
  redis: Redis | null,
  log?: KeyStoreOptions['log'],
): KeyStore {
  return createKeyStore({
    db,
    redis,
    keyPrefix: config.redisKeyPrefix,
    cacheTtlS: config.authCacheTtlS,
    negativeTtlS: config.authNegativeTtlS,
    tombstoneTtlS: config.authTombstoneTtlS,
    ...(log ? { log } : {}),
  });
}
