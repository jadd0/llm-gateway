import { createDb, type Db } from '../db/client.ts';

/** A connection that takes longer than this to open fails its query. Not the query budget: opening one is not the query. */
export const CONNECT_TIMEOUT_MS = 2000;

export interface SemanticPoolsOptions {
  databaseUrl: string;
  /** Connections for lookups. */
  lookupPool: number;
  /** Connections for fills, removals and the sweep. */
  writePool: number;
  /** Postgres ends a lookup that runs longer than this. */
  lookupTimeoutMs: number;
}

export interface SemanticPools {
  /** Lookups only: a statement timeout of the lookup budget, and idle connections kept warm. */
  lookup: Db;
  /** Fills, removals and the sweep: a burst of them queues here and cannot take a connection a lookup needs. */
  write: Db;
  /** Opens the lookup pool's warm connections so the first lookups do not pay for them. Never throws. */
  warm(): Promise<void>;
  close(): Promise<void>;
}

export function createSemanticPools(opts: SemanticPoolsOptions): SemanticPools {
  const minIdle = Math.min(2, opts.lookupPool);
  const lookup = createDb({ databaseUrl: opts.databaseUrl, poolSize: opts.lookupPool, connectTimeoutMs: CONNECT_TIMEOUT_MS, statementTimeoutMs: opts.lookupTimeoutMs, minIdle });
  const write = createDb({ databaseUrl: opts.databaseUrl, poolSize: opts.writePool, connectTimeoutMs: CONNECT_TIMEOUT_MS });
  return {
    lookup,
    write,
    async warm() {
      await Promise.allSettled(Array.from({ length: minIdle }, () => lookup.pool.connect())).then((all) => {
        for (const r of all) if (r.status === 'fulfilled') r.value.release();
      });
    },
    async close() {
      await Promise.all([lookup.close(), write.close()]);
    },
  };
}
