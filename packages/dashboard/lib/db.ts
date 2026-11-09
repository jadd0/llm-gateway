import pg from 'pg';
import { loadEnv } from './env.ts';

// One small pool for the process, as the read-only role. The session is also set read-only and given a statement
// timeout, so even a query bug could neither write nor hold a connection for long.
const g = globalThis as unknown as { __dashboardPool?: pg.Pool };

export function pool(): pg.Pool {
  if (!g.__dashboardPool) {
    const p = new pg.Pool({
      connectionString: loadEnv().databaseUrl,
      max: 4,
      statement_timeout: 15_000,
      options: '-c default_transaction_read_only=on',
    });
    // An idle connection dropping (Postgres restart) must not crash the server; the next query reconnects. Logged by
    // class and code only: the message can carry the connection string.
    p.on('error', (err: Error & { code?: string }) => console.error(JSON.stringify({ level: 'error', msg: 'dashboard pool error', errClass: err.name, code: err.code })));
    g.__dashboardPool = p;
  }
  return g.__dashboardPool;
}
