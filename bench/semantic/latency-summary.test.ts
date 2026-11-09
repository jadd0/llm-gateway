import { describe, expect, it } from 'vitest';
import { render, row, RUNS } from './latency-summary.ts';

// One distinct number per field, so a swapped field shows up.
function fake(scale: number, opts: { noSemantic?: boolean } = {}) {
  const metrics: Record<string, Record<string, number>> = {
    sem_total: { count: 100 * scale },
    sem_failed: { count: 2 * scale },
    sem_upstream_calls: { count: 37 * scale },
    'sem_requests{status:hit}': { count: 20 * scale },
    'sem_ms{status:hit}': { med: 3.5 * scale, 'p(95)': 9.25 * scale },
    'sem_requests{status:miss}': { count: 30 * scale },
    'sem_ms{status:miss}': { med: 210.25 * scale, 'p(95)': 260.5 * scale },
  };
  if (!opts.noSemantic) {
    metrics['sem_requests{status:semantic-hit}'] = { count: 40 * scale };
    metrics['sem_ms{status:semantic-hit}'] = { med: 61.5 * scale, 'p(95)': 88.75 * scale };
    metrics.sem_similarity = { med: 0.9731 };
  }
  return { metrics };
}

describe('semantic latency summary', () => {
  it('reads every figure from the k6 summary', () => {
    expect(row(fake(1))).toEqual({
      requests: 100,
      failed: 2,
      upstreamCalls: 37,
      counts: { hit: 20, 'semantic-hit': 40, miss: 30 },
      other: 10,
      p50Ms: { hit: 3.5, 'semantic-hit': 61.5, miss: 210.25 },
      p95Ms: { hit: 9.25, 'semantic-hit': 88.75, miss: 260.5 },
      similarityMedian: 0.9731,
    });
  });

  it('a run with no semantic hits has none, and no latency for them, not an error', () => {
    const k6 = fake(1, { noSemantic: true });
    expect(row(k6)).toMatchObject({ counts: { 'semantic-hit': 0 }, other: 50, similarityMedian: null });
    expect(row(k6).p50Ms['semantic-hit']).toBeNull();
    // A zeroed trend with no requests is also no latency.
    k6.metrics['sem_requests{status:semantic-hit}'] = { count: 0 };
    k6.metrics['sem_ms{status:semantic-hit}'] = { med: 0, 'p(95)': 0 };
    expect(row(k6).p95Ms['semantic-hit']).toBeNull();
  });

  it('renders one row per run, and fails loudly on a missing run or counter', () => {
    const runs = Object.fromEntries(RUNS.map((r, i) => [r.name, fake(i + 1)]));
    const md = render(runs);
    expect(md).toContain('| Paraphrase: another wording of a seeded prompt | 200 | 40 | 80 | 60 | 20 | 74 | 4 | 7.0 ms / 18.5 ms | 123.0 ms / 177.5 ms | 420.5 ms / 521.0 ms | 0.973 |');
    expect(md.match(/^\| [A-Z]/gm)).toHaveLength(RUNS.length);
    const { miss: _gone, ...fewer } = runs;
    expect(() => render(fewer)).toThrow(/no k6 summary for miss/);
    expect(() => row({ metrics: {} })).toThrow(/no sem_total count/);
  });
});
