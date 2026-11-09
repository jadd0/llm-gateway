import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { breakingPoint, ceiling, failures, load, maxAdmissions, overLimit, rampSteps, rateLimitProblems, render, spikeFigures, steadyRate } from './final-summary.ts';

// A k6 export for slices given as [tags, figures]. One distinct number per field, so a swapped field shows up.
interface S { n: number; failed?: number; dropped?: number; p50: number; p95: number; p99: number }
function k6(slices: Record<string, S>) {
  const metrics: Record<string, Record<string, number>> = {};
  for (const [tags, s] of Object.entries(slices)) {
    metrics[`http_reqs{${tags}}`] = { count: s.n };
    metrics[`http_req_failed{${tags}}`] = { passes: s.failed ?? 0, fails: s.n - (s.failed ?? 0) };
    if (s.dropped) metrics[`dropped_iterations{${tags}}`] = { count: s.dropped };
    metrics[`http_req_duration{${tags},expected_response:true}`] = { med: s.p50, 'p(95)': s.p95, 'p(99)': s.p99 };
  }
  return { metrics };
}
const step = (rate: number, s: Partial<S> & { p95: number }): [string, S] => [
  `step:${rate},phase:measure`,
  { n: rate * 15, p50: s.p95 / 2, p99: s.p95 * 1.5, ...s },
];
// Steps 1000..5000: p95 1,1.5,1.9,3 then 20 (past 10x) with 2% errors at the last.
const ramp = (scale = 1) =>
  k6(Object.fromEntries([
    step(1000, { p95: 1 * scale }),
    step(2000, { p95: 1.5 * scale }),
    step(3000, { p95: 1.9 * scale }),
    step(4000, { p95: 3 * scale }),
    step(5000, { p95: 20 * scale, failed: 1500, n: 75000 }),
  ]));

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

function fixture(): string {
  const dir = mkdtempSync(join(tmpdir(), 'final-summary-'));
  dirs.push(dir);
  mkdirSync(join(dir, 'cluster')); mkdirSync(join(dir, 'correctness')); mkdirSync(join(dir, 'logging'));
  const w = (rel: string, v: unknown) => writeFileSync(join(dir, rel), typeof v === 'string' ? v : JSON.stringify(v));
  w('params.json', { rampMeasureS: 15, spikeWindowS: 5 });
  w('conditions.txt', 'loadavg: { 1.20 }\n');
  for (const rep of [1, 2, 3]) {
    w(`cluster/ramp-1i-${rep}.json`, ramp(rep));
    w(`cluster/ramp-3i-${rep}.json`, ramp(rep));
    w(`cluster/steady-3i-2400-${rep}.json`, k6({ 'phase:measure': { n: 144000, failed: rep - 1, p50: 1.25 * rep, p95: 2.5 * rep, p99: 3.75 * rep } }));
    w(`cluster/spike-3i-${rep}.json`, k6({
      'phase:base': { n: 6000, p50: 1, p95: 2, p99: 3 },
      'phase:spike': { n: 40000, failed: 7, dropped: 3, p50: 4, p95: 40, p99: 60 },
      'phase:recover1': { n: 1000, p50: 2, p95: 30, p99: 40 },
      'phase:recover2': { n: 1000, p50: 1, p95: 2.5, p99: 3 },
    }));
  }
  for (const run of [1, 2]) {
    // The log says 105 admitted, the client saw 99: the table must use the log.
    w(`correctness/ratelimit-${run}.json`, { rpm: 100, windowS: 3, burst: 1000, admittedLog: 105, admittedK6: 99, logCaughtUp: true });
    w(`correctness/budget-${run}.json`, { rounds: 10, requestsPerRound: 50, admitted: 200, ledgerRows: 200, roundsOverCap: 0, maxOvershootMicros: 0 });
    w(`correctness/budget-failover-${run}.json`, { rounds: 10, requestsPerRound: 50, admitted: 210, ledgerRows: 210, roundsOverCap: 0, maxOvershootMicros: 0 });
  }
  w('logging/summary.md', '# Request logging\n\n| a |\n');
  mkdirSync(join(dir, 'cache/rep-1'), { recursive: true });
  w('cache/rep-1/summary.md', '# Cache\n');
  w('hardware.txt', 'cpu: test cpu\n');
  w('skipped.txt', 'frameworks: bench/frameworks is not on this base\n');
  for (const rep of [1, 2]) {
    mkdirSync(join(dir, `overhead/rep-${rep}`), { recursive: true });
    for (const [name, p50, p95, p99] of [['direct-instant', 1, 2, 3], ['gateway-instant', 1.5 * rep + 1, 2.5 * rep + 2, 4 * rep + 3]] as const) {
      w(`overhead/rep-${rep}/${name}.json`, k6({ 'phase:measure': { n: 1000, p50, p95, p99 } }));
    }
  }
  return dir;
}

