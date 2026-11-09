import type { Redis } from 'ioredis';
import { applySpendBatch } from '../../gateway/src/budget/pg-ledger.ts';
import { applySettled } from '../../gateway/src/budget/redis-ledger.ts';
import type { Db } from '../../gateway/src/db/client.ts';
import { requestLog } from '../../gateway/src/db/schema.ts';
import { fromStreamFields, toRequestLogRow, type LogEntry, type SpendEntry } from '../../gateway/src/requestlog/entry.ts';
import type { Raw } from './claim.ts';

type Tx = Parameters<Parameters<Db['db']['transaction']>[0]>[0];

export interface Parsed {
  raw: Raw;
  log?: LogEntry;
  spend?: SpendEntry;
}

export interface BatchResult {
  /** Entries that are in Postgres now and can be acknowledged. */
  applied: Raw[];
  /** Stream ids that could not be parsed. Left unacknowledged: they come back until the delivery limit sends them to the dead-letter stream. */
  malformed: Array<{ id: string; errClass: string }>;
  /** Stream ids whose transaction failed on its own. Left unacknowledged too. */
  failed: Array<{ id: string; errClass: string; code?: string }>;
  /** Ledger rows and log rows actually inserted (a redelivered entry inserts none). */
  ledgerRows: number;
  logRows: number;
  /** What spend was applied, for catching the live balances up. */
  settled: Awaited<ReturnType<typeof applySpendBatch>>['settled'];
}

export function parse(raw: Raw[]): { parsed: Parsed[]; malformed: BatchResult['malformed'] } {
  const parsed: Parsed[] = [];
  const malformed: BatchResult['malformed'] = [];
  for (const r of raw) {
    try {
      const e = fromStreamFields(r.fields);
      parsed.push(e.kind === 'log' ? { raw: r, log: e.entry } : { raw: r, spend: e.entry });
    } catch (err) {
      malformed.push({ id: r.id, errClass: (err as Error).name });
    }
  }
  return { parsed, malformed };
}

// Writes request-log rows. A row that is already there (a redelivery) is left alone.
async function insertLogs(tx: Tx, entries: LogEntry[]): Promise<number> {
  const byId = new Map<string, LogEntry>();
  for (const e of entries) if (!byId.has(e.requestId)) byId.set(e.requestId, e);
  if (byId.size === 0) return 0;
  const rows = [...byId.values()].map(toRequestLogRow);
  const inserted = await tx.insert(requestLog).values(rows).onConflictDoNothing().returning({ id: requestLog.requestId });
  return inserted.length;
}

// One transaction: the ledger (and the spend and holds that go with it) and the request log. Either all of it is
// written or none, so an acknowledged entry is always fully applied.
async function applyIn(tx: Tx, items: Parsed[]) {
  const spend = await applySpendBatch(tx, items.flatMap((i) => (i.spend ? [i.spend] : [])));
  const logRows = await insertLogs(tx, items.flatMap((i) => (i.log ? [i.log] : [])));
  return { ledgerRows: spend.inserted, logRows, settled: spend.settled };
}

/**
 * Applies a batch in one Postgres transaction. If that transaction fails (one entry cannot be written, say a
 * tenant that no longer exists) the entries are tried one by one, so a single bad entry cannot hold the rest
 * back: it stays unacknowledged and is dead-lettered by its delivery count.
 */
export async function applyBatch(db: Db['db'], raw: Raw[]): Promise<BatchResult> {
  const { parsed, malformed } = parse(raw);
  const result: BatchResult = { applied: [], malformed, failed: [], ledgerRows: 0, logRows: 0, settled: [] };
  if (parsed.length === 0) return result;
  try {
    const r = await db.transaction((tx) => applyIn(tx, parsed));
    result.applied = parsed.map((p) => p.raw);
    Object.assign(result, { ledgerRows: r.ledgerRows, logRows: r.logRows, settled: r.settled });
    return result;
  } catch {
    // fall through to the one-by-one pass
  }
  for (const item of parsed) {
    try {
      const r = await db.transaction((tx) => applyIn(tx, [item]));
      result.applied.push(item.raw);
      result.ledgerRows += r.ledgerRows;
      result.logRows += r.logRows;
      result.settled.push(...r.settled);
    } catch (err) {
      result.failed.push({ id: item.raw.id, errClass: (err as Error).name, ...((err as { code?: string }).code ? { code: (err as { code?: string }).code } : {}) });
    }
  }
  return result;
}

/** Catches the live balances up with what was just written, on `epoch`. Best effort: the balance is also rebuilt from Postgres when it is lost. */
export async function catchUp(redis: Redis, keyPrefix: string, epoch: number, settled: BatchResult['settled'], timeoutMs: number): Promise<number> {
  if (settled.length === 0) return 0;
  return applySettled(redis, keyPrefix, epoch, settled, timeoutMs);
}
