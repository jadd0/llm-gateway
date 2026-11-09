import { eq, inArray, lte, sql } from 'drizzle-orm';
import type { Db } from '../db/client.ts';
import { semanticCache } from '../db/schema.ts';
import type { GuardSignature } from './guards.ts';

export interface SemanticRow {
  scope: string;
  contextHash: string;
  /** The response-cache key holding the answer. */
  exactKey: string;
  embedding: number[];
  embedder: string;
  /** What the guards compare; the prompt text itself is not stored. */
  guardSig: GuardSignature;
  expiresAt: Date;
}

export interface NearestQuery {
  scope: string;
  contextHash: string;
  embedding: number[];
  /** Only rows made by this embedder; absent: any. */
  embedder?: string;
  /** Rows expiring at or before this are not candidates. */
  now: Date;
  /** Postgres cancels the query after this long (a transaction-local statement_timeout), freeing its connection. */
  timeoutMs: number;
}

export interface Nearest {
  id: number;
  exactKey: string;
  /** Cosine similarity, 1 for the same direction. */
  similarity: number;
  embedder: string;
  guardSig: GuardSignature;
}

export interface SemanticStore {
  /** One row per (scope, exact key): a second insert for the same entry replaces the vector and extends the expiry. */
  upsert(row: SemanticRow): Promise<void>;
  /** The most similar unexpired row of this scope and context, or undefined. Throws when Postgres fails or cancels it. */
  nearest(q: NearestQuery): Promise<Nearest | undefined>;
  remove(id: number): Promise<void>;
  /** Deletes up to `limit` rows expired at `now`, oldest first; returns how many. */
  cleanupBatch(now: Date, limit: number): Promise<number>;
}

// pgvector's text form of a vector.
const literal = (v: number[]) => `[${v.join(',')}]`;

/** What start-up learned about the pgvector this database runs. */
export interface Pgvector {
  version: string;
  /** 0.8 and later can keep an index scan going until a filtered query has its rows. */
  iterativeScan: boolean;
}

/** The version of the `vector` extension installed in this database; undefined when it is not. */
export async function pgvectorVersion(db: Db['db']): Promise<string | undefined> {
  const res = await db.execute<{ extversion: string }>(sql`SELECT extversion FROM pg_extension WHERE extname = 'vector'`);
  return res.rows[0]?.extversion;
}

export const PGVECTOR_HELP = 'The semantic cache needs the pgvector extension (0.8 or later preferred): run Postgres from the pgvector/pgvector image (docker-compose.yml pins it), or install pgvector and run CREATE EXTENSION vector.';

/** Whether a migration failed because this Postgres has no pgvector (its error names the missing control file or type, not the fix). */
export function isMissingPgvector(err: unknown): boolean {
  const text = [(err as Error | undefined)?.message, (err as { cause?: { message?: string } } | undefined)?.cause?.message].join(' ');
  return /extension "vector"|vector\.control|type "vector"/.test(text);
}

/** Reads the extension version, or throws an error that says what is missing. */
export async function checkPgvector(db: Db['db']): Promise<Pgvector> {
  let version: string | undefined;
  try {
    version = await pgvectorVersion(db);
  } catch (err) {
    throw new Error(`could not read the pgvector version from Postgres (${(err as { code?: string }).code ?? (err as Error).name}). ${PGVECTOR_HELP}`);
  }
  if (!version) throw new Error(`the pgvector extension is not installed in this database. ${PGVECTOR_HELP}`);
  const [major = 0, minor = 0] = version.split('.').map(Number);
  return { version, iterativeScan: major > 0 || minor >= 8 };
}

export interface SemanticStoreOptions {
  /** From `checkPgvector`, set once start-up has read it and read on every query. Absent: the version is not known and the portable query is used. */
  pgvector?: Pgvector;
  /**
   * A scope and context holding at most this many rows is searched exactly, by reading them and ranking by
   * distance, without the vector index. Above it the index (or, before pgvector 0.8, an exact sort) answers.
   */
  exactMax?: number;
}

/** Rows a scope and context may hold before nearest stops reading them all. */
export const EXACT_MAX = 1000;

