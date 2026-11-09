import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { createDb } from './client.ts';
import { testConfig } from '../test-env.ts';

describe('db:migrate', () => {
  it('runs with only DATABASE_URL set', async () => {
    const { databaseUrl } = testConfig();
    const script = fileURLToPath(new URL('./migrate.ts', import.meta.url));
    // No pepper, no Redis URL, nothing inherited from this process.
    const { stdout } = await promisify(execFile)(process.execPath, [script], {
      env: { PATH: process.env.PATH ?? '', DATABASE_URL: databaseUrl },
    });
    expect(stdout).toContain('migrations applied');
  });

  it('leaves the ledger indexed by tenant and period', async () => {
    const handle = createDb({ databaseUrl: testConfig().databaseUrl, poolSize: 1 });
    try {
      const rows = await handle.db.execute<{ def: string }>(
        sql`select indexdef as def from pg_indexes where schemaname = 'public' and tablename = 'spend_ledger' and indexname = 'spend_ledger_tenant_period_idx'`,
      );
      expect(rows.rows.map((r) => r.def)).toEqual([expect.stringContaining('(tenant_id, period)')]);
    } finally {
      await handle.close();
    }
  });
});
