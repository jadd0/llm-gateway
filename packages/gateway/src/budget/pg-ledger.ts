import { eq, and, sql } from 'drizzle-orm';
import type { Db } from '../db/client.ts';
import { budgetEpoch, budgetReservations, spendLedger, tenantSpend } from '../db/schema.ts';
import type { Period } from './period.ts';

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

export interface PgLedger {
  /** Settled spend for the period; 0 when nothing was recorded. */
  spent(tenantId: string, period: Period): Promise<number>;
  /**
   * Checks the cap and holds the money in one short transaction. The tenant's spend row is locked for
   * the check only: the lock is released when this returns, long before the provider answers.
   */
  reserve(args: PgReserveArgs): Promise<{ allowed: boolean; remaining: number }>;
  /** Records a settled request (once per request id) and adds it to the period's spend. True if it was new. */
  record(entry: SpendEntry): Promise<boolean>;
  /** Drops a hold and records the charge in one transaction. `entry` is null for a refund. True if a charge was new. */
  settle(id: string, entry: SpendEntry | null): Promise<boolean>;
  /** Reads the budget epoch, creating it at 1 on first use. */
  readEpoch(): Promise<number>;
  /** Moves the epoch on and returns the new value. */
  bumpEpoch(): Promise<number>;
}

// Inserts the ledger row and adds to the period's spend in the caller's transaction. The ledger's
// primary key makes a repeat a no-op, so a retried settle never charges twice.
async function recordIn(tx: Tx, e: SpendEntry): Promise<boolean> {
  const inserted = await tx.insert(spendLedger).values(e).onConflictDoNothing().returning({ id: spendLedger.requestId });
  if (inserted.length === 0) return false;
  await tx
    .insert(tenantSpend)
    .values({ tenantId: e.tenantId, period: e.period, spentMicros: e.costMicros })
    .onConflictDoUpdate({
      target: [tenantSpend.tenantId, tenantSpend.period],
      set: { spentMicros: sql`${tenantSpend.spentMicros} + ${e.costMicros}` },
    });
  return true;
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
        const [held] = await tx
          .select({ held: sql<string>`coalesce(sum(${budgetReservations.amountMicros}), 0)` })
          .from(budgetReservations)
          .where(and(eq(budgetReservations.tenantId, a.tenantId), eq(budgetReservations.period, a.period)));
        const reserved = Number(held?.held ?? 0);
        const room = Math.max(0, a.cap - spent - reserved);
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

    record: (entry) => db.transaction((tx) => recordIn(tx, entry)),

    settle: (id, entry) =>
      db.transaction(async (tx) => {
        await tx.delete(budgetReservations).where(eq(budgetReservations.id, id));
        return entry === null ? false : recordIn(tx, entry);
      }),

    async readEpoch() {
      await db.insert(budgetEpoch).values({ id: 1, epoch: 1 }).onConflictDoNothing();
      const [row] = await db.select({ epoch: budgetEpoch.epoch }).from(budgetEpoch).where(eq(budgetEpoch.id, 1));
      return row!.epoch;
    },

    async bumpEpoch() {
      await db.insert(budgetEpoch).values({ id: 1, epoch: 1 }).onConflictDoNothing();
      const [row] = await db
        .update(budgetEpoch)
        .set({ epoch: sql`${budgetEpoch.epoch} + 1` })
        .where(eq(budgetEpoch.id, 1))
        .returning({ epoch: budgetEpoch.epoch });
      return row!.epoch;
    },
  };
}
