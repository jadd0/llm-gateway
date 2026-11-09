import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { fileURLToPath } from 'node:url';
import { loadDbConfig } from '../config.ts';
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
} finally {
  await handle.close();
}
