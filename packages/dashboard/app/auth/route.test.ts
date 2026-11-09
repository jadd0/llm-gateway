import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { COOKIE_NAME, SESSION_MAX_AGE_S, sessionValid } from '../../lib/auth.ts';
import { POST } from './route.ts';

const env = { DASHBOARD_TOKEN: 'a'.repeat(40), DASHBOARD_SESSION_SECRET: 'b'.repeat(40), DASHBOARD_DATABASE_URL: 'postgres://u:p@localhost/db' };
const saved = { ...process.env };
beforeAll(() => Object.assign(process.env, env));
afterAll(() => {
  for (const k of Object.keys(env)) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

const post = (fields: Record<string, string>) => POST(new Request('http://localhost:3200/auth', { method: 'POST', body: new URLSearchParams(fields), headers: { 'content-type': 'application/x-www-form-urlencoded' } }));

describe('login', () => {
  it('wrong token refused, right token sets cookie', async () => {
    for (const token of ['', 'nope', 'a'.repeat(39), 'a'.repeat(41)]) {
      const r = await post({ token });
      expect(r.status).toBe(303);
      expect(new URL(r.headers.get('location')!).pathname + new URL(r.headers.get('location')!).search).toBe('/login?error=1');
      expect(r.headers.get('set-cookie')).toBeNull();
    }
    expect((await post({})).headers.get('set-cookie')).toBeNull();

    const ok = await post({ token: env.DASHBOARD_TOKEN });
    expect(ok.status).toBe(303);
    expect(new URL(ok.headers.get('location')!).pathname).toBe('/');
    const cookie = ok.headers.get('set-cookie')!;
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=strict/i);
    expect(cookie).toContain(`Max-Age=${SESSION_MAX_AGE_S}`);
    const value = new RegExp(`${COOKIE_NAME}=([^;]+)`).exec(cookie)![1]!;
    expect(sessionValid(value, { token: env.DASHBOARD_TOKEN, sessionSecret: env.DASHBOARD_SESSION_SECRET }, new Date())).toBe(true);
  });

  it('never puts the token in a redirect URL or in the cookie', async () => {
    for (const token of [env.DASHBOARD_TOKEN, 'wrong-' + 'x'.repeat(40)]) {
      const r = await post({ token });
      expect(r.headers.get('location')).not.toContain(token);
      expect(r.headers.get('set-cookie') ?? '').not.toContain(token);
    }
  });

  it('a request without a form body is refused with a redirect, not a server error', async () => {
    const bodies: Array<[string, BodyInit | null]> = [['application/json', '{"token":"x"}'], ['text/plain', 'token=x'], ['multipart/form-data; boundary=zz', 'garbage'], ['application/x-www-form-urlencoded', null]];
    for (const [type, body] of bodies) {
      const r = await POST(new Request('http://localhost:3200/auth', { method: 'POST', body, headers: { 'content-type': type } }));
      expect(r.status).toBe(303);
      expect(new URL(r.headers.get('location')!).pathname).toBe('/login');
      expect(r.headers.get('set-cookie')).toBeNull();
    }
    expect((await POST(new Request('http://localhost:3200/auth', { method: 'POST' }))).status).toBe(303);
  });

  it('logout clears the cookie', async () => {
    const r = await post({ action: 'logout' });
    expect(new URL(r.headers.get('location')!).pathname).toBe('/login');
    expect(r.headers.get('set-cookie')).toMatch(new RegExp(`${COOKIE_NAME}=;`));
  });
});
