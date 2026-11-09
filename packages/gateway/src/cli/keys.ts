import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import { loadConfig, loadDbConfig } from '../config.ts';
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
export async function createKey(db: Db['db'], pepper: string, tenantName: string, label?: string) {
  const [tenant] = await db.select().from(tenants).where(eq(tenants.name, tenantName));
  if (!tenant) throw new CliError(`no tenant named "${tenantName}"`);
  const key = generateKey();
  await db.insert(apiKeys).values({
    tenantId: tenant.id,
    keyHash: hashKey(pepper, key),
    prefix: keyPrefix(key),
    name: label ?? null,
  });
  return { key, prefix: keyPrefix(key), tenant: tenant.name };
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

// Revokes exactly one active key, found by display prefix. A prefix that matches several keys is
// refused rather than guessed at.
export async function revokeKey(db: Db['db'], keyStore: KeyStore, prefixArg: string) {
  const prefix = prefixArg.slice(0, KEY_PREFIX_LENGTH);
  if (prefix.length < MIN_REVOKE_PREFIX) {
    throw new CliError(`give at least ${MIN_REVOKE_PREFIX} characters of the key prefix`);
  }
  const matches = await db
    .select({ keyHash: apiKeys.keyHash, prefix: apiKeys.prefix })
    .from(apiKeys)
    .where(and(sql`starts_with(${apiKeys.prefix}, ${prefix})`, isNull(apiKeys.revokedAt)));
  if (matches.length === 0) throw new CliError(`no active key with prefix "${prefix}"`);
  if (matches.length > 1) {
    throw new CliError(`prefix "${prefix}" matches ${matches.length} active keys; give more characters`);
  }
  const result = await keyStore.revoke(matches[0]!.keyHash);
  return { prefix: matches[0]!.prefix, ...result };
}

const USAGE = `usage:
  keys create-tenant <name>
  keys create-key <tenant> [label]     prints the key once; it cannot be shown again
  keys revoke-key <prefix>
  keys list-keys [tenant]`;

async function main(argv: string[]) {
  const [command, ...args] = argv;
  if (!command || !['create-tenant', 'create-key', 'revoke-key', 'list-keys'].includes(command)) {
    throw new CliError(USAGE);
  }
  // Database-only commands need nothing but the database settings.
  const dbOnly = command === 'create-tenant' || command === 'list-keys';
  const config = dbOnly ? undefined : loadConfig();
  const dbConfig = config ?? loadDbConfig();
  const handle = createDb({ databaseUrl: dbConfig.databaseUrl, poolSize: 2 });
  // Only revoke-key talks to Redis.
  const redis =
    command === 'revoke-key' && config?.authCache === 'redis' && config.redisUrl
      ? createRedis(config.redisUrl)
      : null;
  try {
    switch (command) {
      case 'create-tenant': {
        if (!args[0]) throw new CliError(USAGE);
        const t = await createTenant(handle.db, args[0]);
        console.log(`tenant ${t.name} ${t.id}`);
        break;
      }
      case 'create-key': {
        if (!args[0]) throw new CliError(USAGE);
        const k = await createKey(handle.db, config!.apiKeyPepper, args[0], args[1]);
        // stdout carries only the key so scripts can capture it; the rest goes to stderr.
        console.error(`key for ${k.tenant} (prefix ${k.prefix}); store it now, it is not recoverable:`);
        console.log(k.key);
        break;
      }
      case 'revoke-key': {
        if (!args[0]) throw new CliError(USAGE);
        const keyStore = keyStoreFromConfig(config!, handle.db, redis);
        const r = await revokeKey(handle.db, keyStore, args[0]);
        if (!r.revoked) throw new CliError(`${r.prefix}: already revoked or not found`);
        console.log(`revoked ${r.prefix}`);
        if (redis !== null && !r.tombstoned) {
          // Postgres is updated but the cache could not be told; a cached copy may live on.
          throw new CliError(
            `redis unreachable: the key is revoked in Postgres but a cached copy can keep working for up to ${config!.authCacheTtlS}s`,
          );
        }
        break;
      }
      case 'list-keys': {
        const rows = await listKeys(handle.db, args[0]);
        for (const r of rows) {
          console.log(
            [r.tenant, r.prefix, r.name ?? '-', r.createdAt.toISOString(), r.revokedAt ? `revoked ${r.revokedAt.toISOString()}` : 'active'].join('\t'),
          );
        }
        break;
      }
    }
  } finally {
    redis?.disconnect();
    await handle.close();
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
