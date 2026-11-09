import { and, eq, isNull, sql } from 'drizzle-orm';
import type { Redis } from 'ioredis';
import type { Db } from '../db/client.ts';
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

  // One warn per outage and one info on recovery, never one line per request.
  let redisDown = false;
  const redisFailed = (err: unknown) => {
    if (redisDown) return;
    redisDown = true;
    opts.log?.warn(
      { errClass: (err as Error).name, code: (err as { code?: string }).code },
      'redis unavailable, auth falling back to postgres',
    );
  };
  const redisOk = () => {
    if (!redisDown) return;
    redisDown = false;
    opts.log?.info({}, 'redis available again');
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

  return {
    async lookup(hash) {
      if (redis === null) return fromPostgres(hash);

      const key = redisKey(hash);
      try {
        const cached = await redis.get(key);
        redisOk();
        if (cached === REVOKED || cached === UNKNOWN) return null;
        if (cached !== null) return JSON.parse(cached) as Tenant;
      } catch (err) {
        // Postgres is the source of truth, so a dead cache costs latency, never correctness.
        redisFailed(err);
        return fromPostgres(hash);
      }

      const tenant = await fromPostgres(hash);
      try {
        // NX: a fill never overwrites a revoke tombstone written after this request read Postgres.
        if (tenant) {
          await redis.set(key, JSON.stringify(tenant), 'EX', opts.cacheTtlS, 'NX');
        } else {
          await redis.set(key, UNKNOWN, 'EX', opts.negativeTtlS, 'NX');
        }
      } catch (err) {
        redisFailed(err);
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
          // Plain SET (no NX): it must overwrite a cached "valid" entry.
          await redis.set(redisKey(hash), REVOKED, 'EX', opts.tombstoneTtlS);
          tombstoned = true;
        } catch (err) {
          redisFailed(err);
        }
      }
      return { revoked: updated.length > 0, tombstoned };
    },
  };
}