export function createSemanticStore(db: Db['db'], options: SemanticStoreOptions = {}): SemanticStore {
  const exactMax = options.exactMax ?? EXACT_MAX;
  return {
    async upsert(r) {
      await db
        .insert(semanticCache)
        .values(r)
        .onConflictDoUpdate({
          target: [semanticCache.scope, semanticCache.exactKey],
          set: { contextHash: r.contextHash, embedding: r.embedding, embedder: r.embedder, guardSig: r.guardSig, expiresAt: r.expiresAt, createdAt: sql`now()` },
        });
    },

    async nearest(q) {
      const vec = sql`${literal(q.embedding)}::vector`;
      // Scope, context and expiry are conditions of the query, so only rows that may be served are ranked.
      const eligible = sql`scope = ${q.scope} AND context_hash = ${q.contextHash} AND expires_at > ${q.now}${q.embedder === undefined ? sql`` : sql` AND embedder = ${q.embedder}`}`;
      type R = { id: string; exact_key: string; embedder: string; guard_sig: GuardSignature; distance: number; n?: string };
      const rows = await db.transaction(async (tx) => {
        // Postgres, not the caller, ends a slow query: the work stops and the connection is free again.
        await tx.execute(sql`SELECT set_config('statement_timeout', ${String(Math.max(1, Math.floor(q.timeoutMs)))}, true)`);
        // A scope and context with few rows is ranked exactly: read them through the (scope, context) index and
        // sort by distance. A vector index scan filters after it searches, so on a table shared with many tenants
        // it can give up before reaching the few rows that qualify; this path never touches it.
        const small = await tx.execute<R>(sql`
          SELECT id, exact_key, embedder, guard_sig, embedding <=> ${vec} AS distance, count(*) OVER () AS n
          FROM (SELECT id, exact_key, embedder, guard_sig, embedding FROM semantic_cache WHERE ${eligible} LIMIT ${exactMax + 1}) c
          ORDER BY distance LIMIT 1`);
        if (small.rows.length === 0 || Number(small.rows[0]!.n) <= exactMax) return small.rows;
        // Many rows: the vector index. From pgvector 0.8 its scan continues until the filtered query has its row
        // (strict_order keeps the order exact); before that there is no such scan, so the index is switched off
        // for this query and Postgres reads the filtered set and sorts it, which is exact.
        if (options.pgvector?.iterativeScan === true) {
          await tx.execute(sql`SELECT set_config('hnsw.iterative_scan', 'strict_order', true), set_config('hnsw.max_scan_tuples', '1000000', true)`);
        } else {
          await tx.execute(sql`SELECT set_config('enable_indexscan', 'off', true)`);
        }
        const large = await tx.execute<R>(sql`
          SELECT id, exact_key, embedder, guard_sig, embedding <=> ${vec} AS distance
          FROM semantic_cache WHERE ${eligible} ORDER BY embedding <=> ${vec} LIMIT 1`);
        return large.rows;
      });
      const row = rows[0];
      if (!row) return undefined;
      return { id: Number(row.id), exactKey: row.exact_key, embedder: row.embedder, guardSig: row.guard_sig, similarity: 1 - Number(row.distance) };
    },

    async remove(id) {
      await db.delete(semanticCache).where(eq(semanticCache.id, id));
    },

    async cleanupBatch(now, limit) {
      const gone = await db.delete(semanticCache).where(
        inArray(
          semanticCache.id,
          db.select({ id: semanticCache.id }).from(semanticCache).where(lte(semanticCache.expiresAt, now)).orderBy(semanticCache.expiresAt).limit(limit).for('update', { skipLocked: true }),
        ),
      ).returning({ id: semanticCache.id });
      return gone.length;
    },
  };
}

/** Deletes every expired row, `batch` at a time so no delete holds many locks; returns the counts. */
export async function sweepExpired(store: SemanticStore, now: Date, batch: number): Promise<{ deleted: number; batches: number }> {
  let deleted = 0;
  let batches = 0;
  for (;;) {
    const n = await store.cleanupBatch(now, batch);
    if (n === 0) return { deleted, batches };
    deleted += n;
    batches += 1;
    if (n < batch) return { deleted, batches };
  }
}
