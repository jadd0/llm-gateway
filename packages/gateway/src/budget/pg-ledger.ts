import { eq, and, inArray, sql } from 'drizzle-orm';
import type { Db } from '../db/client.ts';
import { budgetEpoch, budgetReservations, spendLedger, tenantSpend } from '../db/schema.ts';
import type { Period } from './period.ts';
import type { SpendEntry as QueuedSpend } from '../requestlog/entry.ts';
import type { AppliedSettle, Snapshot } from './redis-ledger.ts';

type Tx = Parameters<Parameters<Db['db']['transaction']>[0]>[0];

/** One settled request, as recorded in `spend_ledger`. */
export interface SpendEntry {
  requestId: string;
  tenantId: string;
  period: Period;
  model: string;
  promptTokens: number;
  completionTokens: number;
  costMicros: number;
  /** True when no usage was seen and the reserved estimate was charged. */
  estimated: boolean;
}

/** One response served from the cache, as recorded in `spend_ledger`: it cost nothing and saved `savedMicros`. */
export interface HitEntry {
  requestId: string;
  tenantId: string;
  period: Period;
  model: string;
  promptTokens: number;
  completionTokens: number;
  savedMicros: number;
}

export interface PgReserveArgs {
  id: string;
  tenantId: string;
  period: Period;
  estimate: number;
  cap: number;
  ttlMs: number;
}

/** What recording a settle changed. */
export interface SettleRecord {
  /** True if this request's charge was new; false for a refund or a repeat. */
  recorded: boolean;
  /**
   * tenant_spend.spent_micros and .charges for a settle that carried a charge: right after it for a new
   * charge, the current values for a repeat (a retry after a lost reply must still be able to correct the
   * live balance). 0 for a refund.
   */
  spent: number;
  charges: number;
  /**
   * The budget epoch just after the transaction committed: the one the live balance should be corrected on.
   * null if it could not be read; the charge is committed regardless.
   */
  epoch: number | null;
}

export interface PgLedger {
  /** Settled spend for the period; 0 when nothing was recorded. */
  spent(tenantId: string, period: Period): Promise<number>;
  /** Settled spend, charge count and every hold row (lapsed ones included), read in one consistent snapshot. */
  snapshot(tenantId: string, period: Period): Promise<Snapshot>;
  /**
   * Checks the cap and holds the money in one short transaction, counting every hold row (those
   * placed by Redis-path requests too). The tenant's spend row is locked for the check only: the lock
   * is released when this returns, long before the provider answers.
   */
  reserve(args: PgReserveArgs): Promise<{ allowed: boolean; remaining: number }>;
  /**
   * Writes a hold before Redis is asked, so a Postgres snapshot or a Postgres-path reserve that runs
   * meanwhile counts it. No check; writing the same id again changes nothing.
   */
  hold(args: Omit<PgReserveArgs, 'cap'>): Promise<void>;
  /** Drops a hold that is not going to be used (Redis refused it). */
  release(id: string): Promise<void>;
  /**
   * Marks a hold as refused when dropping it failed: it then counts against no cap, and the sweeper deletes it
   * instead of charging its estimate.
   */
  markRefused(id: string): Promise<void>;
  /**
   * Drops a hold and records the charge (once per request id) in one transaction. `entry` is null for a
   * refund.
   */
  settle(id: string, entry: SpendEntry | null): Promise<SettleRecord>;
  /**
   * Records a cache hit: one zero-cost ledger row. The tenant's spend and charge count are untouched, so
   * the balance (and the Redis copy of it) is exactly what it was.
   */
  recordHit(entry: HitEntry): Promise<void>;
  /** Creates the single epoch row (at 1) if it is missing. Once, when a budget starts. */
  ensureEpoch(): Promise<void>;
  /** Reads the budget epoch: a plain select, safe to run every few hundred milliseconds. */
  readEpoch(): Promise<number>;
  /**
   * Moves the epoch on from `observed`, only if it is still `observed`. Of several instances that saw
   * the same outage, one bumps; the others get the new value. `bumped` says which this was.
   */
  bumpEpoch(observed: number): Promise<{ epoch: number; bumped: boolean }>;
}

