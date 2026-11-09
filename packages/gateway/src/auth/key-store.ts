import { and, eq, isNull, sql } from 'drizzle-orm';
import type { Redis } from 'ioredis';
import type { Config } from '../config.ts';
import type { Db } from '../db/client.ts';
import { isStarting, waitReady } from '../redis.ts';
import { apiKeys, tenants } from '../db/schema.ts';

export interface Tenant {
  tenantId: string;
  tenantName: string;
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

const REVOKED = 'revoked';
const UNKNOWN = 'unknown';

export function createKeyStore(opts: KeyStoreOptions): KeyStore {
  const { db, redis } = opts;
  const redisKey = (hash: string) => `${opts.keyPrefix}apikey:${hash}`;

  // Reads and writes are tracked separately so a write that keeps failing while reads succeed (out of
  // memory, read-only replica) is one outage, not a warn and an info on every request. The outage ends,
  // and is logged as ended, only when both have succeeded again.
  const down = { get: false, set: false };
  const redisFailed = (op: 'get' | 'set', err: unknown) => {
    // A client that has not finished its first connection is connecting, not down.
    if (redis !== null && isStarting(redis)) return;
    const wasOutage = down.get || down.set;
    down[op] = true;
    if (wasOutage) return;
    opts.log?.warn(
      { errClass: (err as Error).name, code: (err as { code?: string }).code, op },
      'redis unavailable, auth falling back to postgres',
    );
  };
  const redisOk = (op: 'get' | 'set') => {
    if (!down[op]) return;
    down[op] = false;
    if (!down.get && !down.set) opts.log?.info({}, 'redis available again');
  };

  async function fromPostgres(hash: string): Promise<Tenant | null> {
    const rows = await db
      .select({ tenantId: tenants.id, tenantName: tenants.name })
      .from(apiKeys)
      .innerJoin(tenants, eq(tenants.id, apiKeys.tenantId))
      .where(and(eq(apiKeys.keyHash, hash), isNull(apiKeys.revokedAt)))
      .limit(1);
    return rows[0] ?? null;
  }

  const parseTenant = (raw: string): Tenant | undefined => {
    try {
      const v = JSON.parse(raw) as Partial<Tenant> | null;
      return typeof v?.tenantId === 'string' && typeof v.tenantName === 'string'
        ? { tenantId: v.tenantId, tenantName: v.tenantName }
        : undefined;
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
      let corrupt = false;
      if (cached !== null) {
        const hit = parseTenant(cached);
        if (hit) return hit;
        corrupt = true; // not a value this store wrote: treat as a miss and replace it
      }

      const tenant = await fromPostgres(hash);
      try {
        const value = tenant ? JSON.stringify(tenant) : UNKNOWN;
        const ttl = tenant ? opts.cacheTtlS : opts.negativeTtlS;
        // NX: a fill never overwrites a revoke tombstone written after this request read Postgres.
        // A corrupt entry is the one thing a fill may overwrite.
        if (corrupt) await redis.set(key, value, 'EX', ttl);
        else await redis.set(key, value, 'EX', ttl, 'NX');
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
        try {
          // A client created a moment ago may not be connected yet; commands sent before then fail.
          await waitReady(redis, 2000);
          // Plain SET (no NX): it must overwrite a cached "valid" entry.
          await redis.set(redisKey(hash), REVOKED, 'EX', opts.tombstoneTtlS);
          tombstoned = true;
          redisOk('set');
        } catch (err) {
          redisFailed('set', err);
        }
      }
      return { revoked: updated.length > 0, tombstoned };
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
