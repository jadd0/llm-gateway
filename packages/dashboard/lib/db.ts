import pg from 'pg';
import { loadEnv } from './env.ts';

// One small pool for the process, as the read-only role. The session is also set read-only and given a statement
// timeout, so even a query bug could neither write nor hold a connection for long.
const g = globalThis as unknown as { __dashboardPool?: pg.Pool };

export function pool(): pg.Pool {
  g.__dashboardPool ??= new pg.Pool({
    connectionString: loadEnv().databaseUrl,
    max: 4,
    statement_timeout: 15_000,
    options: '-c default_transaction_read_only=on',
  });
  g.__dashboardPool.on('error', () => {});
  return g.__dashboardPool;
}
