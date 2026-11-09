// Helper for bench/run-correctness.sh: one rate-limited key per run, and the request log's count of what it admitted.
//   node bench/correctness-tool.ts key   <tenant-name> <rpm>   creates the tenant and a key; prints the key, then its id
//   node bench/correctness-tool.ts count <key-id>              prints the number of status-200 rows in request_log for the key
//   node bench/correctness-tool.ts cleanup <tenant-name>       removes the tenant (its keys cascade) and the key's log rows
// Reads DATABASE_URL and API_KEY_PEPPER from the environment, like the CLI.
import { and, eq } from 'drizzle-orm';
import { createKey, createTenant } from '../packages/gateway/src/cli/keys.ts';
import { loadConfig } from '../packages/gateway/src/config.ts';
import { createDb } from '../packages/gateway/src/db/client.ts';
import { apiKeys, requestLog, tenants } from '../packages/gateway/src/db/schema.ts';

const [command, arg, rpmArg] = process.argv.slice(2);
if (!command || !arg) throw new Error('usage: correctness-tool.ts key|count|cleanup <tenant-name|key-id> [rpm]');
const config = loadConfig({ ...process.env, BUDGET_ENABLED: 'false', RATE_LIMIT_ENABLED: 'false', AUTH_CACHE: 'none' });
const handle = createDb({ databaseUrl: config.databaseUrl, poolSize: 2 });
try {
  if (command === 'key') {
    const rpm = Number(rpmArg);
    if (!Number.isInteger(rpm) || rpm < 1) throw new Error('rpm must be a positive integer');
    const t = await createTenant(handle.db, arg);
    // A high token limit: the burst measures the request limit.
    const k = await createKey(handle.db, config.apiKeyPepper, t.name, 'correctness', { rpm, tpm: 999_999_999 });
    console.log(k.key);
    console.log(k.keyId);
  } else if (command === 'count') {
    const rows = await handle.db
      .select({ id: requestLog.requestId })
      .from(requestLog)
      .where(and(eq(requestLog.keyId, arg), eq(requestLog.status, 200)));
    console.log(rows.length);
  } else if (command === 'cleanup') {
    const keys = await handle.db.select({ id: apiKeys.id }).from(apiKeys).innerJoin(tenants, eq(tenants.id, apiKeys.tenantId)).where(eq(tenants.name, arg));
    for (const k of keys) await handle.db.delete(requestLog).where(eq(requestLog.keyId, k.id));
    await handle.db.delete(tenants).where(eq(tenants.name, arg));
  } else {
    throw new Error(`unknown command ${command}`);
  }
} finally {
  await handle.close();
}