/** A change to a month's totals: the spend moves by `cost` (may be negative) and the charge count by `n`. */
interface Correction {
  tenantId: string;
  period: string;
  cost: number;
  n: number;
}

/**
 * Replaces charges the sweeper made at the estimate with what the request really cost, and removes the charge of
 * a request that was in fact refunded. The sweeper charges a lapsed hold whose settle was still queued; when that
 * settle is applied the ledger row already exists, and leaving it would bill the estimate for good. Only rows with
 * `estimated = true` are touched, locked in id order. Returns the change to each month's totals.
 */
async function correctEstimated(tx: Tx, reals: SpendEntry[], refundIds: string[]): Promise<Correction[]> {
  const out: Correction[] = [];
  const byId = new Map(reals.map((r) => [r.requestId, r]));
  if (byId.size > 0) {
    const old = await tx
      .select({ id: spendLedger.requestId, cost: spendLedger.costMicros })
      .from(spendLedger)
      .where(and(inArray(spendLedger.requestId, [...byId.keys()]), eq(spendLedger.estimated, true)))
      .orderBy(spendLedger.requestId)
      .for('update');
    for (const o of old) {
      const r = byId.get(o.id)!;
      await tx
        .update(spendLedger)
        .set({ model: r.model, promptTokens: r.promptTokens, completionTokens: r.completionTokens, costMicros: r.costMicros, estimated: false })
        .where(eq(spendLedger.requestId, o.id));
      out.push({ tenantId: r.tenantId, period: r.period, cost: r.costMicros - o.cost, n: 0 });
    }
  }
  if (refundIds.length > 0) {
    const gone = await tx
      .delete(spendLedger)
      .where(and(inArray(spendLedger.requestId, refundIds), eq(spendLedger.estimated, true)))
      .returning({ tenantId: spendLedger.tenantId, period: spendLedger.period, cost: spendLedger.costMicros });
    for (const g of gone) out.push({ tenantId: g.tenantId, period: g.period, cost: -g.cost, n: -1 });
  }
  return out;
}

// Adds each month's change to tenant_spend, one upsert per tenant and month, in a fixed order so two workers
// cannot wait on each other.
async function applyCorrections(tx: Tx, changes: Correction[]): Promise<void> {
  const totals = new Map<string, Correction>();
  for (const c of changes) {
    const t = totals.get(`${c.tenantId}|${c.period}`) ?? { tenantId: c.tenantId, period: c.period, cost: 0, n: 0 };
    t.cost += c.cost;
    t.n += c.n;
    totals.set(`${c.tenantId}|${c.period}`, t);
  }
  for (const key of [...totals.keys()].sort()) {
    const t = totals.get(key)!;
    if (t.cost === 0 && t.n === 0) continue;
    await tx
      .insert(tenantSpend)
      .values({ tenantId: t.tenantId, period: t.period, spentMicros: t.cost, charges: t.n })
      .onConflictDoUpdate({
        target: [tenantSpend.tenantId, tenantSpend.period],
        set: { spentMicros: sql`${tenantSpend.spentMicros} + ${t.cost}`, charges: sql`${tenantSpend.charges} + ${t.n}` },
      });
  }
}

// Inserts the ledger row and adds to the period's spend in the caller's transaction. The ledger's
// primary key makes a repeat a no-op, so a retried settle never charges twice. The spend row is updated
// under its lock, so the charge count it returns orders charges in commit order.
async function recordIn(tx: Tx, e: SpendEntry): Promise<Omit<SettleRecord, 'epoch'>> {
  const inserted = await tx.insert(spendLedger).values(e).onConflictDoNothing().returning({ id: spendLedger.requestId });
  if (inserted.length === 0) {
    // The sweeper may have charged the estimate first: the real cost replaces it.
    if (!e.estimated) await applyCorrections(tx, await correctEstimated(tx, [e], []));
    // Already recorded (a retry whose first reply was lost). Its charge is in tenant_spend, so hand back
    // the current totals: they include it, and the live balance only takes them if it is behind.
    const [cur] = await tx
      .select({ spent: tenantSpend.spentMicros, charges: tenantSpend.charges })
      .from(tenantSpend)
      .where(and(eq(tenantSpend.tenantId, e.tenantId), eq(tenantSpend.period, e.period)));
    return { recorded: false, spent: cur?.spent ?? 0, charges: cur?.charges ?? 0 };
  }
  const [row] = await tx
    .insert(tenantSpend)
    .values({ tenantId: e.tenantId, period: e.period, spentMicros: e.costMicros, charges: 1 })
    .onConflictDoUpdate({
      target: [tenantSpend.tenantId, tenantSpend.period],
      set: {
        spentMicros: sql`${tenantSpend.spentMicros} + ${e.costMicros}`,
        charges: sql`${tenantSpend.charges} + 1`,
      },
    })
    .returning({ spent: tenantSpend.spentMicros, charges: tenantSpend.charges });
  return { recorded: true, spent: row!.spent, charges: row!.charges };
}

