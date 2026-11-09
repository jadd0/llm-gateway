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

  it('settle drops the hold and charges actual in one transaction, numbering the charge', async () => {
    const t = await newTenant();
    const a = reserveArgs(t, 3000, 3000);
    expect((await ledger.reserve(a)).allowed).toBe(true);
    expect((await ledger.reserve(reserveArgs(t, 1, 3000))).allowed).toBe(false);
    expect(await ledger.settle(a.id, entry(t, 1200))).toMatchObject({ recorded: true, spent: 1200, charges: 1 });
    expect(await heldRows(t)).toBe(0);
    expect(await ledger.spent(t, P)).toBe(1200);
    const next = await ledger.reserve(reserveArgs(t, 1800, 3000));
    expect(next).toEqual({ allowed: true, remaining: 0 });
  });

  it('a hold written for Redis counts against the Postgres path and settles like any other', async () => {
    const t = await newTenant();
    const redisHold = reserveArgs(t, 4000, 5000);
    await ledger.hold(redisHold);
    expect(await heldRows(t)).toBe(1);
    // Redis admitted 4000; the Postgres path must see it.
    expect((await ledger.reserve(reserveArgs(t, 1001, 5000))).allowed).toBe(false);
    expect((await ledger.reserve(reserveArgs(t, 1000, 5000))).allowed).toBe(true);
    await ledger.hold(redisHold); // writing it again changes nothing
    expect(await heldRows(t)).toBe(2);
    expect(await ledger.settle(redisHold.id, entry(t, 3500))).toMatchObject({ recorded: true, spent: 3500, charges: 1 });
    expect(await heldRows(t)).toBe(1);
  });

  it('the snapshot has spend, charge count and only the live holds, with their time left', async () => {
    const t = await newTenant();
    expect(await ledger.snapshot(t, P)).toEqual({ spent: 0, charges: 0, holds: [] });
    const live = reserveArgs(t, 700, 10_000, { ttlMs: 120_000 });
    await ledger.hold(live);
    await ledger.hold(reserveArgs(t, 900, 10_000, { ttlMs: -5000 })); // already lapsed
    await ledger.settle(randomUUID(), entry(t, 100));
    await ledger.settle(randomUUID(), entry(t, 250));
    const snap = await ledger.snapshot(t, P);
    expect(snap).toMatchObject({ spent: 350, charges: 2 });
    expect(snap.holds).toHaveLength(1);
    expect(snap.holds[0]).toMatchObject({ id: live.id, amount: 700 });
    expect(snap.holds[0]!.ttlMs).toBeGreaterThan(100_000);
    expect(snap.holds[0]!.ttlMs).toBeLessThanOrEqual(120_000);
  });

  it('charges are numbered in order under concurrency, each carrying the running total', async () => {
    const t = await newTenant();
    const costs = Array.from({ length: 30 }, (_, i) => 10 + i);
    const recs = await Promise.all(costs.map((c) => ledger.settle(randomUUID(), entry(t, c))));
    const byCharge = [...recs].sort((x, y) => x.charges - y.charges);
    expect(byCharge.map((r) => r.charges)).toEqual(Array.from({ length: 30 }, (_, i) => i + 1));
    // Each running total is the previous one plus one charge, so the totals strictly increase and end at the sum.
    expect(byCharge.every((r, i) => i === 0 || r.spent > byCharge[i - 1]!.spent)).toBe(true);
    expect(byCharge.at(-1)!.spent).toBe(costs.reduce((a, b) => a + b, 0));
    expect(await ledger.spent(t, P)).toBe(byCharge.at(-1)!.spent);
  });

  it('a refund drops the hold and records nothing', async () => {
    const t = await newTenant();
    const a = reserveArgs(t, 1000, 1000);
    await ledger.reserve(a);
    expect(await ledger.settle(a.id, null)).toMatchObject({ recorded: false });
    expect(await heldRows(t)).toBe(0);
    expect(await ledger.spent(t, P)).toBe(0);
  });

  it('recording the same request twice charges once', async () => {
    const t = await newTenant();
    const e = entry(t, 500);
    expect(await ledger.settle(e.requestId, e)).toMatchObject({ recorded: true, charges: 1, spent: 500 });
    // A repeat (a retry after a lost reply) is not charged again but still reports the current totals, which
    // include the charge, so the live balance can be corrected from it.
    await ledger.settle(randomUUID(), entry(t, 70)); // someone else's charge lands in between
    expect(await ledger.settle(e.requestId, e)).toMatchObject({ recorded: false, spent: 570, charges: 2 });
    expect(await ledger.settle(e.requestId, { ...e, costMicros: 9999 })).toMatchObject({ recorded: false, spent: 570, charges: 2 });
    await ledger.settle(randomUUID(), null);
    expect(await ledger.spent(t, P)).toBe(570);
    const rows = await handle.db.execute(sql`select count(*) as n from spend_ledger where tenant_id = ${t}`);
    expect(Number(rows.rows[0]!.n)).toBe(2);
  });

  it('holds go with their tenant, and the sweep deletes only lapsed ones, at most `limit` per call', async () => {
    const gone = await newTenant();
    await ledger.hold(reserveArgs(gone, 100, 1000));
    expect(await heldRows(gone)).toBe(1);
    await handle.db.execute(sql`delete from tenants where id = ${gone}`);
    expect(await heldRows(gone)).toBe(0); // on delete cascade

    const t = await newTenant();
    const live = reserveArgs(t, 100, 1000);
    await ledger.hold(live);
    for (let i = 0; i < 3; i++) await ledger.hold(reserveArgs(t, 10, 1000, { ttlMs: -60_000 }));
    expect(await ledger.sweepExpired(0)).toBe(0);
    let removed = 0;
    while ((await heldRows(t)) > 1) removed += await ledger.sweepExpired(1);
    expect(removed).toBeGreaterThanOrEqual(3);
    expect(await heldRows(t)).toBe(1); // the live one survived
  });

  it('an expired hold does not count against the cap', async () => {
    const t = await newTenant();
    expect((await ledger.reserve(reserveArgs(t, 900, 1000, { ttlMs: -1000 }))).allowed).toBe(true);
    // The first hold lapsed already, so the full cap is free again.
    expect((await ledger.reserve(reserveArgs(t, 1000, 1000))).allowed).toBe(true);
    expect(await heldRows(t)).toBe(1);
  });

  it('lapsed holds are found by an index on expires_at', async () => {
    const r = await handle.db.execute(sql`select indexname from pg_indexes where tablename = 'budget_reservations'`);
    expect(r.rows.map((x) => x.indexname)).toEqual(
      expect.arrayContaining(['budget_reservations_expires_idx', 'budget_reservations_tenant_period_idx']),
    );
  });

  it('a bump from an epoch that is not the current one changes nothing and reports the current epoch', async () => {
    // Bumps that succeed are tested in budget.test.ts, the only file that moves the shared epoch.
    const current = await ledger.readEpoch();
    expect(current).toBeGreaterThanOrEqual(1);
    // (budget.test.ts may move the epoch meanwhile, so the reported epoch is at least the one read.)
    for (const stale of [0, current + 1000]) {
      const r = await ledger.bumpEpoch(stale);
      expect(r.bumped).toBe(false);
      expect(r.epoch).toBeGreaterThanOrEqual(current);
    }
  });
});
