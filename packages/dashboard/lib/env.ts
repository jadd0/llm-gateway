// The dashboard's own environment. It never reads the gateway's variables (no pepper, no provider keys).

export interface DashboardEnv {
  /** The admin token the login form is checked against. */
  token: string;
  /** Server-side secret the session cookie is signed with. */
  sessionSecret: string;
  /** A connection as the read-only role (see `npm run db:migrate`). */
  databaseUrl: string;
}

export class EnvError extends Error {}

const MIN_SECRET = 32;

/** Throws an EnvError naming the variable (never its value) when anything is missing or too short. */
export function loadEnv(env: Record<string, string | undefined> = process.env): DashboardEnv {
  const need = (name: string, min = 1): string => {
    const v = env[name];
    if (v === undefined || v.length < min) {
      throw new EnvError(min > 1 ? `${name} must be at least ${min} characters` : `${name} is required`);
    }
    return v;
  };
  const token = need('DASHBOARD_TOKEN', MIN_SECRET);
  const sessionSecret = need('DASHBOARD_SESSION_SECRET', MIN_SECRET);
  if (sessionSecret === token) throw new EnvError('DASHBOARD_SESSION_SECRET must differ from DASHBOARD_TOKEN');
  return { token, sessionSecret, databaseUrl: need('DASHBOARD_DATABASE_URL') };
}
