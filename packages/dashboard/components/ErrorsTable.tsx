import { fmtMs, fmtStamp } from '../lib/format.ts';
import type { ErrorRow } from '../lib/queries.ts';

export function ErrorsTable({ rows }: { rows: ErrorRow[] }) {
  return (
    <section className="card" aria-labelledby="errors-title" data-section="errors">
      <header className="card-head">
        <h2 id="errors-title">Last {rows.length === 0 ? '' : `${rows.length} `}failed requests</h2>
        <p>Newest first, whatever the time range. Metadata only: no prompts, no responses, no keys.</p>
      </header>
      {rows.length === 0 ? (
        <p className="empty">No failed requests on record.</p>
      ) : (
        <div className="scroll" tabIndex={0} role="region" aria-label="Failed requests table">
          <table>
            <thead>
              <tr>
                <th scope="col">Time (UTC)</th>
                <th scope="col">Tenant</th>
                <th scope="col">Model</th>
                <th scope="col" className="num">Status</th>
                <th scope="col">Error</th>
                <th scope="col" className="num">Latency</th>
                <th scope="col">Request id</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.requestId}>
                  <td className="nowrap">{fmtStamp(r.at)}</td>
                  <td>{r.tenant ?? 'Unauthenticated'}</td>
                  <td>{r.model ?? '—'}</td>
                  <td className="num">{r.status}</td>
                  <td>{r.errorCode ?? '—'}</td>
                  <td className="num nowrap">{fmtMs(r.latencyMs)}</td>
                  <td className="mono">{r.requestId}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
