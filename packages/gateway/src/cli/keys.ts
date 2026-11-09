import { parseArgs } from 'node:util';
import { asc, eq, sql } from 'drizzle-orm';
import { loadCacheConfig, loadConfig, loadDbConfig, loadPepperConfig } from '../config.ts';
import { createDb, type Db } from '../db/client.ts';
import { apiKeys, tenants } from '../db/schema.ts';
import { generateKey, hashKey, keyPrefix, KEY_PREFIX_LENGTH } from '../auth/keys.ts';
import { keyStoreFromConfig, type KeyStore } from '../auth/key-store.ts';
import { createRedis } from '../redis.ts';

export class CliError extends Error {}

const MIN_REVOKE_PREFIX = 6;

export async function createTenant(db: Db['db'], name: string) {
  try {
    const [row] = await db.insert(tenants).values({ name }).returning();
    return row!;
  } catch (err) {
    if ((err as { code?: string }).code === '23505') throw new CliError(`tenant "${name}" already exists`);
    throw err;
  }
}

// The only place a full key exists outside the caller's memory: it is returned once and the
// database gets its hash and display prefix.
export async function createKey(
  db: Db['db'],
  pepper: string,
  tenantName: string,
  label?: string,
  limits: { rpm?: number; tpm?: number } = {},
) {
  const [tenant] = await db.select().from(tenants).where(eq(tenants.name, tenantName));
  if (!tenant) throw new CliError(`no tenant named "${tenantName}"`);
  const key = generateKey();
  const [row] = await db
    .insert(apiKeys)
    .values({
      tenantId: tenant.id,
      keyHash: hashKey(pepper, key),
      prefix: keyPrefix(key),
      name: label ?? null,
      rpmLimit: limits.rpm ?? null,
      tpmLimit: limits.tpm ?? null,
    })
    .returning({ id: apiKeys.id });
  return { key, keyId: row!.id, prefix: keyPrefix(key), tenant: tenant.name };
}

export async function listKeys(db: Db['db'], tenantName?: string) {
  return db
    .select({
      tenant: tenants.name,
      prefix: apiKeys.prefix,
      name: apiKeys.name,
      createdAt: apiKeys.createdAt,
      revokedAt: apiKeys.revokedAt,
    })
    .from(apiKeys)
    .innerJoin(tenants, eq(tenants.id, apiKeys.tenantId))
    .where(tenantName ? eq(tenants.name, tenantName) : undefined)
    .orderBy(asc(tenants.name), asc(apiKeys.createdAt));
}

// Finds exactly one key by display prefix. Active keys win: a prefix that matches one active key
// resolves to it even if revoked keys share the prefix. Otherwise a prefix matching several keys is refused.
async function resolveKey(db: Db['db'], prefixArg: string, activeOnly = false) {
  const prefix = prefixArg.slice(0, KEY_PREFIX_LENGTH);
  if (prefix.length < MIN_REVOKE_PREFIX) {
    throw new CliError(`give at least ${MIN_REVOKE_PREFIX} characters of the key prefix`);
  }
  const matches = await db
    .select({ keyHash: apiKeys.keyHash, prefix: apiKeys.prefix, revokedAt: apiKeys.revokedAt })
    .from(apiKeys)
    .where(sql`starts_with(${apiKeys.prefix}, ${prefix})`);
  if (matches.length === 0) throw new CliError(`no key with prefix "${prefix}"`);
  const active = matches.filter((m) => m.revokedAt === null);
  if (activeOnly && active.length === 0) throw new CliError(`key "${prefix}" is revoked`);
  const candidates = active.length > 0 ? active : matches;
  if (candidates.length > 1) {
    throw new CliError(`prefix "${prefix}" matches ${candidates.length} keys; give more characters`);
  }
  return candidates[0]!;
}

// Revokes exactly one key, found by display prefix.
// Safe to repeat: an already revoked key gets its tombstone rewritten, which is how a revoke whose
// Redis write failed is retried.
export async function revokeKey(db: Db['db'], keyStore: KeyStore, prefixArg: string) {
  const target = await resolveKey(db, prefixArg);
  const result = await keyStore.revoke(target.keyHash);
  return { prefix: target.prefix, ...result };
}

// A limit is a whole number of requests or tokens per minute, or "default" to fall back to the
// gateway-wide setting. Anything else is refused rather than rounded.
export function parseLimit(name: string, raw: string): number | null {
  if (raw === 'default') return null;
  if (!/^[1-9]\d{0,8}$/.test(raw)) throw new CliError(`--${name} must be a whole number of at least 1, or "default"`);
  return Number(raw);
}

// Sets the limits of one active key. A limit that is not named keeps its current value.
export async function setLimits(
  db: Db['db'],
  keyStore: KeyStore,
  prefixArg: string,
  limits: { rpm?: number | null; tpm?: number | null },
) {
  if (limits.rpm === undefined && limits.tpm === undefined) throw new CliError('give --rpm and/or --tpm');
  const target = await resolveKey(db, prefixArg, true);
  // Only the limits named are written; the result carries the key's limits as stored.
  const result = await keyStore.setLimits(target.keyHash, limits);
  if (!result.updated) throw new CliError(`key "${target.prefix}" is revoked`);
  return { prefix: target.prefix, rpm: result.rpm, tpm: result.tpm, cached: result.cached };
}

const USAGE = `usage:
  keys create-tenant <name>
  keys create-key <tenant> [label] [--rpm <n>] [--tpm <n>]
                                       prints the key once; it cannot be shown again
  keys set-limits <prefix> [--rpm <n|default>] [--tpm <n|default>]
  keys revoke-key <prefix>
  keys list-keys [tenant]`;