export function createPgLedger(db: Db['db']): PgLedger {
  return {
    async spent(tenantId, period) {
      const rows = await db
        .select({ spent: tenantSpend.spentMicros })
        .from(tenantSpend)
        .where(and(eq(tenantSpend.tenantId, tenantId), eq(tenantSpend.period, period)));
      return rows[0]?.spent ?? 0;
    },

    async reserve(a) {
      return db.transaction(async (tx) => {
        await tx
          .insert(tenantSpend)
          .values({ tenantId: a.tenantId, period: a.period })
          .onConflictDoNothing();
        // The lock that serialises every reservation for this tenant and month.
        const [row] = await tx
          .select({ spent: tenantSpend.spentMicros })
          .from(tenantSpend)
          .where(and(eq(tenantSpend.tenantId, a.tenantId), eq(tenantSpend.period, a.period)))
          .for('update');
        const spent = row?.spent ?? 0;
        // This request's own hold, if it was written ahead of a Redis attempt that then failed, is not
        // counted twice: it is replaced below.
        const [held] = await tx
          .select({ held: sql<string>`coalesce(sum(${budgetReservations.amountMicros}), 0)` })
          .from(budgetReservations)
          .where(
            and(
              eq(budgetReservations.tenantId, a.tenantId),
              eq(budgetReservations.period, a.period),
              sql`${budgetReservations.id} <> ${a.id}`,
              eq(budgetReservations.refused, false),
              // Lapsed holds count too: a hold row stays until its settle is applied or the worker's sweeper
              // charges its estimate, and its settle may be queued, so it is money not yet in spent.
            ),
          );
        const reserved = Number(held?.held ?? 0);
        const room = Math.max(0, a.cap - spent - reserved);
        // Either way the hold written ahead of a Redis attempt goes: refused, or replaced just below.
        await tx.delete(budgetReservations).where(eq(budgetReservations.id, a.id));
        if (spent + reserved + a.estimate > a.cap) return { allowed: false, remaining: room };
        await tx.insert(budgetReservations).values({
          id: a.id,
          tenantId: a.tenantId,
          period: a.period,
          amountMicros: a.estimate,
          expiresAt: sql`now() + ${a.ttlMs} * interval '1 millisecond'`,
        });
        return { allowed: true, remaining: room - a.estimate };
      });
    },

    async snapshot(tenantId, period) {
      // One snapshot: a settle commits its hold removal and its charge together, so this sees both or neither.
      return db.transaction(
        async (tx) => {
          const [row] = await tx
            .select({ spent: tenantSpend.spentMicros, charges: tenantSpend.charges })
            .from(tenantSpend)
            .where(and(eq(tenantSpend.tenantId, tenantId), eq(tenantSpend.period, period)));
          const holds = await tx
            .select({
              id: budgetReservations.id,
              amount: budgetReservations.amountMicros,
              ttlMs: sql<string>`floor(extract(epoch from (${budgetReservations.expiresAt} - now())) * 1000)`,
            })
            .from(budgetReservations)
            .where(and(eq(budgetReservations.tenantId, tenantId), eq(budgetReservations.period, period), eq(budgetReservations.refused, false)));
          // Charges made at the estimate: a balance rebuilt now counts them, and the real cost, if it arrives
          // later, is a correction to apply (see budget.lua).
          const estimated = await tx
            .select({ id: spendLedger.requestId, cost: spendLedger.costMicros })
            .from(spendLedger)
            .where(and(eq(spendLedger.tenantId, tenantId), eq(spendLedger.period, period), eq(spendLedger.estimated, true)));
          // Every row, lapsed or not: a row exists exactly until its charge is in the ledger, so a lapsed one is
          // a settle still queued (or a hold waiting for the sweeper) and must count against the cap.
          return {
            spent: row?.spent ?? 0,
            charges: row?.charges ?? 0,
            holds: holds.map((h) => ({ id: h.id, amount: h.amount, ttlMs: Number(h.ttlMs) })),
            estimated,
          };
        },
        { isolationLevel: 'repeatable read' },
      );
    },

    async hold(a) {
      await db
        .insert(budgetReservations)
        .values({
          id: a.id,
          tenantId: a.tenantId,
          period: a.period,
          amountMicros: a.estimate,
          expiresAt: sql`now() + ${a.ttlMs} * interval '1 millisecond'`,
        })
        .onConflictDoNothing();
    },

    async release(id) {
      await db.delete(budgetReservations).where(eq(budgetReservations.id, id));
    },

    async markRefused(id) {
      await db.update(budgetReservations).set({ refused: true }).where(eq(budgetReservations.id, id));
    },

    async settle(id, entry) {
      const rec = await db.transaction(async (tx) => {
        await tx.delete(budgetReservations).where(eq(budgetReservations.id, id));
        if (entry === null) {
          // A refund that arrives after the sweeper charged the estimate takes the charge back.
          await applyCorrections(tx, await correctEstimated(tx, [], [id]));
          return { recorded: false, spent: 0, charges: 0 };
        }
        return recordIn(tx, entry);
      });
      // The epoch is read after the commit. A balance rebuilt from a snapshot taken before the commit still
      // holds this request's hold, and it can only be at an epoch that is current now or older.
      // The charge is committed whatever happens to this read: failing here must not look like a failed settle.
      try {
        const [e] = await db.select({ epoch: budgetEpoch.epoch }).from(budgetEpoch).where(eq(budgetEpoch.id, 1));
        return { ...rec, epoch: e?.epoch ?? 1 };
      } catch {
        return { ...rec, epoch: null };
      }
    },

    async recordHit(e) {
      await db
        .insert(spendLedger)
        .values({ ...e, costMicros: 0, estimated: false, cached: true })
        .onConflictDoNothing();
    },

    async ensureEpoch() {
      await db.insert(budgetEpoch).values({ id: 1, epoch: 1 }).onConflictDoNothing();
    },

    async readEpoch() {
      const [row] = await db.select({ epoch: budgetEpoch.epoch }).from(budgetEpoch).where(eq(budgetEpoch.id, 1));
      return row?.epoch ?? 1;
    },

    async bumpEpoch(observed) {
      await db.insert(budgetEpoch).values({ id: 1, epoch: 1 }).onConflictDoNothing();
      const [row] = await db
        .update(budgetEpoch)
        .set({ epoch: sql`${budgetEpoch.epoch} + 1` })
        .where(and(eq(budgetEpoch.id, 1), eq(budgetEpoch.epoch, observed)))
        .returning({ epoch: budgetEpoch.epoch });
      if (row) return { epoch: row.epoch, bumped: true };
      const [now] = await db.select({ epoch: budgetEpoch.epoch }).from(budgetEpoch).where(eq(budgetEpoch.id, 1));
      return { epoch: now!.epoch, bumped: false };
    },
  };
}

