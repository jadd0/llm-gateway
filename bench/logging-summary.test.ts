import { describe, expect, it } from 'vitest';
import { figures, median, parseSamples, render, spread, workerFigures } from './logging-summary.ts';

// One distinct number per field, so a swapped field shows up.
const k6 = (scale: number) => ({
  metrics: {
    'http_reqs{phase:measure}': { count: 1000 * scale },
    'http_req_failed{phase:measure}': { passes: 3 * scale, fails: 997 },
    'http_req_duration{phase:measure}': { med: 210.5 * scale, 'p(95)': 250.25 * scale, 'p(99)': 300.75 * scale },
  },
});

describe('logging summary', () => {
  it('reads every figure from the k6 summary', () => {
    expect(figures(k6(1))).toEqual({ requests: 1000, failed: 3, p50: 210.5, p95: 250.25, p99: 300.75 });
    expect(() => figures({ metrics: {} })).toThrow('http_reqs');
  });

  it('median and spread over repeats', () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 2, 3])).toBe(2.5);
    expect(spread([5, 9, 7])).toEqual({ median: 7, min: 5, max: 9 });
    expect(() => median([])).toThrow();
  });

  it('worker lag and rows per second come from the samples', () => {
    const samples = parseSamples('t_ms,lag,pending,rows\n0,0,0,100\n1000,40,5,600\n2000,10,2,1100\n');
    expect(samples).toHaveLength(3);
    expect(workerFigures(samples)).toEqual({ maxLag: 40, maxPending: 5, rows: 1000, rowsPerS: 500 });
    expect(() => parseSamples('t_ms,lag,pending,rows\n0,x,0,1')).toThrow('bad worker sample');
    expect(() => workerFigures(samples.slice(0, 1))).toThrow();
  });

  it('renders both modes, the repeats and the worker table, and refuses a missing mode', () => {
    const runs = { inline: [figures(k6(1)), figures(k6(2)), figures(k6(3))], stream: [figures(k6(1))] };
    const md = render(runs, [workerFigures(parseSamples('0,0,0,0\n1000,7,1,50'))]);
    expect(md).toContain('| inline | 3 | 6000 | 18 | 421.0 ms (210.5 to 631.5) |');
    expect(md).toContain('| stream | 1 | 1000 | 3 | 210.5 ms (210.5 to 210.5) |');
    expect(md).toContain('| 1 | 7 (7 to 7) | 1 | 50.0 (50.0 to 50.0) |');
    expect(() => render({ inline: [], stream: runs.stream }, [])).toThrow('no k6 summary for inline');
  });
});
