import { fmtInt, fmtMs, fmtPct, fmtTick, fmtUsd } from '../lib/format.ts';
import { RANGES, type ErrorRow, type Overview } from '../lib/queries.ts';
import { ChartCard } from './ChartCard.tsx';
import { spendBars } from '../lib/spend.ts';
import { CacheRateChart, ErrorRateChart, LatencyChart, SpendChart } from './charts.tsx';
import { ErrorsTable } from './ErrorsTable.tsx';
import { RangePicker } from './RangePicker.tsx';
import { Tile } from './Tile.tsx';

// The whole overview from plain data: the page loads it, this lays it out. Nothing here touches the database.
// The charts are drawn by the browser (Recharts measures its box), so server-rendered markup holds their frames and data tables.
export function OverviewView({ data, errors }: { data: Overview; errors: ErrorRow[] }) {
  const { totals: t, series, range, stepMs } = data;
  const axes = { from: data.from.getTime(), to: data.to.getTime(), stepMs };
  const empty = t.requests === 0;
  const bars = spendBars(data.byTenant);
  const tick = (p: { t: number }) => fmtTick(p.t, stepMs);

  return (
    <main className="page">
      <header className="top">
        <div>
          <h1>LLM Gateway</h1>
          <p className="sub">
            {RANGES[range].label}, from pre-aggregated rollups. Latency percentiles are accurate to the nearest 5%.
          </p>
        </div>
        <div className="top-actions">
          <RangePicker current={range} />
          <form method="post" action="/auth">
            <input type="hidden" name="action" value="logout" />
            <button type="submit" className="link">Sign out</button>
          </form>
        </div>
      </header>

      <dl className="tiles" aria-label="Totals for the range">
        <Tile label="Requests" value={fmtInt(t.requests)} />
        <Tile label="Error rate" value={fmtPct(t.errorRate)} note={`${fmtInt(t.errors)} failed`} />
        <Tile label="Cache hit rate" value={fmtPct(t.cacheHitRate)} note="exact and semantic" />
        <Tile label="Latency p50" value={fmtMs(t.p50)} />
        <Tile label="Latency p95" value={fmtMs(t.p95)} />
        <Tile label="Spend" value={fmtUsd(t.costMicros)} note={`${fmtUsd(t.savedMicros)} saved by cache`} />
      </dl>

      {empty ? (
        <section className="card empty-state" aria-live="polite" data-section="empty">
          <h2>No requests in this range</h2>
          <p>
            Rollups are written by the log worker as it stores each batch of request logs. Check that the worker is running and the
            gateway is receiving traffic, or pick a longer range.
          </p>
        </section>
      ) : (
        <div className="charts">
          <ChartCard id="latency" title="Latency over time" hint="p50 (dashed) and p95 (solid), from merged histograms."
            table={{ head: ['Time (UTC)', 'p50', 'p95', 'Requests'], rows: series.map((p) => [tick(p), fmtMs(p.p50), fmtMs(p.p95), fmtInt(p.requests)]) }}>
            <LatencyChart points={series} {...axes} />
          </ChartCard>
          <ChartCard id="spend" title="Spend by tenant" hint="Cost of the requests in the range, per tenant."
            table={{ head: ['Tenant', 'Requests', 'Spend'], rows: data.byTenant.map((b) => [b.name ?? 'Unauthenticated', fmtInt(b.requests), fmtUsd(b.costMicros)]) }}>
            <SpendChart bars={bars} />
          </ChartCard>
          <ChartCard id="cache" title="Cache hit rate over time" hint="Responses served from the exact or semantic cache, as a share of requests."
            table={{ head: ['Time (UTC)', 'Hit rate', 'Requests'], rows: series.map((p) => [tick(p), fmtPct(p.cacheHitRate), fmtInt(p.requests)]) }}>
            <CacheRateChart points={series} {...axes} />
          </ChartCard>
          <ChartCard id="errors" title="Error rate over time" hint="Server errors (5xx) and streams that broke after starting, as a share of requests."
            table={{ head: ['Time (UTC)', 'Error rate', 'Failed', 'Requests'], rows: series.map((p) => [tick(p), fmtPct(p.errorRate), fmtInt(p.errors), fmtInt(p.requests)]) }}>
            <ErrorRateChart points={series} {...axes} />
          </ChartCard>
        </div>
      )}

      <ErrorsTable rows={errors} />
    </main>
  );
}
