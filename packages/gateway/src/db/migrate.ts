import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { fileURLToPath } from 'node:url';
import { loadDbConfig } from '../config.ts';
import { createDb } from './client.ts';

// Applies the checked-in SQL migrations. Run by `npm run db:migrate`.
const config = loadDbConfig();
const handle = createDb({ databaseUrl: config.databaseUrl, poolSize: 1 });
try {
  await migrate(handle.db, { migrationsFolder: fileURLToPath(new URL('../../drizzle', import.meta.url)) });
  console.log('migrations applied');
} finally {
  await handle.close();
}
