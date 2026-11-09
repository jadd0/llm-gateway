import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import * as schema from './schema.ts';

export interface Db {
  pool: pg.Pool;
  db: ReturnType<typeof drizzle<typeof schema>>;
  close(): Promise<void>;
}

// One pool per process; `max` is the number to name when Postgres becomes the bottleneck.
export function createDb(opts: { databaseUrl: string; poolSize: number }): Db {
  const pool = new pg.Pool({ connectionString: opts.databaseUrl, max: opts.poolSize });
  // An idle client dropping (Postgres restart) must not crash the process; the next query reconnects.
  pool.on('error', () => {});
  return { pool, db: drizzle(pool, { schema }), close: () => pool.end() };
}
