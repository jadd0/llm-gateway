import { eq, and, sql } from 'drizzle-orm';
import type { Db } from '../db/client.ts';
import { budgetEpoch, budgetReservations, spendLedger, tenantSpend } from '../db/schema.ts';
import type { Period } from './period.ts';
import type { Snapshot } from './redis-ledger.ts';

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
  /** The budget epoch just after the transaction committed: the one the live balance should be corrected on. */
  epoch: number;
}

export interface PgLedger {
  /** Settled spend for the period; 0 when nothing was recorded. */
  spent(tenantId: string, period: Period): Promise<number>;
  /** Settled spend, charge count and every unexpired hold, read in one consistent snapshot. */
  snapshot(tenantId: string, period: Period): Promise<Snapshot>;
  /**
   * Checks the cap and holds the money in one short transaction, counting every unexpired hold (those
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
  /** Deletes up to `limit` lapsed holds, whoever placed them. Returns how many. */
  sweepExpired(limit: number): Promise<number>;
  /**
   * Drops a hold and records the charge (once per request id) in one transaction. `entry` is null for a
   * refund.
   */
  settle(id: string, entry: SpendEntry | null): Promise<SettleRecord>;
  /** Reads the budget epoch, creating it at 1 on first use. */
  readEpoch(): Promise<number>;
  /**
   * Moves the epoch on from `observed`, only if it is still `observed`. Of several instances that saw
   * the same outage, one bumps; the others get the new value. `bumped` says which this was.
   */
  bumpEpoch(observed: number): Promise<{ epoch: number; bumped: boolean }>;
}

// Inserts the ledger row and adds to the period's spend in the caller's transaction. The ledger's
// primary key makes a repeat a no-op, so a retried settle never charges twice. The spend row is updated
// under its lock, so the charge count it returns orders charges in commit order.
async function recordIn(tx: Tx, e: SpendEntry): Promise<Omit<SettleRecord, 'epoch'>> {
  const inserted = await tx.insert(spendLedger).values(e).onConflictDoNothing().returning({ id: spendLedger.requestId });
  if (inserted.length === 0) {
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
        // Expired holds are dropped; the rest count against the cap. now() is the database's one clock.
        await tx
          .delete(budgetReservations)
          .where(
            and(
              eq(budgetReservations.tenantId, a.tenantId),
              eq(budgetReservations.period, a.period),
              sql`${budgetReservations.expiresAt} <= now()`,
            ),
          );
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
            .where(
              and(
                eq(budgetReservations.tenantId, tenantId),
                eq(budgetReservations.period, period),
                sql`${budgetReservations.expiresAt} > now()`,
              ),
            );
          return {
            spent: row?.spent ?? 0,
            charges: row?.charges ?? 0,
            holds: holds.map((h) => ({ id: h.id, amount: h.amount, ttlMs: Math.max(1, Number(h.ttlMs)) })),
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

    async sweepExpired(limit) {
      const r = await db.execute(sql`
        delete from budget_reservations
        where id in (select id from budget_reservations where expires_at < now() limit ${limit})`);
      return r.rowCount ?? 0;
    },

    async settle(id, entry) {
      const rec = await db.transaction(async (tx) => {
        await tx.delete(budgetReservations).where(eq(budgetReservations.id, id));
        return entry === null ? { recorded: false, spent: 0, charges: 0 } : recordIn(tx, entry);
      });
      // The epoch is read after the commit. A balance rebuilt from a snapshot taken before the commit still
      // holds this request's hold, and it can only be at an epoch that is current now or older.
      const [e] = await db.select({ epoch: budgetEpoch.epoch }).from(budgetEpoch).where(eq(budgetEpoch.id, 1));
      return { ...rec, epoch: e?.epoch ?? 1 };
    },

    async readEpoch() {
      await db.insert(budgetEpoch).values({ id: 1, epoch: 1 }).onConflictDoNothing();
      const [row] = await db.select({ epoch: budgetEpoch.epoch }).from(budgetEpoch).where(eq(budgetEpoch.id, 1));
      return row!.epoch;
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
