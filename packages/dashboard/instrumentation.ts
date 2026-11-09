// Runs once when the server starts. A dashboard without a token, or with a short one, does not come up at all.
export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  const { loadEnv } = await import('./lib/env.ts');
  loadEnv();
}
