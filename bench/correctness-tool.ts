// Helper for bench/run-correctness.sh: one rate-limited key per run, and the request log's count of what it admitted.
//   node bench/correctness-tool.ts key   <tenant-name> <rpm>   creates the tenant and a key; prints the key, then its id
//   node bench/correctness-tool.ts count <key-id>              prints JSON {admitted, total, windowS}: the key's status-200 rows, all its rows, and
//                                                              seconds from its first request to its last admitted one (gateway clock)
//   node bench/correctness-tool.ts cleanup <tenant-name>       removes the tenant (its keys cascade) and the key's log rows
// Reads DATABASE_URL and API_KEY_PEPPER from the environment, like the CLI.
import { eq } from 'drizzle-orm';
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
      .select({ status: requestLog.status, at: requestLog.createdAt })
      .from(requestLog)
      .where(eq(requestLog.keyId, arg));
    const admitted = rows.filter((r) => r.status === 200);
    const first = Math.min(...rows.map((r) => r.at.getTime()));
    const lastAdmitted = Math.max(...admitted.map((r) => r.at.getTime()));
    // Refill credited between the first request and the last admission decision is what the bound allows.
    const windowS = admitted.length > 0 ? (lastAdmitted - first) / 1000 : 0;
    console.log(JSON.stringify({ admitted: admitted.length, total: rows.length, windowS }));
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
