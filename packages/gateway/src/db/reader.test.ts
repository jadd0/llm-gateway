import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { testConfig } from '../test-env.ts';
import { provisionReader } from './reader.ts';

// The dashboard's own login, made the way `npm run db:migrate` makes it, then asked for everything it must not see.
const owner = new pg.Pool({ connectionString: testConfig().databaseUrl, max: 2 });
const name = `dashtest_${randomBytes(5).toString('hex')}`;
const password = randomBytes(18).toString('hex');
let reader: pg.Pool;

const asReaderUrl = () => {
  const u = new URL(testConfig().databaseUrl);
  u.username = name;
  u.password = password;
  return u.toString();
};

beforeAll(async () => {
  const c = await owner.connect();
  try {
    // Twice: the second run resets the password and must not fail on the existing role.
    await provisionReader(c, asReaderUrl());
    await provisionReader(c, asReaderUrl());
  } finally {
    c.release();
  }
  reader = new pg.Pool({ connectionString: asReaderUrl(), max: 2 });
});
afterAll(async () => {
  await reader.end();
  await owner.query(`DROP ROLE IF EXISTS "${name}"`);
  await owner.end();
});

describe('dashboard_reader', () => {
  it('reads the rollups, tenant names and the metadata columns of the log', async () => {
    // Positive controls: a refusal below means something only if the same login can read what it should.
    await expect(reader.query('SELECT count(*) FROM rollup_minute')).resolves.toBeTruthy();
    await expect(reader.query('SELECT count(*) FROM rollup_hour')).resolves.toBeTruthy();
    await expect(reader.query('SELECT count(*) FROM rollup_total_minute')).resolves.toBeTruthy();
    await expect(reader.query('SELECT count(*) FROM rollup_total_hour')).resolves.toBeTruthy();
    await expect(reader.query('SELECT folded_through FROM rollup_state')).resolves.toBeTruthy();
    await expect(reader.query('SELECT id, name FROM tenants LIMIT 1')).resolves.toBeTruthy();
    await expect(reader.query('SELECT request_id, created_at, tenant_id, model, status, error_code, latency_ms FROM request_log LIMIT 1')).resolves.toBeTruthy();
  });

  it('cannot read the ledger, the keys, the holds, or any other column of the log', async () => {
    const forbidden = [
      'SELECT * FROM spend_ledger',
      'SELECT * FROM tenant_spend',
      'SELECT * FROM budget_reservations',
      'SELECT * FROM api_keys',
      'SELECT key_hash FROM api_keys',
      'SELECT key_id FROM request_log',
      'SELECT * FROM request_log',
      'SELECT cost_micros FROM request_log',
      'SELECT monthly_budget_micros FROM tenants',
    ];
    const codes: Record<string, string | undefined> = {};
    for (const q of forbidden) {
      codes[q] = await reader.query(q).then(() => 'allowed', (e: { code?: string }) => e.code);
    }
    expect(Object.values(codes)).toEqual(forbidden.map(() => '42501'));
  });

  it('cannot write anything', async () => {
    const writes = [
      `INSERT INTO rollup_hour VALUES (now(), '${'0'.repeat(8)}-0000-0000-0000-${'0'.repeat(12)}', 'x', 1, 0, 0, 0, 0, 0, 0, 0, '{}')`,
      'DELETE FROM rollup_minute',
      'UPDATE rollup_state SET folded_through = now()',
      'DELETE FROM request_log',
    ];
    const codes: string[] = [];
    for (const q of writes) codes.push(await reader.query(q).then(() => 'allowed', (e: { code?: string }) => e.code ?? '?'));
    expect(codes).toEqual(writes.map(() => '42501'));
  });
});