/**
 * Writes queued spend to the ledger, in the caller's transaction. A ledger row that is already there is left
 * alone (`ON CONFLICT DO NOTHING`), and `tenant_spend` grows only by the rows actually inserted, so an entry
 * delivered twice is applied once. The exception is a row the sweeper wrote at the estimate: a real charge for
 * that request replaces it (and a refund removes it), with `tenant_spend` moved by the difference.
 * Every charge and refund then drops its hold, whether or not the row was new.
 * Returns the charges and refunds, for catching the live balances up (see `applySettled`).
 */
export async function applySpendBatch(tx: Tx, entries: QueuedSpend[]): Promise<{ inserted: number; settled: AppliedSettle[] }> {
  // The same request twice in one batch (a redelivery next to the original) is one row.
  const byId = new Map<string, QueuedSpend>();
  for (const e of entries) if (!byId.has(e.id)) byId.set(e.id, e);
  const unique = [...byId.values()];

  const rows = unique
    .filter((e) => e.kind !== 'refund')
    .map((e) => ({
      requestId: e.id,
      tenantId: e.tenantId,
      period: e.period,
      model: e.model,
      promptTokens: e.promptTokens,
      completionTokens: e.completionTokens,
      costMicros: e.kind === 'hit' ? 0 : e.costMicros,
      estimated: e.kind === 'charge' && e.estimated,
      cached: e.kind === 'hit',
      savedMicros: e.kind === 'hit' ? e.savedMicros : 0,
    }));
  const inserted = rows.length
    ? await tx
        .insert(spendLedger)
        .values(rows)
        .onConflictDoNothing()
        .returning({ id: spendLedger.requestId, tenantId: spendLedger.tenantId, period: spendLedger.period, cost: spendLedger.costMicros, cached: spendLedger.cached })
    : [];

  const changes: Correction[] = inserted.filter((r) => !r.cached).map((r) => ({ tenantId: r.tenantId, period: r.period, cost: r.cost, n: 1 }));
  // A real charge or a refund whose request the sweeper already charged at its estimate: the row is replaced (or
  // removed) and the month's spend moves by the difference, in this transaction.
  const insertedIds = new Set(inserted.map((r) => r.id));
  const reals = rows
    .filter((r) => !r.cached && !r.estimated && !insertedIds.has(r.requestId))
    .map((r) => ({ ...r, costMicros: r.costMicros }));
  const refundIds = unique.filter((e) => e.kind === 'refund').map((e) => e.id);
  changes.push(...(await correctEstimated(tx, reals, refundIds)));
  await applyCorrections(tx, changes);

  const holdIds = unique.filter((e) => e.kind !== 'hit').map((e) => e.id);
  if (holdIds.length) await tx.delete(budgetReservations).where(inArray(budgetReservations.id, holdIds));
  return {
    inserted: inserted.length,
    settled: unique
      .filter((e) => e.kind !== 'hit')
      .map((e) => ({ tenantId: e.tenantId, period: e.period, id: e.id, costMicros: e.kind === 'charge' ? e.costMicros : 0, estimated: e.kind === 'charge' && e.estimated })),
  };
}

