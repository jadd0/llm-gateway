import { parseArgs } from 'node:util';
import { and, asc, eq, sql } from 'drizzle-orm';
import { loadCacheConfig, loadConfig, loadDbConfig, loadPepperConfig } from '../config.ts';
import { createDb, type Db } from '../db/client.ts';
import { apiKeys, spendLedger, tenants, tenantSpend } from '../db/schema.ts';
import { isPeriod, periodOf } from '../budget/period.ts';
import { formatUsd, parseUsd } from '../pricing/prices.ts';
import { generateKey, hashKey, keyPrefix, KEY_PREFIX_LENGTH } from '../auth/keys.ts';
import { keyStoreFromConfig, type KeyStore } from '../auth/key-store.ts';
import { createRedis } from '../redis.ts';

export class CliError extends Error {}

const DOLLAR = '$';

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

// A budget is a USD amount ("10", "0.25") or "default" to fall back to the gateway-wide cap. Anything
// else is refused rather than rounded, so "1e3" or "0.0000001" is never stored as something plausible.
export function parseBudget(raw: string): number | null {
  if (raw === 'default') return null;
  const micros = parseUsd(raw);
  if (micros === undefined) {
    throw new CliError('--monthly-usd must be a USD amount like 10 or 0.25 (up to 6 decimals), or "default"');
  }
  return micros;
}

// Sets a tenant's monthly spend cap in micro-USD.
export async function setBudget(db: Db['db'], keyStore: KeyStore, tenantName: string, micros: number | null) {
  const [tenant] = await db.select({ id: tenants.id }).from(tenants).where(eq(tenants.name, tenantName));
  if (!tenant) throw new CliError(`no tenant named "${tenantName}"`);
  const r = await keyStore.setBudget(tenant.id, micros);
  return { tenant: tenantName, micros, cached: r.cached };
}

// "on" puts the tenant in the shared response-cache pool, "off" back in its own. Anything else is refused.
export function parseSharing(raw: string | undefined): boolean {
  if (raw === 'on') return true;
  if (raw === 'off') return false;
  throw new CliError('set-cache-sharing needs "on" or "off"');
}

// "on" or "off" for set-semantic-cache. Anything else is refused.
export function parseSwitch(raw: string | undefined): boolean {
  if (raw === 'on') return true;
  if (raw === 'off') return false;
  throw new CliError('set-semantic-cache needs "on" or "off"');
}

// Switches a tenant's semantic cache on or off (off: exact-match caching only).
export async function setSemanticCache(db: Db['db'], keyStore: KeyStore, tenantName: string, on: boolean) {
  const [tenant] = await db.select({ id: tenants.id }).from(tenants).where(eq(tenants.name, tenantName));
  if (!tenant) throw new CliError(`no tenant named "${tenantName}"`);
  const r = await keyStore.setSemanticCache(tenant.id, on);
  return { tenant: tenantName, on, cached: r.cached };
}

// Switches a tenant between its own response-cache scope and the shared pool.
export async function setCacheSharing(db: Db['db'], keyStore: KeyStore, tenantName: string, shared: boolean) {
  const [tenant] = await db.select({ id: tenants.id }).from(tenants).where(eq(tenants.name, tenantName));
  if (!tenant) throw new CliError(`no tenant named "${tenantName}"`);
  const r = await keyStore.setCacheShared(tenant.id, shared);
  return { tenant: tenantName, shared, cached: r.cached };
}

// What a tenant has spent in a UTC month (default: this one), from the settled-spend record.
export async function showSpend(db: Db['db'], tenantName: string, period = periodOf(Date.now())) {
  if (!isPeriod(period)) throw new CliError('--period must look like 2026-11');
  const [tenant] = await db
    .select({ id: tenants.id, cap: tenants.monthlyBudgetMicros })
    .from(tenants)
    .where(eq(tenants.name, tenantName));
  if (!tenant) throw new CliError(`no tenant named "${tenantName}"`);
  const [row] = await db
    .select({ spent: tenantSpend.spentMicros })
    .from(tenantSpend)
    .where(and(eq(tenantSpend.tenantId, tenant.id), eq(tenantSpend.period, period)));
  // Cache hits are zero-cost rows in the same ledger; what they saved is what the same usage would have cost.
  const [hits] = await db
    .select({
      hits: sql<string>`count(*)`,
      exact: sql<string>`count(*) filter (where ${spendLedger.cacheKind} = 'exact')`,
      semantic: sql<string>`count(*) filter (where ${spendLedger.cacheKind} = 'semantic')`,
      saved: sql<string>`coalesce(sum(${spendLedger.savedMicros}), 0)`,
    })
    .from(spendLedger)
    .where(and(eq(spendLedger.tenantId, tenant.id), eq(spendLedger.period, period), eq(spendLedger.cached, true)));
  return {
    tenant: tenantName,
    period,
    spentMicros: row?.spent ?? 0,
    capMicros: tenant.cap,
    cacheHits: Number(hits?.hits ?? 0),
    exactHits: Number(hits?.exact ?? 0),
    semanticHits: Number(hits?.semantic ?? 0),
    savedMicros: Number(hits?.saved ?? 0),
  };
}

