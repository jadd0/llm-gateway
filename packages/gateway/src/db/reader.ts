import pg from 'pg';

/**
 * Makes the login the dashboard connects with: a role named in DASHBOARD_DATABASE_URL, a member of the read-only
 * `dashboard_reader` role (which the migration created) and nothing else. Created, or its password reset, so
 * running it again is harmless. The password is passed to Postgres as a quoted literal and is never printed.
 *
 * A name that does not exist is created. A name that does is changed only if it is already a pure dashboard login: not
 * the user running the migration, none of SUPERUSER, CREATEROLE, CREATEDB, REPLICATION or BYPASSRLS, a member of no role but
 * `dashboard_reader`, and no grants and no owned objects (any pg_shdepend row). Anything else is refused and left exactly as
 * it was, because resetting its password would lock out whatever else uses it. Returns the role name.
 */
export async function provisionReader(client: Pick<pg.Client, 'query' | 'escapeLiteral' | 'escapeIdentifier'>, dashboardUrl: string): Promise<string> {
  const u = new URL(dashboardUrl);
  const name = decodeURIComponent(u.username);
  const password = decodeURIComponent(u.password);
  if (name === '' || password === '') throw new Error('DASHBOARD_DATABASE_URL needs a user and a password');
  const ident = client.escapeIdentifier(name);
  const literal = client.escapeLiteral(password);
  const existing = await client.query<{ oid: number; me: boolean; privileged: boolean; other_memberships: number; dependencies: number }>(
    `SELECT r.oid, r.rolname = current_user AS me,
            (r.rolsuper OR r.rolcreaterole OR r.rolcreatedb OR r.rolreplication OR r.rolbypassrls) AS privileged,
            (SELECT count(*)::int FROM pg_auth_members m WHERE m.member = r.oid AND m.roleid <> 'dashboard_reader'::regrole) AS other_memberships,
            (SELECT count(*)::int FROM pg_shdepend d WHERE d.refclassid = 'pg_authid'::regclass AND d.refobjid = r.oid) AS dependencies
     FROM pg_roles r WHERE r.rolname = $1`,
    [name],
  );
  const role = existing.rows[0];
  if (!role) {
    await client.query(`CREATE ROLE ${ident} LOGIN PASSWORD ${literal} IN ROLE dashboard_reader`);
  } else {
    const why = role.me ? 'it is the user running this migration'
      : role.privileged ? 'it has a role attribute (superuser, createrole, createdb, replication or bypassrls)'
      : role.other_memberships > 0 ? 'it is a member of other roles'
      : role.dependencies > 0 ? 'it owns objects or holds grants'
      : null;
    if (why !== null) throw new Error(`refusing to use "${name}" as the dashboard login: ${why}`);
    await client.query(`ALTER ROLE ${ident} LOGIN PASSWORD ${literal}`);
    await client.query(`GRANT dashboard_reader TO ${ident}`);
  }
  return name;
}
