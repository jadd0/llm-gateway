import type { ReactNode } from 'react';

export interface DataTable {
  head: string[];
  rows: string[][];
}

// A chart with a title, a one-line reading of what it shows, and the numbers behind it as a table for screen
// readers and anyone who wants the exact values.
export function ChartCard({ id, title, hint, table, children }: { id: string; title: string; hint: string; table: DataTable; children: ReactNode }) {
  return (
    <figure className="card chart" aria-labelledby={`${id}-title`} aria-label={title} data-chart={id}>
      <figcaption>
        <h2 id={`${id}-title`}>{title}</h2>
        <p>{hint}</p>
      </figcaption>
      <div className="chart-body">{children}</div>
      <details className="data">
        <summary>Data table</summary>
        <div className="scroll">
          <table>
            <thead>
              <tr>
                {table.head.map((h, i) => (
                  <th key={h} scope="col" className={i === 0 ? undefined : 'num'}>
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {table.rows.map((r, i) => (
                <tr key={i}>
                  {r.map((c, j) => (
                    <td key={j} className={j === 0 ? undefined : 'num'}>
                      {c}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </figure>
  );
}
