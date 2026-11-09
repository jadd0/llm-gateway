// Turns the k6 summaries of bench/run-semantic.sh into summary.md. Every figure is read from the k6 JSON; nothing
// is computed from anything else except shares of the same counts.
//   node bench/semantic/latency-summary.ts <results-dir>
//   reads <dir>/semantic-{seed,paraphrase,exact,miss}.json, writes <dir>/latency.md
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

interface K6Metrics {
  metrics: Record<string, Record<string, number>>;
}

export const RUNS = [
  { name: 'seed', title: 'Seed: the original prompts, once each' },
  { name: 'paraphrase', title: 'Paraphrase: another wording of a seeded prompt' },
  { name: 'exact', title: 'Exact: a seeded prompt repeated' },
  { name: 'miss', title: 'Miss: a prompt nobody has sent' },
] as const;

export const STATUSES = ['hit', 'semantic-hit', 'miss'] as const;

export interface Row {
  requests: number;
  failed: number;
  upstreamCalls: number;
  counts: Record<(typeof STATUSES)[number], number>;
  /** Requests answered with none of the three statuses (bypass, uncacheable, unavailable). */
  other: number;
  p50Ms: Record<(typeof STATUSES)[number], number | null>;
  p95Ms: Record<(typeof STATUSES)[number], number | null>;
  /** Median x-gateway-similarity of the semantic hits; null when there were none. */
  similarityMedian: number | null;
}

function need(k6: K6Metrics, name: string, field: string): number {
  const v = k6.metrics[name]?.[field];
  if (v === undefined) throw new Error(`k6 summary has no ${name} ${field}`);
  return v;
}

// A status that never occurred has no sub-metric, or a zeroed one: either way it is zero requests, not a missing figure.
const count = (k6: K6Metrics, status: string) => k6.metrics[`sem_requests{status:${status}}`]?.count ?? 0;
const latency = (k6: K6Metrics, status: string, field: string) =>
  count(k6, status) === 0 ? null : (k6.metrics[`sem_ms{status:${status}}`]?.[field] ?? null);

export function row(k6: K6Metrics): Row {
  const requests = need(k6, 'sem_total', 'count');
  const counts = { hit: count(k6, 'hit'), 'semantic-hit': count(k6, 'semantic-hit'), miss: count(k6, 'miss') };
  return {
    requests,
    failed: need(k6, 'sem_failed', 'count'),
    upstreamCalls: need(k6, 'sem_upstream_calls', 'count'),
    counts,
    other: requests - counts.hit - counts['semantic-hit'] - counts.miss,
    p50Ms: { hit: latency(k6, 'hit', 'med'), 'semantic-hit': latency(k6, 'semantic-hit', 'med'), miss: latency(k6, 'miss', 'med') },
    p95Ms: { hit: latency(k6, 'hit', 'p(95)'), 'semantic-hit': latency(k6, 'semantic-hit', 'p(95)'), miss: latency(k6, 'miss', 'p(95)') },
    similarityMedian: counts['semantic-hit'] === 0 ? null : (k6.metrics.sem_similarity?.med ?? null),
  };
}

const ms = (x: number | null) => (x === null ? 'n/a' : `${x.toFixed(1)} ms`);

export function render(runs: Record<string, K6Metrics>): string {
  const lines = [
    '# Semantic cache request latency',
    '',
    'Source: `semantic-seed.json`, `semantic-paraphrase.json`, `semantic-exact.json` and `semantic-miss.json` (k6 summary exports of `bench/k6/semantic.js`, started by `bench/run-semantic.sh`).',
    'Conditions: `conditions.txt` in this folder. Statuses are what the gateway reported in `x-gateway-cache`; upstream calls are the sum of `x-gateway-attempts`.',
    '',
    '| run | requests | exact hits | semantic hits | misses | other | upstream calls | non-200 | exact-hit p50 / p95 | semantic-hit p50 / p95 | miss p50 / p95 | median similarity |',
    '|---|---:|---:|---:|---:|---:|---:|---:|---|---|---|---:|',
  ];
  for (const r of RUNS) {
    const k6 = runs[r.name];
    if (!k6) throw new Error(`no k6 summary for ${r.name}`);
    const x = row(k6);
    const pair = (s: (typeof STATUSES)[number]) => `${ms(x.p50Ms[s])} / ${ms(x.p95Ms[s])}`;
    lines.push(
      `| ${r.title} | ${x.requests} | ${x.counts.hit} | ${x.counts['semantic-hit']} | ${x.counts.miss} | ${x.other} | ${x.upstreamCalls} | ${x.failed} | ${pair('hit')} | ${pair('semantic-hit')} | ${pair('miss')} | ${x.similarityMedian === null ? 'n/a' : x.similarityMedian.toFixed(3)} |`,
    );
  }
  return `${lines.join('\n')}\n`;
}

if (import.meta.main) {
  const dir = process.argv[2];
  if (!dir) throw new Error('usage: node bench/semantic/latency-summary.ts <results-dir>');
  const runs: Record<string, K6Metrics> = {};
  for (const r of RUNS) runs[r.name] = JSON.parse(readFileSync(join(dir, `semantic-${r.name}.json`), 'utf8')) as K6Metrics;
  writeFileSync(join(dir, 'latency.md'), render(runs));
  console.log(`wrote ${join(dir, 'latency.md')}`);
}