describe('final summary', () => {
  it('summary regenerates byte-identical from the JSON', () => {
    const dir = fixture();
    const first = render(load(dir));
    const again = render(load(dir));
    expect(first).toBe(again);
    expect(first.length).toBeGreaterThan(500);
    // Medians over three repeats, not the first repeat's: ceiling 3000 in every repeat, p95 at 3000 req/s is 1.9/3.8/5.7.
    expect(first).toContain('| 3 | 3 | 3000 (3000 to 3000) | p95 over 2x the first step | 5000 (5000 to 5000) |');
    expect(first).toContain('| 3000 | 3000 (3000 to 3000) | 0 | 0 | 1.9 ms (0.9 to 2.8) | 3.8 ms (1.9 to 5.7) |');
    expect(first).toContain('| 3 | 2400 | 3 | 432000 | 3 | 2.5 ms (1.3 to 3.8) | 5.0 ms (2.5 to 7.5) | 7.5 ms (3.8 to 11.3) |');
    // Added latency is gateway minus direct per repeat: p50 1.5 and 3, p95 2.5 and 5, p99 4 and 8.
    expect(first).toContain('| instant | 2 | 2.3 ms (1.5 to 3.0) | 3.8 ms (2.5 to 5.0) | 6.0 ms (4.0 to 8.0) |');
    expect(first).toContain('- frameworks: bench/frameworks is not on this base');
    // The appended per-scenario summary has its headings demoted under the scenario heading.
    expect(first).toContain('## Scenario: logging');
    expect(first).toContain('### Request logging');
    expect(first).toContain('## Scenario: cache/rep-1');
    expect(first).toContain('cpu: test cpu\n\nloadavg: { 1.20 }');
    // No clock reading in the file.
    expect(first).not.toMatch(/20\d\d-\d\d-\d\d/);
  });

  it('finds the ceiling and the breaking point by the stated rules, and flags a k6-bound step', () => {
    const steps = rampSteps(ramp());
    expect(steps.map((s) => s.rate)).toEqual([1000, 2000, 3000, 4000, 5000]);
    expect(ceiling(steps)).toEqual({ rate: 3000, limit: 'p95 over 2x the first step' });
    expect(breakingPoint(steps)).toEqual({ rate: 5000, reason: 'p95 over 10x the first step' });
    const dropping = rampSteps(k6(Object.fromEntries([step(1000, { p95: 1 }), step(2000, { p95: 1.1, dropped: 3000 })])));
    expect(ceiling(dropping)).toEqual({ rate: 1000, limit: 'k6 dropped iterations' });
    // Dropped iterations are the load generator's limit, never a gateway breaking point.
    expect(breakingPoint(dropping)).toEqual({ rate: null, reason: 'k6-bound (dropped iterations)', k6BoundAt: 2000 });
    const failing = rampSteps(k6(Object.fromEntries([step(1000, { p95: 1 }), step(2000, { p95: 1.1, failed: 400, n: 30000 })])));
    expect(breakingPoint(failing)).toEqual({ rate: 2000, reason: 'errors over 1%' });
    const flat = rampSteps(k6(Object.fromEntries([step(1000, { p95: 1 }), step(2000, { p95: 1.2 })])));
    expect(ceiling(flat)).toEqual({ rate: 2000, limit: 'end of ramp' });
    expect(breakingPoint(flat)).toEqual({ rate: null, reason: 'not reached' });
    expect(() => rampSteps({ metrics: {} })).toThrow('no measured steps');
    // A step with no successful response has no p95: a breach, never a pass.
    const nan = [...flat.slice(0, 1), { ...flat[1]!, p95: Number.NaN }];
    expect(ceiling(nan)).toEqual({ rate: 1000, limit: 'p95 over 2x the first step' });
    expect(breakingPoint(nan)).toEqual({ rate: 2000, reason: 'p95 over 10x the first step' });
  });

  it('takes 60% of the lowest repeat ceiling for the steady runs', () => {
    expect(steadyRate(load(fixture()), 3, 0.6)).toBe(1800);
    expect(() => steadyRate(load(fixture()), 2, 0.6)).toThrow('no ramp files for 2');
  });

  it('measures spike recovery in whole windows after the spike', () => {
    const f = spikeFigures(
      k6({
        'phase:base': { n: 1, p50: 1, p95: 2, p99: 3 },
        'phase:spike': { n: 1, failed: 4, p50: 1, p95: 40, p99: 50 },
        'phase:recover1': { n: 1, p50: 1, p95: 30, p99: 40 },
        'phase:recover2': { n: 1, p50: 1, p95: 2.9, p99: 3 },
        'phase:recover3': { n: 1, p50: 1, p95: 2, p99: 3 },
      }),
      5,
    );
    expect(f).toEqual({ baseP95: 2, spikeP95: 40, spikeFailed: 4, spikeDropped: 0, recoveryS: 10 });
    expect(spikeFigures(k6({ 'phase:base': { n: 1, p50: 1, p95: 2, p99: 3 }, 'phase:spike': { n: 1, p50: 1, p95: 9, p99: 9 }, 'phase:recover1': { n: 1, p50: 1, p95: 9, p99: 9 } }), 5).recoveryS).toBeNull();
  });

  it('correctness table counts over-limit admissions from the larger of the request log and the client', () => {
    const run = { rpm: 100, windowS: 3, burst: 1000, admittedLog: 105, admittedK6: 99, logCaughtUp: true };
    expect(maxAdmissions(run)).toBe(105);
    expect(overLimit(run)).toBe(0);
    // The client count would pass; the log says two admissions too many.
    expect(overLimit({ ...run, admittedLog: 107, admittedK6: 99 })).toBe(2);
    // Whichever count is larger is used: a log that lags cannot hide an admission the client saw.
    expect(overLimit({ ...run, admittedLog: 90, admittedK6: 120 })).toBe(15);
    const md = render(load(fixture()));
    expect(md).toContain('| rate limit: admissions = larger of request log and client count, bound = rpm + refill from first request to last admission, floor = min(burst, rpm) | 2 | 2000 | 0 | 0 | pass |');
    expect(md).toContain('| budget flood: tenants whose settled spend passed the cap | 2 | 1000 | 0 | 0 | pass |');

    const dir = fixture();
    writeFileSync(join(dir, 'correctness/ratelimit-2.json'), JSON.stringify({ ...run, admittedLog: 108 }));
    const bad = render(load(dir));
    expect(bad).toContain('| 2 | 2000 | 3 | 3 | FAIL (1 of 2 runs) |');
    writeFileSync(join(dir, 'correctness/budget-1.json'), JSON.stringify({ rounds: 10, requestsPerRound: 50, admitted: 200, ledgerRows: 200, roundsOverCap: 2, maxOvershootMicros: 40 }));
    expect(render(load(dir))).toContain('| budget flood: tenants whose settled spend passed the cap | 2 | 1000 | 2 | 2 | FAIL |');
  });

  it('a ramp that never fails a rule reports a lower bound, not a ceiling', () => {
    const dir = fixture();
    for (const rep of [1, 2, 3]) writeFileSync(join(dir, `cluster/ramp-1i-${rep}.json`), JSON.stringify(k6(Object.fromEntries([step(1000, { p95: 1 }), step(2000, { p95: 1.2 })]))));
    const md = render(load(dir));
    expect(md).toContain('| 1 | 3 | ≥ 2000 (2000 to 2000) (ramp did not find the limit) | end of ramp | not found in 3 of 3 |');
    expect(md).toContain('For 1 instance the ramp never failed a rule, so the steady rate is 60% of the top ramp rate, not of a ceiling.');
    expect(md).toContain('| 3 | 3 | 3000 (3000 to 3000) | p95 over 2x the first step |');
  });

  it('latency tables mark a slice with more than 1% failed requests as FAIL and use successful durations', () => {
    const dir = fixture();
    // Gateway run: 160 of 200 requests refused. The successful ones were fast, which is exactly the trap.
    writeFileSync(join(dir, 'overhead/rep-1/gateway-instant.json'), JSON.stringify(k6({ 'phase:measure': { n: 200, failed: 160, p50: 0.5, p95: 0.9, p99: 1 } })));
    const d = load(dir);
    const md = render(d);
    expect(md).toContain('FAIL (160 of 200 failed)');
    expect(failures(d)).toEqual(['overhead instant repeat 1: FAIL (160 of 200 failed)']);
    // The percentile is read from the expected_response:true series, not the all-requests one.
    const onlyAll = { metrics: { 'http_reqs{phase:measure}': { count: 10 }, 'http_req_failed{phase:measure}': { passes: 0 }, 'http_req_duration{phase:measure}': { med: 1, 'p(95)': 1, 'p(99)': 1 } } };
    writeFileSync(join(dir, 'overhead/rep-2/gateway-instant.json'), JSON.stringify(onlyAll));
    expect(render(load(dir))).toContain('n/a');
    // A clean fixture has nothing to report.
    expect(failures(load(fixture()))).toEqual([]);
  });

  it('rate limit: over-admission, under-admission, a lagging log and stray 429s each fail the run', () => {
    const ok = { rpm: 100, windowS: 3, burst: 1000, admittedLog: 105, admittedK6: 105, logCaughtUp: true };
    expect(rateLimitProblems(ok)).toEqual([]);
    expect(rateLimitProblems({ ...ok, admittedLog: 106, admittedK6: 106 })).toEqual(['1 over-limit admissions']);
    // The log lags behind the client: the client's count is used, and the run is flagged.
    expect(rateLimitProblems({ ...ok, admittedLog: 90, admittedK6: 110, logCaughtUp: false })).toEqual(['5 over-limit admissions', 'request log did not catch up with the client']);
    expect(rateLimitProblems({ ...ok, admittedLog: 53, admittedK6: 53 })).toEqual(['under-admitted (53 of at least 100)']);
    expect(rateLimitProblems({ ...ok, other429: 4, other: 1 })).toEqual(['4 429s not from the request limiter', '1 answers other than 200 or 429']);
    const dir = fixture();
    writeFileSync(join(dir, 'correctness/ratelimit-1.json'), JSON.stringify({ ...ok, admittedLog: 120, admittedK6: 120 }));
    const md = render(load(dir));
    expect(md).toContain('| 2 | 2000 | 15 | 15 | FAIL (1 of 2 runs) |');
    expect(md).toContain('- run 1: 15 over-limit admissions');
  });

  it('superseded figures listed with their replacement', () => {
    const dir = fixture();
    expect(readFileSync(join(dir, 'params.json'), 'utf8')).toContain('rampMeasureS');
    expect(render(load(dir))).toContain('None recorded.');
    writeFileSync(
      join(dir, 'superseded.json'),
      JSON.stringify([
        { label: 'ceiling, one instance', was: 'an older figure', source: 'older source', replacedBy: 'ceiling.1i' },
        { label: 'a figure this run did not produce', was: 'x', source: 'y', replacedBy: 'ceiling.9i' },
      ]),
    );
    const md = render(load(dir));
    expect(md).toContain('| ceiling, one instance | an older figure | older source | 3000 (3000 to 3000) req/s | `ceiling.1i` |');
    expect(md).toContain('| NOT IN THIS RUN | `ceiling.9i` |');
  });
});
