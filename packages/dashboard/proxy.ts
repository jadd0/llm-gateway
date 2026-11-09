import { NextResponse, type NextRequest } from 'next/server';
import { COOKIE_NAME, sessionValid } from './lib/auth.ts';
import { loadEnv } from './lib/env.ts';

// Every request but the login page and the form it posts to needs the session cookie. Runs before any page renders,
// and the page checks the cookie again itself: this is not the only guard.
export function proxy(request: NextRequest): NextResponse {
  const { pathname } = request.nextUrl;
  if (pathname === '/login' || pathname === '/auth') return NextResponse.next();
  if (sessionValid(request.cookies.get(COOKIE_NAME)?.value, loadEnv(), new Date())) return NextResponse.next();
  return NextResponse.redirect(new URL('/login', request.url));
}

export const config = { matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'] };
