import { randomBytes, randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTenant } from '../cli/keys.ts';
import { createDb, type Db } from '../db/client.ts';
import { cleanup, testConfig } from '../test-env.ts';
import { periodOf } from './period.ts';
import { createPgLedger, type PgLedger, type SpendEntry } from './pg-ledger.ts';

const base = testConfig();
const P = periodOf(Date.now());
let handle: Db;
let ledger: PgLedger;
const tenantIds: string[] = [];

beforeAll(() => {
  handle = createDb({ databaseUrl: base.databaseUrl, poolSize: 12 });
  ledger = createPgLedger(handle.db);
});
afterAll(async () => {
  await cleanup(handle.db, null, tenantIds, '');
  await handle.close();
});

const newTenant = async () => {
  const t = await createTenant(handle.db, `t-${randomBytes(6).toString('hex')}`);
  tenantIds.push(t.id);
  return t.id;
};
const reserveArgs = (tenantId: string, estimate: number, cap: number, extra: object = {}) => ({
  id: randomUUID(), tenantId, period: P, estimate, cap, ttlMs: 300_000, ...extra,
});
const entry = (tenantId: string, costMicros: number, extra: Partial<SpendEntry> = {}): SpendEntry => ({
  requestId: randomUUID(), tenantId, period: P, model: 'mock-model', promptTokens: 10, completionTokens: 20,
  costMicros, estimated: false, ...extra,
});
const heldRows = async (tenantId: string) =>
  Number(
    (await handle.db.execute(sql`select count(*) as n from budget_reservations where tenant_id = ${tenantId}`)).rows[0]!.n,
  );

describe('postgres ledger', { timeout: 120_000 }, () => {
  it('50 concurrent reserves on the Postgres path admit exactly 7', async () => {
    const t = await newTenant();
    const results = await Promise.all(Array.from({ length: 50 }, () => ledger.reserve(reserveArgs(t, 1000, 7500))));
    expect(results.filter((r) => r.allowed)).toHaveLength(7);
    expect(await heldRows(t)).toBe(7);
    expect(new Set(results.filter((r) => !r.allowed).map((r) => r.remaining))).toEqual(new Set([500]));
  });

  it('row lock is not held across the provider call', async () => {
    const t = await newTenant();
    const a = reserveArgs(t, 1000, 5000);
    expect((await ledger.reserve(a)).allowed).toBe(true);
    // The provider is "still answering": nothing has settled. The tenant's spend row must be free,
    // so NOWAIT (which errors if anyone holds the lock) succeeds on a different connection.
    const other = createDb({ databaseUrl: base.databaseUrl, poolSize: 1 });
    try {
      const rows = await other.db.execute(
        sql`select spent_micros from tenant_spend where tenant_id = ${t} and period = ${P} for update nowait`,
      );
      expect(rows.rows).toHaveLength(1);
    } finally {
      await other.close();
    }
    // And a second reservation is decided immediately, against the first still being held.
    expect((await ledger.reserve(reserveArgs(t, 4001, 5000))).allowed).toBe(false);
    expect((await ledger.reserve(reserveArgs(t, 4000, 5000))).allowed).toBe(true);
  });

  it('settle drops the hold and charges actual in one transaction', async () => {
    const t = await newTenant();
    const a = reserveArgs(t, 3000, 3000);
    expect((await ledger.reserve(a)).allowed).toBe(true);
    expect((await ledger.reserve(reserveArgs(t, 1, 3000))).allowed).toBe(false);
    expect(await ledger.settle(a.id, entry(t, 1200))).toBe(true);
    expect(await heldRows(t)).toBe(0);
    expect(await ledger.spent(t, P)).toBe(1200);
    const next = await ledger.reserve(reserveArgs(t, 1800, 3000));
    expect(next).toEqual({ allowed: true, remaining: 0 });
  });

  it('a refund drops the hold and records nothing', async () => {
    const t = await newTenant();
    const a = reserveArgs(t, 1000, 1000);
    await ledger.reserve(a);
    expect(await ledger.settle(a.id, null)).toBe(false);
    expect(await heldRows(t)).toBe(0);
    expect(await ledger.spent(t, P)).toBe(0);
  });

  it('recording the same request twice charges once', async () => {
    const t = await newTenant();
    const e = entry(t, 500);
    expect(await ledger.record(e)).toBe(true);
    expect(await ledger.record(e)).toBe(false);
    expect(await ledger.record({ ...e, costMicros: 9999 })).toBe(false);
    expect(await ledger.spent(t, P)).toBe(500);
    const rows = await handle.db.execute(sql`select count(*) as n from spend_ledger where tenant_id = ${t}`);
    expect(Number(rows.rows[0]!.n)).toBe(1);
  });

  it('an expired hold does not count against the cap', async () => {
    const t = await newTenant();
    expect((await ledger.reserve(reserveArgs(t, 900, 1000, { ttlMs: -1000 }))).allowed).toBe(true);
    // The first hold lapsed already, so the full cap is free again.
    expect((await ledger.reserve(reserveArgs(t, 1000, 1000))).allowed).toBe(true);
    expect(await heldRows(t)).toBe(1);
  });

  it('the epoch starts at 1 and only moves forward', async () => {
    const e0 = await ledger.readEpoch();
    expect(e0).toBeGreaterThanOrEqual(1);
    const [a, b] = await Promise.all([ledger.bumpEpoch(), ledger.bumpEpoch()]);
    expect(new Set([a, b]).size).toBe(2);
    expect(Math.min(a, b)).toBeGreaterThan(e0);
    expect(await ledger.readEpoch()).toBe(Math.max(a, b));
  });
});
