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

describe('provisionReader refuses a role it must not take over', () => {
  const made: string[] = [];
  const urlFor = (n: string, pw: string) => {
    const u = new URL(testConfig().databaseUrl);
    u.username = n;
    u.password = pw;
    return u.toString();
  };
  const tryProvision = async (n: string, pw: string) => {
    const c = await owner.connect();
    try {
      return await provisionReader(c, urlFor(n, pw)).then(() => 'ok', (e: Error) => e.message);
    } finally {
      c.release();
    }
  };
  const canLogin = (n: string, pw: string) =>
    new pg.Client({ connectionString: urlFor(n, pw) }).connect().then(() => true, () => false);
  afterAll(async () => {
    for (const n of made) {
      await owner.query(`DROP OWNED BY "${n}"`);
      await owner.query(`DROP ROLE IF EXISTS "${n}"`);
    }
  });

  it('refuses a superuser, leaving its password as it was', async () => {
    const n = `dashsu_${randomBytes(4).toString('hex')}`;
    made.push(n);
    await owner.query(`CREATE ROLE "${n}" SUPERUSER LOGIN PASSWORD 'first-pw-1234567890'`);
    expect(await tryProvision(n, 'second-pw-1234567890')).toMatch(/role attribute/);
    expect(await canLogin(n, 'first-pw-1234567890')).toBe(true);
    expect(await canLogin(n, 'second-pw-1234567890')).toBe(false);
  });

  it('refuses the user running the migration', async () => {
    const me = ((await owner.query('SELECT current_user AS u')).rows[0] as { u: string }).u;
    expect(await tryProvision(me, 'whatever-pw-1234567890')).toMatch(/running this migration|role attribute/);
    expect(await canLogin(me, new URL(testConfig().databaseUrl).password)).toBe(true);
  });

  it('refuses a role that owns an object, leaving its password as it was', async () => {
    const n = `dashown_${randomBytes(4).toString('hex')}`;
    made.push(n);
    await owner.query(`CREATE ROLE "${n}" LOGIN PASSWORD 'first-pw-1234567890'`);
    await owner.query(`CREATE SCHEMA "${n}" AUTHORIZATION "${n}"`);
    expect(await tryProvision(n, 'second-pw-1234567890')).toMatch(/owns objects or holds grants/);
    expect(await canLogin(n, 'first-pw-1234567890')).toBe(true);
    expect(await canLogin(n, 'second-pw-1234567890')).toBe(false);
    await owner.query(`DROP SCHEMA "${n}"`);
    // Once it owns nothing it is an ordinary role and is taken over, which proves the refusal above was the ownership and nothing else.
    expect(await tryProvision(n, 'second-pw-1234567890')).toBe('ok');
    expect(await canLogin(n, 'second-pw-1234567890')).toBe(true);
  });
});

describe('provisionReader accepts only a new role or a pure dashboard login', () => {
  const made: string[] = [];
  const urlFor = (n: string, pw: string) => {
    const u = new URL(testConfig().databaseUrl);
    u.username = n;
    u.password = pw;
    return u.toString();
  };
  const tryProvision = async (n: string, pw: string) => {
    const c = await owner.connect();
    try {
      return await provisionReader(c, urlFor(n, pw)).then(() => 'ok', (e: Error) => e.message);
    } finally {
      c.release();
    }
  };
  const canLogin = async (n: string, pw: string) => {
    const c = new pg.Client({ connectionString: urlFor(n, pw) });
    const ok = await c.connect().then(() => true, () => false);
    if (ok) await c.end();
    return ok;
  };
  const make = async (attrs: string) => {
    const n = `dashx_${randomBytes(4).toString('hex')}`;
    made.push(n);
    await owner.query(`CREATE ROLE "${n}" ${attrs} LOGIN PASSWORD 'first-pw-1234567890'`);
    return n;
  };
  const untouched = async (n: string) => {
    expect(await tryProvision(n, 'second-pw-1234567890')).not.toBe('ok');
    expect(await canLogin(n, 'first-pw-1234567890')).toBe(true);
    expect(await canLogin(n, 'second-pw-1234567890')).toBe(false);
  };
  afterAll(async () => {
    for (const n of made) {
      await owner.query(`DROP OWNED BY "${n}"`);
      await owner.query(`DROP ROLE IF EXISTS "${n}"`);
    }
  });

  it.each(['CREATEROLE', 'CREATEDB', 'REPLICATION', 'BYPASSRLS'])('refuses a role with %s, password untouched', async (attr) => {
    await untouched(await make(attr));
  });

  it('refuses a role that is a member of another role, password untouched', async () => {
    const n = await make('');
    await owner.query(`GRANT pg_read_all_data TO "${n}"`);
    await untouched(n);
  });

  it('refuses a role that holds a grant, password untouched; accepts it once the grant is gone', async () => {
    const n = await make('');
    await owner.query(`GRANT INSERT, UPDATE, DELETE ON tenants TO "${n}"`);
    await untouched(n);
    await owner.query(`REVOKE ALL ON tenants FROM "${n}"`);
    expect(await tryProvision(n, 'second-pw-1234567890')).toBe('ok');
    expect(await canLogin(n, 'second-pw-1234567890')).toBe(true);
  });

  it('accepts a pure dashboard login that already exists and sets its password', async () => {
    const n = `dashx_${randomBytes(4).toString('hex')}`;
    made.push(n);
    expect(await tryProvision(n, 'first-pw-1234567890')).toBe('ok');
    expect(await tryProvision(n, 'second-pw-1234567890')).toBe('ok');
    expect(await canLogin(n, 'first-pw-1234567890')).toBe(false);
    expect(await canLogin(n, 'second-pw-1234567890')).toBe(true);
  });
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
