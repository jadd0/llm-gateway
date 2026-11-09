import { describe, expect, it } from 'vitest';
import { SESSION_MAX_AGE_S, issueSession, sessionValid, tokenMatches } from './auth.ts';
import { EnvError, loadEnv } from './env.ts';

const auth = { token: 't'.repeat(40), sessionSecret: 's'.repeat(40) };
const NOW = new Date('2032-06-15T12:00:00Z');
const at = (s: number) => new Date(NOW.getTime() + s * 1000);

describe('token', () => {
  it('matches only the exact token, whatever the length of the guess', () => {
    expect(tokenMatches(auth.token, auth)).toBe(true);
    for (const guess of ['', 't', auth.token + 'x', auth.token.slice(1), 'T'.repeat(40), 't'.repeat(39) + 'u', 'x'.repeat(5000)]) expect(tokenMatches(guess, auth)).toBe(false);
  });
});

describe('session cookie', () => {
  it('is valid for the token and secret it was issued with, until it expires', () => {
    const c = issueSession(auth, NOW);
    expect(sessionValid(c, auth, NOW)).toBe(true);
    expect(sessionValid(c, auth, at(SESSION_MAX_AGE_S))).toBe(true);
    expect(sessionValid(c, auth, at(SESSION_MAX_AGE_S + 1))).toBe(false);
    // Issued in the future (a clock that moved back, or a forged time) is not accepted either.
    expect(sessionValid(c, auth, at(-1))).toBe(false);
  });

  it('is refused when tampered with, truncated, empty, or issued for another token or secret', () => {
    const c = issueSession(auth, NOW);
    const [issued, mac] = c.split('.') as [string, string];
    const bad = [
      undefined, '', 'x', `${issued}`, `${issued}.`, `${issued}.${mac.slice(1)}`, `${issued}.${mac}0`,
      `${Number(issued) + 1000}.${mac}`, `${issued}.${mac.replace(/.$/, mac.endsWith('0') ? '1' : '0')}`, `${issued}.${'0'.repeat(64)}`,
      `${issued}.${mac.toUpperCase()}`, `-${issued}.${mac}`,
    ];
    for (const b of bad) expect(sessionValid(b, auth, NOW)).toBe(false);
    expect(sessionValid(c, { ...auth, token: 'u'.repeat(40) }, NOW)).toBe(false);
    expect(sessionValid(c, { ...auth, sessionSecret: 'v'.repeat(40) }, NOW)).toBe(false);
  });

  it('does not contain the token', () => {
    expect(issueSession(auth, NOW)).not.toContain(auth.token);
  });
});

describe('environment', () => {
  const ok = { DASHBOARD_TOKEN: auth.token, DASHBOARD_SESSION_SECRET: auth.sessionSecret, DASHBOARD_DATABASE_URL: 'postgres://u:p@h/db' };
  it('refuses a missing or short token, a missing secret or database, and a secret equal to the token', () => {
    expect(loadEnv(ok).token).toBe(auth.token);
    for (const over of [{ DASHBOARD_TOKEN: undefined }, { DASHBOARD_TOKEN: 'x'.repeat(31) }, { DASHBOARD_SESSION_SECRET: undefined }, { DASHBOARD_SESSION_SECRET: 'x'.repeat(31) }, { DASHBOARD_DATABASE_URL: undefined }, { DASHBOARD_SESSION_SECRET: auth.token }]) {
      expect(() => loadEnv({ ...ok, ...over })).toThrow(EnvError);
    }
  });
  it('sizes the pool at 10 unless told otherwise, and refuses a pool too small for a page load', () => {
    expect(loadEnv(ok).poolMax).toBe(10);
    expect(loadEnv({ ...ok, DASHBOARD_DB_POOL_MAX: '25' }).poolMax).toBe(25);
    for (const bad of ['2', '0', '-1', 'ten', '3.5']) expect(() => loadEnv({ ...ok, DASHBOARD_DB_POOL_MAX: bad })).toThrow(/DASHBOARD_DB_POOL_MAX/);
  });
  it('names the variable and never prints its value', () => {
    expect(() => loadEnv({ ...ok, DASHBOARD_TOKEN: 'short-secret-value' })).toThrow(/DASHBOARD_TOKEN must be at least 32/);
    try {
      loadEnv({ ...ok, DASHBOARD_TOKEN: 'short-secret-value' });
    } catch (e) {
      expect((e as Error).message).not.toContain('short-secret-value');
    }
  });
});