/**
 * Charges the estimate of holds that lapsed with no settle (the gateway died, or its entry was lost), up to
 * `limit`, in one transaction. Only holds that lapsed more than `graceMs` ago: a settle queued before the hold
 * lapsed has had that long to be applied, and a hold swept before then would be charged its estimate in place
 * of the real cost. `tenantId` limits the sweep to one tenant (tests, which share a database). They are recorded as estimated charges with the model unknown: the hold knows
 * its amount and nothing else. A hold is never dropped uncharged. Returns what was charged.
 */
export async function chargeExpiredHolds(db: Db['db'], limit: number, graceMs = 0, tenantId?: string): Promise<AppliedSettle[]> {
  const mine = (col: typeof budgetReservations.tenantId) => (tenantId === undefined ? undefined : eq(col, tenantId));
  return db.transaction(async (tx) => {
    // A refused request's hold is never charged: it is deleted.
    await tx.delete(budgetReservations).where(and(eq(budgetReservations.refused, true), mine(budgetReservations.tenantId)));
    const lapsed = await tx
      .select({ id: budgetReservations.id, tenantId: budgetReservations.tenantId, period: budgetReservations.period, amount: budgetReservations.amountMicros })
      .from(budgetReservations)
      .where(and(eq(budgetReservations.refused, false), mine(budgetReservations.tenantId), sql`${budgetReservations.expiresAt} < now() - ${graceMs} * interval '1 millisecond'`))
      .orderBy(budgetReservations.expiresAt)
      .limit(limit)
      .for('update', { skipLocked: true });
    if (lapsed.length === 0) return [];
    const { settled } = await applySpendBatch(
      tx,
      lapsed.map((h) => ({
        kind: 'charge' as const, id: h.id, tenantId: h.tenantId, period: h.period, model: 'unknown',
        promptTokens: 0, completionTokens: 0, costMicros: h.amount, estimated: true, savedMicros: 0,
      })),
    );
    return settled;
  });
}
