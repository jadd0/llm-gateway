// Turns the two k6 summaries of bench/run-chaos.sh into summary.md. Every figure in it is read from the k6
// JSON; nothing is computed from anything else.
//   node bench/chaos-summary.ts <results-dir>
//   reads <dir>/chaos-fallback-on.json and <dir>/chaos-fallback-off.json, writes <dir>/summary.md
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const PHASES = ['before', 'outage', 'after'] as const;
export type Phase = (typeof PHASES)[number];
export const STREAMS = ['false', 'true'] as const;

interface K6Metrics {
  metrics: Record<string, Record<string, number>>;
}

export interface Row {
  phase: Phase;
  stream: 'false' | 'true';
  requests: number;
  /** Share of requests that got a complete answer, 0 to 1. */
  success: number;
  p50Ms: number;
  p95Ms: number;
  /** Upstream calls the gateway made per request (x-gateway-attempts). */
  attemptsPerRequest: number;
  /** Requests that cost exactly one upstream call. */
  singleAttempt: number;
  /** Requests answered by a model other than the one asked for. */
  fallbackServed: number;
}

function metric(k6: K6Metrics, name: string, phase: Phase, stream: string, field: string): number {
  const key = `${name}{phase:${phase},stream:${stream}}`;
  const m = k6.metrics[key];
  const v = m?.[field];
  if (v === undefined) throw new Error(`k6 summary has no ${key} ${field}`);
  return v;
}

export function rows(k6: K6Metrics): Row[] {
  const out: Row[] = [];
  for (const phase of PHASES) {
    for (const stream of STREAMS) {
      const requests = metric(k6, 'chaos_requests', phase, stream, 'count');
      out.push({
        phase,
        stream,
        requests,
        success: requests === 0 ? 0 : metric(k6, 'chaos_ok', phase, stream, 'value'),
        p50Ms: requests === 0 ? 0 : metric(k6, 'chaos_ms', phase, stream, 'med'),
        p95Ms: requests === 0 ? 0 : metric(k6, 'chaos_ms', phase, stream, 'p(95)'),
        attemptsPerRequest: requests === 0 ? 0 : metric(k6, 'chaos_attempts', phase, stream, 'count') / requests,
        singleAttempt: metric(k6, 'chaos_single_attempt', phase, stream, 'count'),
        fallbackServed: metric(k6, 'chaos_fallback_served', phase, stream, 'count'),
      });
    }
  }
  return out;
}

const pct = (x: number) => `${(x * 100).toFixed(2)}%`;
const ms = (x: number) => `${x.toFixed(1)} ms`;

export function table(rs: Row[]): string {
  const lines = [
    '| phase | kind | requests | success | p50 | p95 | upstream calls per request | requests with one call | served by fallback |',
    '|---|---|---:|---:|---:|---:|---:|---:|---:|',
  ];
  for (const r of rs) {
    lines.push(
      `| ${r.phase} | ${r.stream === 'true' ? 'streamed' : 'non-streamed'} | ${r.requests} | ${pct(r.success)} | ${ms(r.p50Ms)} | ${ms(r.p95Ms)} | ${r.attemptsPerRequest.toFixed(2)} | ${r.singleAttempt} | ${r.fallbackServed} |`,
    );
  }
  return lines.join('\n');
}

export function render(on: K6Metrics, off: K6Metrics): string {
  return [
    '# Resilience under outage',
    '',
    'Source: `chaos-fallback-on.json` and `chaos-fallback-off.json` (k6 summary exports of `bench/k6/chaos.js`, started by `bench/run-chaos.sh`).',
    'Conditions: `conditions.txt` in this folder. Success is a complete answer: HTTP 200, and for a stream the `[DONE]` terminator.',
    'The phase of a request is the one it was sent in: before the first mock is killed, while it is down, after a fresh one is started.',
    '',
    '## With the fallback chain (`mock-openai-1>mock-anthropic-1`)',
    '',
    table(rows(on)),
    '',
    '## Without a chain',
    '',
    table(rows(off)),
    '',
  ].join('\n');
}

if (import.meta.main) {
  const dir = process.argv[2];
  if (!dir) throw new Error('usage: node bench/chaos-summary.ts <results-dir>');
  const read = (name: string) => JSON.parse(readFileSync(join(dir, name), 'utf8')) as K6Metrics;
  writeFileSync(join(dir, 'summary.md'), render(read('chaos-fallback-on.json'), read('chaos-fallback-off.json')));
  console.log(`wrote ${join(dir, 'summary.md')}`);
}