const USAGE = `usage:
  keys create-tenant <name>
  keys create-key <tenant> [label] [--rpm <n>] [--tpm <n>]
                                       prints the key once; it cannot be shown again
  keys set-limits <prefix> [--rpm <n|default>] [--tpm <n|default>]
  keys set-budget <tenant> --monthly-usd <amount|default>
  keys set-cache-sharing <tenant> on|off
  keys set-semantic-cache <tenant> on|off
  keys show-spend <tenant> [--period YYYY-MM]
  keys revoke-key <prefix>
  keys list-keys [tenant]`;

function parseFlags(args: string[]) {
  try {
    return parseArgs({ args, allowPositionals: true, options: { rpm: { type: 'string' }, tpm: { type: 'string' }, 'monthly-usd': { type: 'string' }, period: { type: 'string' } },
    });
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
    case 'set-budget': {
      const { values, positionals } = parseFlags(args);
      if (!positionals[0] || values['monthly-usd'] === undefined) throw new CliError(USAGE);
      const tenant = positionals[0];
      const micros = parseBudget(values['monthly-usd']);
      const config = loadCacheConfig();
      const redis = config.authCache === 'redis' && config.redisUrl ? createRedis(config.redisUrl) : null;
      try {
        const r = await withDb(config.databaseUrl, (db) => setBudget(db, keyStoreFromConfig(config, db, redis), tenant, micros));
        console.log(`${r.tenant}: monthly budget ${r.micros === null ? 'default' : DOLLAR + formatUsd(r.micros)}`);
        if (config.authCache === 'redis' && (config.redisUrl === undefined || (redis !== null && !r.cached))) {
          // The database has the new cap; a cached copy of a key keeps the old one until it expires.
          throw new CliError(
            `warning: the key cache was not refreshed, so the old cap can stay in effect for up to ${config.authCacheTtlS}s (AUTH_CACHE_TTL_S); set REDIS_URL / bring Redis up and run this command again`,
          );
        }
      } finally {
        redis?.disconnect();
      }
      return;
    }
    case 'set-cache-sharing': {
      if (!args[0] || args.length !== 2) throw new CliError(USAGE);
      const tenant = args[0];
      const shared = parseSharing(args[1]);
      const config = loadCacheConfig();
      const redis = config.authCache === 'redis' && config.redisUrl ? createRedis(config.redisUrl) : null;
      try {
        const r = await withDb(config.databaseUrl, (db) => setCacheSharing(db, keyStoreFromConfig(config, db, redis), tenant, shared));
        console.log(`${r.tenant}: response cache ${r.shared ? 'shared' : 'private'}`);
        if (config.authCache === 'redis' && (config.redisUrl === undefined || (redis !== null && !r.cached))) {
          // The database has the new setting; a cached copy of a key keeps the old one until it expires.
          throw new CliError(
            `warning: the key cache was not refreshed, so the old setting can stay in effect for up to ${config.authCacheTtlS}s (AUTH_CACHE_TTL_S); set REDIS_URL / bring Redis up and run this command again`,
          );
        }
      } finally {
        redis?.disconnect();
      }
      return;
    }
    case 'set-semantic-cache': {
      if (!args[0] || args.length !== 2) throw new CliError(USAGE);
      const tenant = args[0];
      const on = parseSwitch(args[1]);
      const config = loadCacheConfig();
      const redis = config.authCache === 'redis' && config.redisUrl ? createRedis(config.redisUrl) : null;
      try {
        const r = await withDb(config.databaseUrl, (db) => setSemanticCache(db, keyStoreFromConfig(config, db, redis), tenant, on));
        console.log(`${r.tenant}: semantic cache ${r.on ? 'on' : 'off'}`);
        if (config.authCache === 'redis' && (config.redisUrl === undefined || (redis !== null && !r.cached))) {
          // The database has the new setting; a cached copy of a key keeps the old one until it expires.
          throw new CliError(
            `warning: the key cache was not refreshed, so the old setting can stay in effect for up to ${config.authCacheTtlS}s (AUTH_CACHE_TTL_S); set REDIS_URL / bring Redis up and run this command again`,
          );
        }
      } finally {
        redis?.disconnect();
      }
      return;
    }
    case 'show-spend': {
      const { values, positionals } = parseFlags(args);
      if (!positionals[0]) throw new CliError(USAGE);
      const tenant = positionals[0];
      const r = await withDb(loadDbConfig().databaseUrl, (db) => showSpend(db, tenant, values.period));
      const cap = r.capMicros === null ? 'default cap' : 'cap ' + DOLLAR + formatUsd(r.capMicros);
      console.log(`${r.tenant} ${r.period}: spent ${DOLLAR}${formatUsd(r.spentMicros)} (${cap}); cache hits ${r.cacheHits} (exact ${r.exactHits}, semantic ${r.semanticHits}), saved ${DOLLAR}${formatUsd(r.savedMicros)}`);
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
