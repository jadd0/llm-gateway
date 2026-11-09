import { NextResponse } from 'next/server';
import { COOKIE_NAME, SESSION_MAX_AGE_S, issueSession, tokenMatches } from '../../lib/auth.ts';
import { loadEnv } from '../../lib/env.ts';

// The login form posts here; the token travels in the body, never in a URL. A wrong token goes back to the form
// with a flag, nothing else. `action=logout` clears the cookie.
export async function POST(request: Request): Promise<NextResponse> {
  const form = await request.formData();
  const env = loadEnv();
  if (form.get('action') === 'logout') {
    const res = NextResponse.redirect(new URL('/login', request.url), 303);
    res.cookies.set(COOKIE_NAME, '', { httpOnly: true, sameSite: 'strict', secure: process.env.NODE_ENV === 'production', path: '/', maxAge: 0 });
    return res;
  }
  const given = form.get('token');
  if (typeof given !== 'string' || !tokenMatches(given, env)) {
    return NextResponse.redirect(new URL('/login?error=1', request.url), 303);
  }
  const res = NextResponse.redirect(new URL('/', request.url), 303);
  res.cookies.set(COOKIE_NAME, issueSession(env, new Date()), { httpOnly: true, sameSite: 'strict', secure: process.env.NODE_ENV === 'production', path: '/', maxAge: SESSION_MAX_AGE_S });
  return res;
}