function parseFlags(args: string[]) {
  try {
    return parseArgs({ args, allowPositionals: true, options: { rpm: { type: 'string' }, tpm: { type: 'string' } } });
  } catch {
    throw new CliError(USAGE);
  }
}

// create-key sets a number, never "default": a key with no limit of its own simply omits the flag.
function limitOrThrow(name: string, raw: string): number {
  const n = parseLimit(name, raw);
  if (n === null) throw new CliError(`--${name} must be a whole number of at least 1`);
  return n;
}

async function withDb<T>(databaseUrl: string, fn: (db: Db['db']) => Promise<T>): Promise<T> {
  const handle = createDb({ databaseUrl, poolSize: 2 });
  try {
    return await fn(handle.db);
  } finally {
    await handle.close();
  }
}

async function main(argv: string[]) {
  const [command, ...args] = argv;
  switch (command) {
    case 'create-tenant': {
      if (!args[0]) throw new CliError(USAGE);
      const name = args[0];
      const t = await withDb(loadDbConfig().databaseUrl, (db) => createTenant(db, name));
      console.log(`tenant ${t.name} ${t.id}`);
      return;
    }
    case 'create-key': {
      const { values, positionals } = parseFlags(args);
      if (!positionals[0]) throw new CliError(USAGE);
      const tenant = positionals[0];
      const limits = {
        ...(values.rpm !== undefined ? { rpm: limitOrThrow('rpm', values.rpm) } : {}),
        ...(values.tpm !== undefined ? { tpm: limitOrThrow('tpm', values.tpm) } : {}),
      };
      const cfg = loadPepperConfig();
      const k = await withDb(cfg.databaseUrl, (db) => createKey(db, cfg.apiKeyPepper, tenant, positionals[1], limits));
      // stdout carries only the key so scripts can capture it; the rest goes to stderr.
      console.error(`key for ${k.tenant} (prefix ${k.prefix}); store it now, it is not recoverable:`);
      console.log(k.key);
      return;
    }
    case 'set-limits': {
      const { values, positionals } = parseFlags(args);
      if (!positionals[0]) throw new CliError(USAGE);
      const prefixArg = positionals[0];
      const limits = {
        ...(values.rpm !== undefined ? { rpm: parseLimit('rpm', values.rpm) } : {}),
        ...(values.tpm !== undefined ? { tpm: parseLimit('tpm', values.tpm) } : {}),
      };
      // Needs no pepper and no Redis: the database write is the change, the cache is only told when it can be.
      const config = loadCacheConfig();
      const redis = config.authCache === 'redis' && config.redisUrl ? createRedis(config.redisUrl) : null;
      try {
        const r = await withDb(config.databaseUrl, (db) =>
          setLimits(db, keyStoreFromConfig(config, db, redis), prefixArg, limits),
        );
        const show = (n: number | null) => (n === null ? 'default' : String(n));
        console.log(`${r.prefix}: rpm ${show(r.rpm)}, tpm ${show(r.tpm)}`);
        if (config.authCache === 'redis' && config.redisUrl === undefined) {
          // The database has the new limits; with no Redis to tell, a cached copy keeps the old ones.
          throw new CliError(
            `warning: REDIS_URL is not set, so the key cache was not refreshed. The old limits can stay in effect for up to ${config.authCacheTtlS}s (AUTH_CACHE_TTL_S); set REDIS_URL and run this command again`,
          );
        }
        if (redis !== null && !r.cached) {
          // Postgres has the new limits but the cache could not be told; a cached copy keeps the old
          // limits until it expires. Running the same command again, once Redis is up, finishes the job.
          throw new CliError(
            `redis unreachable: the old limits can stay in effect for up to ${config.authCacheTtlS}s; run this command again when Redis is up`,
          );
        }
      } finally {
        redis?.disconnect();
      }
      return;
    }
    case 'revoke-key': {
      if (!args[0]) throw new CliError(USAGE);
      const prefixArg = args[0];
      const config = loadConfig();
      const redis = config.authCache === 'redis' && config.redisUrl ? createRedis(config.redisUrl) : null;
      try {
        const r = await withDb(config.databaseUrl, (db) =>
          revokeKey(db, keyStoreFromConfig(config, db, redis), prefixArg),
        );
        if (redis !== null && !r.tombstoned) {
          // Postgres is updated but the cache could not be told; a cached copy may live on.
          // Running the same command again, once Redis is up, finishes the job.
          throw new CliError(
            `${r.prefix}: redis unreachable. The key is revoked in Postgres but a cached copy can keep working for up to ${config.authCacheTtlS}s; run this command again when Redis is up`,
          );
        }
        console.log(r.revoked
            ? `revoked ${r.prefix}`
            : `${r.prefix} was already revoked${r.tombstoned ? '; tombstone refreshed' : ''}`);
      } finally {
        redis?.disconnect();
      }
      return;
    }
    case 'list-keys': {
      const tenant = args[0];
      const rows = await withDb(loadDbConfig().databaseUrl, (db) => listKeys(db, tenant));
      for (const r of rows) {
        console.log(
          [r.tenant, r.prefix, r.name ?? '-', r.createdAt.toISOString(), r.revokedAt ? `revoked ${r.revokedAt.toISOString()}` : 'active'].join('\t'),
        );
      }
      return;
    }
    default:
      throw new CliError(USAGE);
  }
}

if (import.meta.main) {
  main(process.argv.slice(2)).then(
    () => process.exit(0),
    (err: unknown) => {
      // CliError messages are ours; anything else is reported by class and code only.
      console.error(err instanceof CliError ? err.message : `failed: ${(err as Error).name} ${(err as { code?: string }).code ?? ''}`);
      process.exit(1);
    },
  );
}
