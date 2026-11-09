export const dynamic = 'force-dynamic';

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const { error } = await searchParams;
  return (
    <main className="login">
      <form method="post" action="/auth" className="card login-card">
        <h1>LLM Gateway</h1>
        <p className="sub">Enter the admin token to view the dashboard.</p>
        <label htmlFor="token">Admin token</label>
        <input id="token" name="token" type="password" autoComplete="current-password" required autoFocus aria-describedby={error ? 'login-error' : undefined} aria-invalid={error ? true : undefined} />
        {error ? (
          <p id="login-error" role="alert" className="form-error">
            That token was not accepted.
          </p>
        ) : null}
        <button type="submit">Sign in</button>
      </form>
    </main>
  );
}
