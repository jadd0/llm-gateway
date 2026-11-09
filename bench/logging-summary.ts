// Turns the k6 summaries and worker samples of bench/run-logging.sh into summary.md. Every figure is read from the
// files in the results directory; the only arithmetic is the median and range over repeats, and rows per second
// (rows written divided by the seconds the samples span).
//   node bench/logging-summary.ts <results-dir>
//   reads <dir>/logging-{inline,stream}-<n>.json (k6) and <dir>/worker-stream-<n>.csv (t_ms,lag,pending,rows), writes <dir>/summary.md
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

interface K6Metrics {
  metrics: Record<string, Record<string, number>>;
}

export const MODES = ['inline', 'stream'] as const;
export type Mode = (typeof MODES)[number];

export interface RunFigures {
  requests: number;
  failed: number;
  p50: number;
  p95: number;
  p99: number;
}

function need(k6: K6Metrics, name: string, field: string): number {
  const v = k6.metrics[name]?.[field];
  if (v === undefined) throw new Error(`k6 summary has no ${name} ${field}`);
  return v;
}

export function figures(k6: K6Metrics): RunFigures {
  const d = 'http_req_duration{phase:measure}';
  return {
    requests: need(k6, 'http_reqs{phase:measure}', 'count'),
    // http_req_failed is a rate: its `passes` is the number of failed requests.
    failed: k6.metrics['http_req_failed{phase:measure}']?.passes ?? 0,
    p50: need(k6, d, 'med'),
    p95: need(k6, d, 'p(95)'),
    p99: need(k6, d, 'p(99)'),
  };
}

export function median(xs: number[]): number {
  if (xs.length === 0) throw new Error('median of nothing');
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

export interface Spread {
  median: number;
  min: number;
  max: number;
}
export const spread = (xs: number[]): Spread => ({ median: median(xs), min: Math.min(...xs), max: Math.max(...xs) });

export interface WorkerSample {
  tMs: number;
  lag: number;
  pending: number;
  rows: number;
}

export function parseSamples(csv: string): WorkerSample[] {
  return csv
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '' && !l.startsWith('t_ms'))
    .map((l) => {
      const [t, lag, pending, rows] = l.split(',').map(Number);
      if ([t, lag, pending, rows].some((v) => v === undefined || !Number.isFinite(v))) throw new Error(`bad worker sample: ${l}`);
      return { tMs: t!, lag: lag!, pending: pending!, rows: rows! };
    });
}

export interface WorkerFigures {
  maxLag: number;
  maxPending: number;
  rowsPerS: number;
  rows: number;
}

export function workerFigures(samples: WorkerSample[]): WorkerFigures {
  if (samples.length < 2) throw new Error('worker samples need at least two lines');
  const first = samples[0]!;
  const last = samples[samples.length - 1]!;
  const seconds = (last.tMs - first.tMs) / 1000;
  return {
    maxLag: Math.max(...samples.map((s) => s.lag)),
    maxPending: Math.max(...samples.map((s) => s.pending)),
    rows: last.rows - first.rows,
    rowsPerS: seconds === 0 ? 0 : (last.rows - first.rows) / seconds,
  };
}

const ms = (s: Spread) => `${s.median.toFixed(1)} ms (${s.min.toFixed(1)} to ${s.max.toFixed(1)})`;

export function render(runs: Record<Mode, RunFigures[]>, workers: WorkerFigures[]): string {
  for (const m of MODES) if (runs[m].length === 0) throw new Error(`no k6 summary for ${m}`);
  const rows = MODES.map((m) => {
    const rs = runs[m];
    return `| ${m} | ${rs.length} | ${rs.reduce((a, r) => a + r.requests, 0)} | ${rs.reduce((a, r) => a + r.failed, 0)} | ${ms(spread(rs.map((r) => r.p50)))} | ${ms(spread(rs.map((r) => r.p95)))} | ${ms(spread(rs.map((r) => r.p99)))} |`;
  });
  const lines = [
    '# Request logging off the request path',
    '',
    'Source: `logging-inline-<n>.json` and `logging-stream-<n>.json` (k6 summary exports of `bench/k6/logging.js`, started by `bench/run-logging.sh`) and `worker-stream-<n>.csv` (one sample a second).',
    'Conditions: `conditions.txt` in this folder. Same constant arrival rate for both modes; the cells are the median over the repeats with the range in brackets.',
    '',
    '| mode | repeats | requests | failed | p50 | p95 | p99 |',
    '|---|---:|---:|---:|---|---|---|',
    ...rows,
    '',
  ];
  if (workers.length > 0) {
    const lag = spread(workers.map((w) => w.maxLag));
    const rate = spread(workers.map((w) => w.rowsPerS));
    lines.push(
      'Worker, stream mode:',
      '',
      '| repeats | max lag (entries) | max pending | rows per second |',
      '|---:|---|---:|---|',
      `| ${workers.length} | ${lag.median} (${lag.min} to ${lag.max}) | ${Math.max(...workers.map((w) => w.maxPending))} | ${rate.median.toFixed(1)} (${rate.min.toFixed(1)} to ${rate.max.toFixed(1)}) |`,
      '',
    );
  }
  return lines.join('\n');
}

if (import.meta.main) {
  const dir = process.argv[2];
  if (!dir) throw new Error('usage: node bench/logging-summary.ts <results-dir>');
  const files = readdirSync(dir);
  const runs = { inline: [], stream: [] } as Record<Mode, RunFigures[]>;
  for (const m of MODES) {
    for (const f of files.filter((x) => new RegExp(`^logging-${m}-\\d+\\.json$`).test(x)).sort()) {
      runs[m].push(figures(JSON.parse(readFileSync(join(dir, f), 'utf8')) as K6Metrics));
    }
  }
  const workers = files
    .filter((x) => /^worker-stream-\d+\.csv$/.test(x))
    .sort()
    .map((f) => workerFigures(parseSamples(readFileSync(join(dir, f), 'utf8'))));
  writeFileSync(join(dir, 'summary.md'), render(runs, workers));
  console.log(`wrote ${join(dir, 'summary.md')}`);
}
