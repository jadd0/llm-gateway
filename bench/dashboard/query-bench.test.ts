import { describe, expect, it } from 'vitest';
import { pct, renderSummary, summarize, timeIt, type Results } from './query-bench.ts';

describe('bench arithmetic', () => {
  it('takes nearest-rank percentiles from the timings', () => {
    const xs = Array.from({ length: 20 }, (_, i) => (i + 1) * 10);
    expect(pct(xs, 0.5)).toBe(100);
    expect(pct(xs, 0.95)).toBe(190);
    expect(summarize([5, 1, 3])).toEqual({ reps: 3, p50Ms: 3, p95Ms: 5, minMs: 1, maxMs: 5 });
  });

  it('runs one warm-up and then the timed runs', async () => {
    let calls = 0;
    const t = await timeIt(4, async () => void calls++);
    expect(calls).toBe(5);
    expect(t.reps).toBe(4);
  });

  it('writes every figure of the summary from the results it is given', () => {
    const r: Results = {
      startedAt: '2032-01-01T00:00:00.000Z', node: 'v0', postgres: 'PostgreSQL 0', cpus: 'cpu x1', loadAvgAtStart: [0, 0, 0], sizes: [10, 20],
      rollupRows: [{ size: 10, rollupMinuteRows: 7, rollupHourRows: 3 }, { size: 20, rollupMinuteRows: 8, rollupHourRows: 4 }],
      rows: [
        { size: 10, query: 'overview 24h', source: 'rollups', timing: { reps: 3, p50Ms: 1.234, p95Ms: 2.5, minMs: 1, maxMs: 3 } },
        { size: 20, query: 'overview 24h', source: 'rollups', timing: { reps: 3, p50Ms: 1.3, p95Ms: 2.6, minMs: 1, maxMs: 3 } },
        { size: 10, query: 'overview 24h', source: 'raw', timing: { reps: 3, p50Ms: 40, p95Ms: 50, minMs: 1, maxMs: 3 } },
        { size: 20, query: 'overview 24h', source: 'raw', timing: { reps: 3, p50Ms: 81, p95Ms: 99, minMs: 1, maxMs: 3 } },
      ],
      agreement: [{ size: 10, range: '24h', rollup: { requests: 9, errors: 1, costMicros: 5, p95: 100 }, raw: { requests: 9, errors: 1, costMicros: 5, p95: 96 } }],
      errorsUseIndex: true,
    };
    const md = renderSummary(r);
    for (const want of ['| overview 24h | 1.23 (2.50) | 1.30 (2.60) |', '| overview 24h | 40.0 (50.0) | 81.0 (99.0) |', '| 10 | 7 | 3 |', '| 10 | 24h | 9 / 9 | 1 / 1 | 5 / 5 | 100.0 / 96.0 |', 'partial index: yes']) {
      expect(md).toContain(want);
    }
  });
});
