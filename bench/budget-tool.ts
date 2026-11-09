// Helper for bench/run-budget.sh: creates the flood tenants, reads what they spent, removes them.
//   node bench/budget-tool.ts setup   <name-prefix> <count> <cap-usd>   prints one API key per line
//   node bench/budget-tool.ts measure <name-prefix>                      prints one JSON line
//   node bench/budget-tool.ts cleanup <name-prefix>
// Reads DATABASE_URL, API_KEY_PEPPER (and the Redis settings for the cache) from the environment, like the CLI.
import { eq, like } from 'drizzle-orm';
import { createKey, createTenant, setBudget } from '../packages/gateway/src/cli/keys.ts';
import { keyStoreFromConfig } from '../packages/gateway/src/auth/key-store.ts';
import { loadConfig } from '../packages/gateway/src/config.ts';
import { createDb } from '../packages/gateway/src/db/client.ts';
import { spendLedger, tenants, tenantSpend } from '../packages/gateway/src/db/schema.ts';
import { parseUsd } from '../packages/gateway/src/pricing/prices.ts';

const [command, prefix, countArg, capArg] = process.argv.slice(2);
if (!command || !prefix) throw new Error('usage: budget-tool.ts setup|measure|cleanup <name-prefix> [count] [cap-usd]');
const config = loadConfig({ ...process.env, BUDGET_ENABLED: 'false', RATE_LIMIT_ENABLED: 'false', AUTH_CACHE: 'none' });
const handle = createDb({ databaseUrl: config.databaseUrl, poolSize: 2 });
try {
  if (command === 'setup') {
    const cap = parseUsd(capArg ?? '');
    if (cap === undefined) throw new Error('cap-usd must be a USD amount');
    const store = keyStoreFromConfig(config, handle.db, null);
    for (let i = 0; i < Number(countArg); i++) {
      const t = await createTenant(handle.db, `${prefix}-${i}`);
      await setBudget(handle.db, store, t.name, cap);
      // High request limits: the flood measures the budget, not the rate limiter.
      const k = await createKey(handle.db, config.apiKeyPepper, t.name, undefined, { rpm: 999_999_999, tpm: 999_999_999 });
      console.log(k.key);
    }
  } else if (command === 'measure') {
    const rows = await handle.db
      .select({ name: tenants.name, cap: tenants.monthlyBudgetMicros, spent: tenantSpend.spentMicros })
      .from(tenants)
      .leftJoin(tenantSpend, eq(tenantSpend.tenantId, tenants.id))
      .where(like(tenants.name, `${prefix}-%`));
    const ledger = await handle.db
      .select({ id: spendLedger.requestId, estimated: spendLedger.estimated })
      .from(spendLedger)
      .innerJoin(tenants, eq(tenants.id, spendLedger.tenantId))
      .where(like(tenants.name, `${prefix}-%`));
    const spent = rows.map((r) => r.spent ?? 0);
    const cap = rows[0]?.cap ?? 0;
    console.log(
      JSON.stringify({
        rounds: rows.length,
        capMicros: cap,
        // How much of its cap each round's tenant had settled by the end, and by how much it went over.
        maxSettledOverCap: cap > 0 ? Math.max(...spent) / cap : null,
        maxOvershootMicros: Math.max(0, ...rows.map((r) => (r.spent ?? 0) - (r.cap ?? 0))),
        roundsOverCap: rows.filter((r) => (r.spent ?? 0) > (r.cap ?? 0)).length,
        minSettledMicros: Math.min(...spent),
        ledgerRows: ledger.length,
        ledgerRowsEstimated: ledger.filter((l) => l.estimated).length,
      }),
    );
  } else if (command === 'cleanup') {
    // Tenants cascade to their keys, spend and ledger rows.
    await handle.db.delete(tenants).where(like(tenants.name, `${prefix}-%`));
  } else {
    throw new Error(`unknown command ${command}`);
  }
} finally {
  await handle.close();
}
