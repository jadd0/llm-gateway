// Turns the k6 summaries of bench/run-cache.sh into summary.md. Every figure in it is read from the k6 JSON;
// nothing is computed from anything else except hit rate (hits over requests) and shares of the same counts.
//   node bench/cache-summary.ts <results-dir>
//   reads <dir>/cache-{cold,warm,warm-stream,stampede}.json, writes <dir>/summary.md
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

interface K6Metrics {
  metrics: Record<string, Record<string, number>>;
}

export const RUNS = [
  { name: 'cold', title: 'Cold: every prompt new' },
  { name: 'warm', title: 'Warm: Zipf draw from a fixed prompt set' },
  { name: 'warm-stream', title: 'Warm, streamed' },
  { name: 'stampede', title: 'Stampede: identical requests at once' },
] as const;

export interface Row {
  requests: number;
  hits: number;
  misses: number;
  /** Requests the gateway neither served from the cache nor missed on (bypass, uncacheable, unavailable). */
  other: number;
  /** hits / requests, 0 to 1. */
  hitRate: number;
  failed: number;
  /** Upstream calls the gateway made: the sum of x-gateway-attempts over every response. */
  upstreamCalls: number;
  hitP50Ms: number | null;
  hitP95Ms: number | null;
  missP50Ms: number | null;
  missP95Ms: number | null;
}

function need(k6: K6Metrics, name: string, field: string): number {
  const v = k6.metrics[name]?.[field];
  if (v === undefined) throw new Error(`k6 summary has no ${name} ${field}`);
  return v;
}

// A status that never occurred has no sub-metric at all: that is zero requests, not a missing figure.
const count = (k6: K6Metrics, status: string) => k6.metrics[`cache_requests{status:${status}}`]?.count ?? 0;
// k6 exports a zeroed trend for a tagged metric that has a threshold but no samples, so no samples is judged by the count.
const latency = (k6: K6Metrics, status: string, field: string) =>
  count(k6, status) === 0 ? null : (k6.metrics[`cache_ms{status:${status}}`]?.[field] ?? null);

export function row(k6: K6Metrics): Row {
  const requests = need(k6, 'cache_total', 'count');
  const hits = count(k6, 'hit');
  const misses = count(k6, 'miss');
  return {
    requests,
    hits,
    misses,
    other: requests - hits - misses,
    hitRate: requests === 0 ? 0 : hits / requests,
    failed: need(k6, 'cache_failed', 'count'),
    upstreamCalls: need(k6, 'cache_upstream_calls', 'count'),
    hitP50Ms: latency(k6, 'hit', 'med'),
    hitP95Ms: latency(k6, 'hit', 'p(95)'),
    missP50Ms: latency(k6, 'miss', 'med'),
    missP95Ms: latency(k6, 'miss', 'p(95)'),
  };
}

const pct = (x: number) => `${(x * 100).toFixed(2)}%`;
const ms = (x: number | null) => (x === null ? 'n/a' : `${x.toFixed(1)} ms`);

export function table(rs: { title: string; row: Row }[]): string {
  const lines = [
    '| run | requests | hits | misses | other | hit rate | upstream calls | non-200 | hit p50 | hit p95 | miss p50 | miss p95 |',
    '|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|',
  ];
  for (const { title, row: r } of rs) {
    lines.push(
      `| ${title} | ${r.requests} | ${r.hits} | ${r.misses} | ${r.other} | ${pct(r.hitRate)} | ${r.upstreamCalls} | ${r.failed} | ${ms(r.hitP50Ms)} | ${ms(r.hitP95Ms)} | ${ms(r.missP50Ms)} | ${ms(r.missP95Ms)} |`,
    );
  }
  return lines.join('\n');
}

export function render(runs: Record<string, K6Metrics>): string {
  const rs = RUNS.map((r) => {
    const k6 = runs[r.name];
    if (!k6) throw new Error(`no k6 summary for ${r.name}`);
    return { title: r.title, row: row(k6) };
  });
  return [
    '# Exact-match cache',
    '',
    'Source: `cache-cold.json`, `cache-warm.json`, `cache-warm-stream.json` and `cache-stampede.json` (k6 summary exports of `bench/k6/cache.js`, started by `bench/run-cache.sh`).',
    'Conditions: `conditions.txt` in this folder. Hits and misses are what the gateway reported in `x-gateway-cache`; upstream calls are the sum of `x-gateway-attempts` (0 for a hit).',
    'Every request is `temperature: 0`. The cache is empty for each run\'s prompts when it starts, so the first request for a prompt is a miss.',
    '',
    table(rs),
    '',
  ].join('\n');
}

if (import.meta.main) {
  const dir = process.argv[2];
  if (!dir) throw new Error('usage: node bench/cache-summary.ts <results-dir>');
  const runs: Record<string, K6Metrics> = {};
  for (const r of RUNS) runs[r.name] = JSON.parse(readFileSync(join(dir, `cache-${r.name}.json`), 'utf8')) as K6Metrics;
  writeFileSync(join(dir, 'summary.md'), render(runs));
  console.log(`wrote ${join(dir, 'summary.md')}`);
}
