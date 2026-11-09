import { and, cosineDistance, eq, gt, inArray, lte, sql } from 'drizzle-orm';
import type { Db } from '../db/client.ts';
import { semanticCache } from '../db/schema.ts';

export interface SemanticRow {
  scope: string;
  contextHash: string;
  /** The response-cache key holding the answer. */
  exactKey: string;
  embedding: number[];
  embedder: string;
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
}

export interface Nearest {
  id: number;
  exactKey: string;
  /** Cosine similarity, 1 for the same direction. */
  similarity: number;
  embedder: string;
}

export interface SemanticStore {
  /** One row per (scope, exact key): a second insert for the same entry replaces the vector and extends the expiry. */
  upsert(row: SemanticRow): Promise<void>;
  /** The most similar unexpired row of this scope and context, or undefined. */
  nearest(q: NearestQuery): Promise<Nearest | undefined>;
  remove(id: number): Promise<void>;
  /** Deletes up to `limit` rows expired at `now`, oldest first; returns how many. */
  cleanupBatch(now: Date, limit: number): Promise<number>;
}

// pgvector's text form of a vector.
const literal = (v: number[]) => `[${v.join(',')}]`;

export function createSemanticStore(db: Db['db']): SemanticStore {
  return {
    async upsert(r) {
      await db
        .insert(semanticCache)
        .values({ ...r, embedding: r.embedding })
        .onConflictDoUpdate({
          target: [semanticCache.scope, semanticCache.exactKey],
          set: { contextHash: r.contextHash, embedding: r.embedding, embedder: r.embedder, expiresAt: r.expiresAt, createdAt: sql`now()` },
        });
    },

    async nearest(q) {
      const distance = cosineDistance(semanticCache.embedding, q.embedding);
      // Scope, context and expiry are conditions of the query, so the index search only ever ranks rows that may
      // be served. An HNSW scan filters after it searches and could run dry before it finds a match, so the scan
      // is allowed to continue until it has one (pgvector 0.8 iterative scans), keeping the order exact.
      const rows = await db.transaction(async (tx) => {
        await tx.execute(sql`SET LOCAL hnsw.iterative_scan = strict_order`);
        await tx.execute(sql`SET LOCAL ivfflat.iterative_scan = relaxed_order`);
        return tx
          .select({ id: semanticCache.id, exactKey: semanticCache.exactKey, embedder: semanticCache.embedder, distance })
          .from(semanticCache)
          .where(
            and(
              eq(semanticCache.scope, q.scope),
              eq(semanticCache.contextHash, q.contextHash),
              gt(semanticCache.expiresAt, q.now),
              ...(q.embedder === undefined ? [] : [eq(semanticCache.embedder, q.embedder)]),
            ),
          )
          .orderBy(distance)
          .limit(1);
      });
      const row = rows[0];
      if (!row) return undefined;
      return { id: row.id, exactKey: row.exactKey, embedder: row.embedder, similarity: 1 - Number(row.distance) };
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
