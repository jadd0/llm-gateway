import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { COOKIE_NAME, sessionValid } from './auth.ts';
import { loadEnv } from './env.ts';

/** The page's own check, in addition to the proxy's: no valid cookie, no data. */
export async function requireSession(): Promise<void> {
  const jar = await cookies();
  if (!sessionValid(jar.get(COOKIE_NAME)?.value, loadEnv(), new Date())) redirect('/login');
}
