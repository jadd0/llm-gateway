import pg from 'pg';

/**
 * Makes the login the dashboard connects with: a role named in DASHBOARD_DATABASE_URL, a member of the read-only
 * `dashboard_reader` role (which the migration created) and nothing else. Created, or its password reset, so
 * running it again is harmless. The password is passed to Postgres as a quoted literal and is never printed.
 * Returns the role name.
 */
export async function provisionReader(client: Pick<pg.Client, 'query' | 'escapeLiteral' | 'escapeIdentifier'>, dashboardUrl: string): Promise<string> {
  const u = new URL(dashboardUrl);
  const name = decodeURIComponent(u.username);
  const password = decodeURIComponent(u.password);
  if (name === '' || password === '') throw new Error('DASHBOARD_DATABASE_URL needs a user and a password');
  const ident = client.escapeIdentifier(name);
  const literal = client.escapeLiteral(password);
  const exists = await client.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [name]);
  if (exists.rowCount === 0) {
    await client.query(`CREATE ROLE ${ident} LOGIN PASSWORD ${literal} IN ROLE dashboard_reader`);
  } else {
    await client.query(`ALTER ROLE ${ident} LOGIN PASSWORD ${literal}`);
    await client.query(`GRANT dashboard_reader TO ${ident}`);
  }
  return name;
}
