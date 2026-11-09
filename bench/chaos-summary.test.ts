import { describe, expect, it } from 'vitest';
import { PHASES, STREAMS, render, rows } from './chaos-summary.ts';

// A k6 summary export with only the metrics the chaos script defines, one distinct number per field so a
// swapped field shows up.
function fake(scale: number) {
  const metrics: Record<string, Record<string, number>> = {};
  let i = 0;
  for (const phase of PHASES) {
    for (const stream of STREAMS) {
      i++;
      const tag = `{phase:${phase},stream:${stream}}`;
      metrics[`chaos_requests${tag}`] = { count: 100 * i };
      metrics[`chaos_ok${tag}`] = { value: 1 - i / 100 / scale, passes: 1, fails: 1 };
      metrics[`chaos_ms${tag}`] = { med: 10 * i, 'p(95)': 20 * i + 0.5 };
      metrics[`chaos_attempts${tag}`] = { count: 150 * i };
      metrics[`chaos_single_attempt${tag}`] = { count: 7 * i };
      metrics[`chaos_fallback_served${tag}`] = { count: 3 * i };
    }
  }
  return { metrics };
}

describe('chaos summary', () => {
  it('reads every figure from the k6 summary, per phase and kind', () => {
    const rs = rows(fake(1));
    expect(rs).toHaveLength(6);
    expect(rs.map((r) => `${r.phase}/${r.stream}`)).toEqual([
      'before/false', 'before/true', 'outage/false', 'outage/true', 'after/false', 'after/true',
    ]);
    // The outage, non-streamed row is the third: i = 3.
    expect(rs[2]).toEqual({
      phase: 'outage', stream: 'false', requests: 300, success: 0.97, p50Ms: 30, p95Ms: 60.5,
      attemptsPerRequest: 1.5, singleAttempt: 21, fallbackServed: 9,
    });
  });

  it('renders both runs as markdown tables with the numbers formatted', () => {
    const md = render(fake(1), fake(2));
    expect(md).toContain('| outage | non-streamed | 300 | 97.00% | 30.0 ms | 60.5 ms | 1.50 | 21 | 9 |');
    expect(md).toContain('| outage | non-streamed | 300 | 98.50% | 30.0 ms | 60.5 ms | 1.50 | 21 | 9 |');
    expect(md.indexOf('With the fallback chain')).toBeLessThan(md.indexOf('Without a chain'));
    expect(md.match(/^\| (before|outage|after) /gm)).toHaveLength(12);
  });

  it('fails loudly when the summary lacks a metric', () => {
    const broken = fake(1);
    delete broken.metrics['chaos_ok{phase:outage,stream:true}'];
    expect(() => rows(broken)).toThrow(/chaos_ok\{phase:outage,stream:true\}/);
  });
});
