import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import type { DashboardEnv } from './env.ts';

// One admin token, no accounts. A correct token gets a cookie holding an HMAC (keyed with a server-side secret)
// over the time it was issued and the token, so the cookie proves the token was known without containing it,
// needs no session store, can be refused when old, and stops working when the token or the secret changes.

export const COOKIE_NAME = 'gw_dashboard';
export const SESSION_MAX_AGE_S = 12 * 60 * 60;

type Auth = Pick<DashboardEnv, 'token' | 'sessionSecret'>;

const sign = (a: Auth, issuedMs: number): string => createHmac('sha256', a.sessionSecret).update(`v1:${issuedMs}:${a.token}`).digest('hex');

function sameBytes(a: string, b: string): boolean {
  // Digests of equal length, so timingSafeEqual cannot throw and the comparison does not depend on where they differ.
  const x = createHash('sha256').update(a).digest();
  const y = createHash('sha256').update(b).digest();
  return timingSafeEqual(x, y);
}

/** Constant-time comparison of the submitted token with the real one. */
export const tokenMatches = (given: string, a: Auth): boolean => sameBytes(given, a.token);

/** The cookie value for a login at `now`. */
export function issueSession(a: Auth, now: Date): string {
  const issued = now.getTime();
  return `${issued}.${sign(a, issued)}`;
}

/** True only for a cookie this server issued for the current token and secret, no older than SESSION_MAX_AGE_S. */
export function sessionValid(value: string | undefined, a: Auth, now: Date): boolean {
  if (!value) return false;
  const m = /^(\d{1,15})\.([0-9a-f]{64})$/.exec(value);
  if (!m) return false;
  const issued = Number(m[1]);
  const age = now.getTime() - issued;
  if (age < 0 || age > SESSION_MAX_AGE_S * 1000) return false;
  return sameBytes(m[2]!, sign(a, issued));
}
