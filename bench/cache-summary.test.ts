import { describe, expect, it } from 'vitest';
import { RUNS, render, row } from './cache-summary.ts';

// A k6 summary export with only the metrics the cache script defines, one distinct number per field so a swapped
// field shows up.
function fake(scale: number, opts: { noHits?: boolean } = {}) {
  const metrics: Record<string, Record<string, number>> = {
    cache_total: { count: 100 * scale },
    cache_failed: { count: 2 * scale },
    cache_upstream_calls: { count: 37 * scale },
    'cache_requests{status:miss}': { count: 30 * scale },
    'cache_ms{status:miss}': { med: 210.25 * scale, 'p(95)': 260.5 * scale },
  };
  if (!opts.noHits) {
    metrics['cache_requests{status:hit}'] = { count: 60 * scale };
    metrics['cache_ms{status:hit}'] = { med: 3.5 * scale, 'p(95)': 9.25 * scale };
  }
  return { metrics };
}

describe('cache summary', () => {
  it('reads every figure from the k6 summary', () => {
    expect(row(fake(1))).toEqual({
      requests: 100,
      hits: 60,
      misses: 30,
      other: 10,
      hitRate: 0.6,
      failed: 2,
      upstreamCalls: 37,
      hitP50Ms: 3.5,
      hitP95Ms: 9.25,
      missP50Ms: 210.25,
      missP95Ms: 260.5,
    });
  });

  it('a run with no hits has zero hits and no hit latency, not an error', () => {
    expect(row(fake(1, { noHits: true }))).toMatchObject({ hits: 0, hitRate: 0, other: 70, hitP50Ms: null, hitP95Ms: null });
  });

  it('a status with a zeroed trend and no requests has no latency either', () => {
    const k6 = fake(1, { noHits: true });
    k6.metrics['cache_requests{status:hit}'] = { count: 0 };
    k6.metrics['cache_ms{status:hit}'] = { med: 0, 'p(95)': 0 };
    expect(row(k6)).toMatchObject({ hits: 0, hitP50Ms: null, hitP95Ms: null });
  });

  it('renders one table row per run with the numbers formatted', () => {
    const runs = Object.fromEntries(RUNS.map((r, i) => [r.name, fake(i + 1)]));
    const md = render(runs);
    expect(md).toContain('| Cold: every prompt new | 100 | 60 | 30 | 10 | 60.00% | 37 | 2 | 3.5 ms | 9.3 ms | 210.3 ms | 260.5 ms |');
    expect(md).toContain('| Stampede: identical requests at once | 400 | 240 | 120 | 40 | 60.00% | 148 | 8 | 14.0 ms | 37.0 ms | 841.0 ms | 1042.0 ms |');
    expect(md.match(/^\| [A-Z]/gm)).toHaveLength(RUNS.length);
  });

  it('fails loudly when a run is missing or the summary lacks a counter', () => {
    const runs = Object.fromEntries(RUNS.map((r) => [r.name, fake(1)]));
    const { stampede: _gone, ...fewer } = runs;
    expect(() => render(fewer)).toThrow(/no k6 summary for stampede/);
    const broken = fake(1);
    delete broken.metrics.cache_upstream_calls;
    expect(() => row(broken)).toThrow(/cache_upstream_calls/);
  });
});
