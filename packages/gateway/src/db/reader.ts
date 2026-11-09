import pg from 'pg';

/**
 * Makes the login the dashboard connects with: a role named in DASHBOARD_DATABASE_URL, a member of the read-only
 * `dashboard_reader` role (which the migration created) and nothing else. Created, or its password reset, so
 * running it again is harmless. The password is passed to Postgres as a quoted literal and is never printed.
 *
 * It refuses, and changes nothing, when the name is a role that must not be turned into the dashboard's login: a
 * superuser, the user running the migration, or one that owns any object (resetting its password or taking over
 * its name would lock out whatever else uses it). Returns the role name.
 */
export async function provisionReader(client: Pick<pg.Client, 'query' | 'escapeLiteral' | 'escapeIdentifier'>, dashboardUrl: string): Promise<string> {
  const u = new URL(dashboardUrl);
  const name = decodeURIComponent(u.username);
  const password = decodeURIComponent(u.password);
  if (name === '' || password === '') throw new Error('DASHBOARD_DATABASE_URL needs a user and a password');
  const ident = client.escapeIdentifier(name);
  const literal = client.escapeLiteral(password);
  const existing = await client.query<{ oid: number; super: boolean; me: boolean }>(
    'SELECT oid, rolsuper AS super, rolname = current_user AS me FROM pg_roles WHERE rolname = $1',
    [name],
  );
  const role = existing.rows[0];
  if (role) {
    if (role.super) throw new Error(`refusing to use "${name}" as the dashboard login: it is a superuser`);
    if (role.me) throw new Error(`refusing to use "${name}" as the dashboard login: it is the user running this migration`);
    // 'o' in pg_shdepend is "owner": any table, function, schema or database the role owns.
    const owns = await client.query("SELECT 1 FROM pg_shdepend WHERE refclassid = 'pg_authid'::regclass AND refobjid = $1 AND deptype = 'o' LIMIT 1", [role.oid]);
    if ((owns.rowCount ?? 0) > 0) throw new Error(`refusing to use "${name}" as the dashboard login: it owns objects`);
  }
  if (!role) {
    await client.query(`CREATE ROLE ${ident} LOGIN PASSWORD ${literal} IN ROLE dashboard_reader`);
  } else {
    await client.query(`ALTER ROLE ${ident} LOGIN PASSWORD ${literal}`);
    await client.query(`GRANT dashboard_reader TO ${ident}`);
  }
  return name;
}
