import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import * as schema from './schema.ts';

export interface Db {
  pool: pg.Pool;
  db: ReturnType<typeof drizzle<typeof schema>>;
  close(): Promise<void>;
}

export interface DbOptions {
  databaseUrl: string;
  poolSize: number;
  /** Time allowed to open a connection; past it the query that wanted one fails. Absent: no limit. */
  connectTimeoutMs?: number;
  /** Postgres ends any statement of this pool that runs longer (a startup setting, so it covers every statement and costs no round trip). */
  statementTimeoutMs?: number;
  /** Connections kept open while idle, so a query rarely pays for opening one. */
  minIdle?: number;
}

// One pool per process; `max` is the number to name when Postgres becomes the bottleneck.
export function createDb(opts: DbOptions): Db {
  const pool = new pg.Pool({
    connectionString: opts.databaseUrl,
    max: opts.poolSize,
    ...(opts.connectTimeoutMs ? { connectionTimeoutMillis: opts.connectTimeoutMs } : {}),
    ...(opts.statementTimeoutMs ? { statement_timeout: opts.statementTimeoutMs } : {}),
    ...(opts.minIdle ? { min: Math.min(opts.minIdle, opts.poolSize), keepAlive: true } : {}),
  });
  // An idle client dropping (Postgres restart) must not crash the process; the next query reconnects.
  pool.on('error', () => {});
  return { pool, db: drizzle(pool, { schema }), close: () => pool.end() };
}
