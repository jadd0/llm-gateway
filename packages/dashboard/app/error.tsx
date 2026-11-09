'use client';

export default function ErrorPage({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <main className="page">
      <section className="card empty-state" role="alert">
        <h2>The dashboard could not load its data</h2>
        <p>The database may be unreachable or the read-only login may be wrong. Nothing was changed.</p>
        <button type="button" onClick={reset}>Try again</button>
      </section>
    </main>
  );
}
