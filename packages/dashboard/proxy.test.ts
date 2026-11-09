import { NextRequest } from 'next/server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { COOKIE_NAME, SESSION_MAX_AGE_S, issueSession } from './lib/auth.ts';
import { proxy } from './proxy.ts';

const env = { DASHBOARD_TOKEN: 'a'.repeat(40), DASHBOARD_SESSION_SECRET: 'b'.repeat(40), DASHBOARD_DATABASE_URL: 'postgres://u:p@localhost/db' };
const saved = { ...process.env };
beforeAll(() => Object.assign(process.env, env));
afterAll(() => {
  for (const k of Object.keys(env)) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

const req = (path: string, cookie?: string) => new NextRequest(`http://localhost:3200${path}`, cookie ? { headers: { cookie: `${COOKIE_NAME}=${cookie}` } } : {});
const auth = { token: env.DASHBOARD_TOKEN, sessionSecret: env.DASHBOARD_SESSION_SECRET };
const isRedirectToLogin = (r: Response) => r.status === 307 && new URL(r.headers.get('location')!).pathname === '/login';

describe('proxy', () => {
  it('unauthenticated request redirects to /login', () => {
    for (const path of ['/', '/?range=7d', '/anything/else']) expect(isRedirectToLogin(proxy(req(path)))).toBe(true);
  });

  it('a wrong, forged, tampered or expired cookie redirects to /login', () => {
    const good = issueSession(auth, new Date());
    const old = issueSession(auth, new Date(Date.now() - (SESSION_MAX_AGE_S + 60) * 1000));
    const otherToken = issueSession({ ...auth, token: 'c'.repeat(40) }, new Date());
    for (const c of ['garbage', good.slice(0, -1), good.replace(/\./, '1.'), old, otherToken, '']) expect(isRedirectToLogin(proxy(req('/', c)))).toBe(true);
  });

  it('a valid cookie passes, and the login page and form are reachable without one', () => {
    expect(proxy(req('/', issueSession(auth, new Date()))).headers.get('x-middleware-next')).toBe('1');
    for (const path of ['/login', '/auth']) expect(proxy(req(path)).headers.get('x-middleware-next')).toBe('1');
  });
});
