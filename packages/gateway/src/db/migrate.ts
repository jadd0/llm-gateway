import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { fileURLToPath } from 'node:url';
import { loadDbConfig } from '../config.ts';
import { isMissingPgvector, PGVECTOR_HELP } from '../semantic/store.ts';
import { createDb } from './client.ts';
import { provisionReader } from './reader.ts';

// Applies the checked-in SQL migrations. Run by `npm run db:migrate`.
const config = loadDbConfig();
const handle = createDb({ databaseUrl: config.databaseUrl, poolSize: 1 });
try {
  await migrate(handle.db, { migrationsFolder: fileURLToPath(new URL('../../drizzle', import.meta.url)) });
  console.log('migrations applied');
  // Only where a dashboard is configured: the gate and the gateway need no dashboard login.
  const dashboardUrl = process.env.DASHBOARD_DATABASE_URL;
  if (dashboardUrl) {
    const client = await handle.pool.connect();
    try {
      console.log(`dashboard login ready: ${await provisionReader(client, dashboardUrl)}`);
    } finally {
      client.release();
    }
  }
} catch (err) {
  // Migration 0007 runs CREATE EXTENSION vector: on a Postgres without pgvector it fails with a message that
  // names a missing control file, which does not say what to do.
  if (isMissingPgvector(err)) {
    console.error(`migration failed: Postgres does not have the pgvector extension. ${PGVECTOR_HELP}`);
    process.exitCode = 1;
  } else {
    throw err;
  }
} finally {
  await handle.close();
}
