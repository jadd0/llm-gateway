// Turns bench/results/final/ into one summary.md. Every figure is read from the JSON in that folder; the only
// arithmetic is the median and range over repeats, the ceiling and breaking-point rules over the ramp's steps,
// and the allowed-admissions bound of the rate limiter. The same folder always yields the same bytes.
//   node bench/final-summary.ts <final-dir>            writes <final-dir>/summary.md
//   node bench/final-summary.ts ceiling <final-dir> <instances> [fraction]
//                                                      prints the req/s at <fraction> (default 0.6) of the ceiling
//                                                      the ramp files of that instance count give (run-all uses it)
// Layout it reads (run-all writes it):
//   params.json                          the run's timings: rampMeasureS, spikeWindowS
//   hardware.txt, conditions.txt         the machine and quiet.sh's record of its state, quoted
//   overhead/rep-<n>/{direct,gateway}-{instant,realistic}.json   k6 exports of bench/run-baseline.sh, one folder per repeat
//   skipped.txt                          optional: scenarios run-all could not run on this base, one per line
//   cluster/ramp-<n>i-<rep>.json         k6 export of bench/k6/ramp.js against n gateway instances
//   cluster/steady-<n>i-<rate>-<rep>.json  k6 export of bench/k6/chat.js at one rate (60% of that ceiling)
//   cluster/spike-<n>i-<rep>.json        k6 export of bench/k6/spike.js
//   correctness/ratelimit-<run>.json, budget-<run>.json, budget-failover-<run>.json   one per run
//   superseded.json                      optional: older figures and the key of the figure that replaces each
//   <scenario>/{summary,latency}.md      the per-scenario summaries other scripts write; appended verbatim
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

type K6 = { metrics: Record<string, Record<string, number>> };

export interface Params {
  rampMeasureS: number;
  spikeWindowS: number;
}

export interface Spread {
  median: number;
  min: number;
  max: number;
}

export function median(xs: number[]): number {
  if (xs.length === 0) throw new Error('median of nothing');
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}
export const spread = (xs: number[]): Spread => ({ median: median(xs), min: Math.min(...xs), max: Math.max(...xs) });

function need(k6: K6, name: string, field: string): number {
  const v = k6.metrics[name]?.[field];
  if (v === undefined) throw new Error(`k6 summary has no ${name} ${field}`);
  return v;
}

export interface Slice {
  requests: number;
  failed: number;
  dropped: number;
  p50: number;
  p95: number;
  p99: number;
}

/** One tagged slice of a k6 export, e.g. `phase:measure` or `step:1000,phase:measure`. */
export function slice(k6: K6, tags: string): Slice {
  return {
    requests: need(k6, `http_reqs{${tags}}`, 'count'),
    // http_req_failed is a rate: its `passes` is the number of failed requests.
    failed: k6.metrics[`http_req_failed{${tags}}`]?.passes ?? 0,
    // k6 omits dropped_iterations when none were dropped.
    dropped: k6.metrics[`dropped_iterations{${tags}}`]?.count ?? 0,
    p50: need(k6, `http_req_duration{${tags}}`, 'med'),
    p95: need(k6, `http_req_duration{${tags}}`, 'p(95)'),
    p99: need(k6, `http_req_duration{${tags}}`, 'p(99)'),
  };
}

const ERROR_LIMIT = 0.01;

export interface RampStep extends Slice {
  rate: number;
}
export function rampSteps(k6: K6): RampStep[] {
  const rates = Object.keys(k6.metrics)
    .map((k) => /^http_reqs\{step:(\d+),phase:measure\}$/.exec(k)?.[1])
    .filter((r): r is string => r !== undefined)
    .map(Number)
    .sort((a, b) => a - b);
  if (rates.length === 0) throw new Error('ramp summary has no measured steps');
  return rates.map((rate) => ({ rate, ...slice(k6, `step:${rate},phase:measure`) }));
}

const offered = (s: Slice) => s.requests + s.dropped;
const errorRate = (s: Slice) => (offered(s) === 0 ? 1 : s.failed / s.requests);
const droppedShare = (s: Slice) => (offered(s) === 0 ? 1 : s.dropped / offered(s));

export type Limit = 'errors' | 'p95 over 2x the first step' | 'k6 dropped iterations' | 'end of ramp';

export interface Ceiling {
  rate: number | null;
  limit: Limit;
}
/**
 * The last step with errors <= 1%, p95 <= 2x the first step's p95 and no more than 1% of its iterations dropped
 * (a dropped iteration is load k6 could not send, so a step that drops is bound by the load generator).
 * The scan stops at the first step that fails.
 */
export function ceiling(steps: RampStep[]): Ceiling {
  const base = steps[0]!.p95;
  let last: number | null = null;
  for (const s of steps) {
    if (errorRate(s) > ERROR_LIMIT) return { rate: last, limit: 'errors' };
    if (droppedShare(s) > ERROR_LIMIT) return { rate: last, limit: 'k6 dropped iterations' };
    if (s.p95 > 2 * base) return { rate: last, limit: 'p95 over 2x the first step' };
    last = s.rate;
  }
  return { rate: last, limit: 'end of ramp' };
}

export interface Breaking {
  rate: number | null;
  reason: 'p95 over 10x the first step' | 'errors over 1%' | 'not reached';
}
/** The first step whose p95 is over 10x the first step's, or whose errors (failed plus dropped) exceed 1%. */
export function breakingPoint(steps: RampStep[]): Breaking {
  const base = steps[0]!.p95;
  for (const s of steps) {
    if (s.p95 > 10 * base) return { rate: s.rate, reason: 'p95 over 10x the first step' };
    if (errorRate(s) > ERROR_LIMIT || droppedShare(s) > ERROR_LIMIT) return { rate: s.rate, reason: 'errors over 1%' };
  }
  return { rate: null, reason: 'not reached' };
}

export interface SpikeFigures {
  baseP95: number;
  spikeP95: number;
  spikeFailed: number;
  spikeDropped: number;
  /** Seconds after the spike until a window's p95 is within 1.5x the base's with no errors; null if none was. */
  recoveryS: number | null;
}
export function spikeFigures(k6: K6, windowS: number): SpikeFigures {
  const base = slice(k6, 'phase:base');
  const spike = slice(k6, 'phase:spike');
  let recoveryS: number | null = null;
  for (let i = 1; k6.metrics[`http_reqs{phase:recover${i}}`] !== undefined; i++) {
    const w = slice(k6, `phase:recover${i}`);
    if (w.p95 <= 1.5 * base.p95 && w.failed === 0 && w.dropped === 0) {
      recoveryS = i * windowS;
      break;
    }
  }
  return { baseP95: base.p95, spikeP95: spike.p95, spikeFailed: spike.failed, spikeDropped: spike.dropped, recoveryS };
}

export interface RateLimitRun {
  rpm: number;
  /** Seconds the burst was in flight: the slowest request's duration. */
  windowS: number;
  burst: number;
  /** Requests with status 200 in the request log for the run's key. */
  admittedLog: number;
  /** What the client saw: status 200 counted by k6. */
  admittedK6: number;
}
/** A key admits its bucket plus what refilled while the burst was in flight. */
export const maxAdmissions = (r: Pick<RateLimitRun, 'rpm' | 'windowS'>) => r.rpm + Math.floor((r.windowS * r.rpm) / 60);
/** Over-limit admissions as the request log recorded them. */
export const overLimit = (r: RateLimitRun) => Math.max(0, r.admittedLog - maxAdmissions(r));

export interface BudgetRun {
  rounds: number;
  requestsPerRound: number;
  admitted: number;
  ledgerRows: number;
  roundsOverCap: number;
  maxOvershootMicros: number;
}

export interface Superseded {
  label: string;
  was: string;
  source: string;
  /** Key of the figure in `figureIndex` that replaces it. */
  replacedBy: string;
}

export const PROFILES = ['instant', 'realistic'] as const;
export type Profile = (typeof PROFILES)[number];
export interface OverheadRep {
  direct: Slice;
  gateway: Slice;
}

export interface Data {
  params: Params;
  overhead: Record<Profile, OverheadRep[]>;
  skipped: string[];
  conditions: string | null;
  ramps: Map<number, K6[]>;
  steady: Map<string, K6[]>;
  spikes: Map<number, K6[]>;
  rateLimit: RateLimitRun[];
  budget: BudgetRun[];
  failover: BudgetRun[];
  superseded: Superseded[];
  appendices: { name: string; text: string }[];
}

const ms = (s: Spread) => `${s.median.toFixed(1)} ms (${s.min.toFixed(1)} to ${s.max.toFixed(1)})`;
const num = (s: Spread) => `${s.median} (${s.min} to ${s.max})`;
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
const byNumber = (a: number, b: number) => a - b;

/** Named figures, for the superseded list to point at. */
export function figureIndex(d: Data): Map<string, string> {
  const idx = new Map<string, string>();
  for (const [n, runs] of [...d.ramps].sort((a, b) => a[0] - b[0])) {
    const cs = runs.map((k) => ceiling(rampSteps(k)).rate ?? 0);
    idx.set(`ceiling.${n}i`, `${num(spread(cs))} req/s`);
    const bs = runs.map((k) => breakingPoint(rampSteps(k)).rate);
    idx.set(`breaking.${n}i`, bs.every((b) => b !== null) ? `${num(spread(bs as number[]))} req/s` : 'not reached in every repeat');
  }
  for (const [key, runs] of [...d.steady].sort((a, b) => a[0].localeCompare(b[0]))) {
    const ss = runs.map((k) => slice(k, 'phase:measure'));
    idx.set(`steady.${key}.p95`, ms(spread(ss.map((s) => s.p95))));
    idx.set(`steady.${key}.p50`, ms(spread(ss.map((s) => s.p50))));
  }
  idx.set('correctness.ratelimit.overLimit', String(sum(d.rateLimit.map(overLimit))));
  idx.set('correctness.budget.roundsOverCap', String(sum(d.budget.map((b) => b.roundsOverCap))));
  idx.set('correctness.failover.roundsOverCap', String(sum(d.failover.map((b) => b.roundsOverCap))));
  return idx;
}

function steadyKey(inst: number, rate: number) {
  return `${inst}i-${rate}`;
}

export function render(d: Data): string {
  const out: string[] = [
    '# Final benchmark summary',
    '',
    'Generated by `node bench/final-summary.ts` from the JSON in this folder and nothing else. Cells are the median over the repeats with the range in brackets.',
    '',
  ];
  if (d.conditions !== null) out.push('## Conditions', '', '```', d.conditions.trimEnd(), '```', '');

  out.push('## Overhead of one gateway', '');
  if (PROFILES.every((p) => d.overhead[p].length === 0)) out.push('No overhead files.', '');
  else {
    out.push(
      'Source: `overhead/rep-<n>/{direct,gateway}-<profile>.json` (bench/run-baseline.sh). Added latency is the gateway run minus the direct-to-mock run, per repeat. Instant: no mock latency, non-streamed. Realistic: 200 ms to first token, streamed.',
      '',
      '| profile | repeats | added p50 | added p95 | added p99 |',
      '|---|---:|---|---|---|',
    );
    for (const p of PROFILES) {
      const rs = d.overhead[p];
      if (rs.length === 0) continue;
      out.push(`| ${p} | ${rs.length} | ${ms(spread(rs.map((r) => r.gateway.p50 - r.direct.p50)))} | ${ms(spread(rs.map((r) => r.gateway.p95 - r.direct.p95)))} | ${ms(spread(rs.map((r) => r.gateway.p99 - r.direct.p99)))} |`);
    }
    out.push('');
  }

  // Steady state and ceiling.
  out.push('## Ramp: throughput ceiling and breaking point', '');
  if (d.ramps.size === 0) out.push('No ramp files.', '');
  else {
    out.push(
      `Source: \`cluster/ramp-<n>i-<rep>.json\` (bench/k6/ramp.js, ${d.params.rampMeasureS} s measured per step). Ceiling: the last step with errors <= 1%, p95 <= 2x the first step's p95 and under 1% dropped iterations. Breaking point: the first step with p95 > 10x the first step's p95 or errors > 1%.`,
      '',
      '| instances | repeats | ceiling (req/s) | what stopped the ramp | breaking point (req/s) |',
      '|---:|---:|---|---|---|',
    );
    for (const [n, runs] of [...d.ramps].sort((a, b) => a[0] - b[0])) {
      const cs = runs.map((k) => ceiling(rampSteps(k)));
      const bs = runs.map((k) => breakingPoint(rampSteps(k)));
      const limits = [...new Set(cs.map((c) => c.limit))].sort().join(', ');
      const bk = bs.every((b) => b.rate !== null) ? num(spread(bs.map((b) => b.rate as number))) : `not reached in ${bs.filter((b) => b.rate === null).length} of ${bs.length}`;
      out.push(`| ${n} | ${runs.length} | ${num(spread(cs.map((c) => c.rate ?? 0)))} | ${limits} | ${bk} |`);
    }
    out.push('');
    for (const [n, runs] of [...d.ramps].sort((a, b) => a[0] - b[0])) {
      const stepsByRep = runs.map(rampSteps);
      const rates = [...new Set(stepsByRep.flatMap((s) => s.map((x) => x.rate)))].sort(byNumber);
      out.push(
        `Steps, ${n} instance${n === 1 ? '' : 's'}:`,
        '',
        '| offered req/s | achieved req/s | failed | dropped | p50 | p95 | p99 |',
        '|---:|---|---:|---:|---|---|---|',
      );
      for (const rate of rates) {
        const at = stepsByRep.map((s) => s.find((x) => x.rate === rate)).filter((x): x is RampStep => x !== undefined);
        const achieved = spread(at.map((x) => Math.round(x.requests / d.params.rampMeasureS)));
        out.push(
          `| ${rate} | ${num(achieved)} | ${sum(at.map((x) => x.failed))} | ${sum(at.map((x) => x.dropped))} | ${ms(spread(at.map((x) => x.p50)))} | ${ms(spread(at.map((x) => x.p95)))} | ${ms(spread(at.map((x) => x.p99)))} |`,
        );
      }
      out.push('');
    }
  }

  out.push('## Steady load at 60% of the ceiling', '');
  if (d.steady.size === 0) out.push('No steady files.', '');
  else {
    out.push('Source: `cluster/steady-<n>i-<rate>-<rep>.json`.', '', '| instances | req/s | repeats | requests | failed | p50 | p95 | p99 |', '|---:|---:|---:|---:|---:|---|---|---|');
    const keys = [...d.steady.keys()].sort((a, b) => {
      const [ai, ar] = a.split(/i-/).map(Number) as [number, number];
      const [bi, br] = b.split(/i-/).map(Number) as [number, number];
      return ai - bi || ar - br;
    });
    for (const key of keys) {
      const [inst, rate] = key.split(/i-/);
      const rs = d.steady.get(key)!.map((k) => slice(k, 'phase:measure'));
      out.push(
        `| ${inst} | ${rate} | ${rs.length} | ${sum(rs.map((r) => r.requests))} | ${sum(rs.map((r) => r.failed))} | ${ms(spread(rs.map((r) => r.p50)))} | ${ms(spread(rs.map((r) => r.p95)))} | ${ms(spread(rs.map((r) => r.p99)))} |`,
      );
    }
    out.push('');
  }

  out.push('## Spike', '');
  if (d.spikes.size === 0) out.push('No spike files.', '');
  else {
    out.push(
      `Source: \`cluster/spike-<n>i-<rep>.json\` (bench/k6/spike.js). Recovery: seconds after the spike until a ${d.params.spikeWindowS} s window has p95 within 1.5x the base p95 and no errors.`,
      '',
      '| instances | repeats | base p95 | spike p95 | failed in spike | dropped in spike | recovery (s) |',
      '|---:|---:|---|---|---:|---:|---|',
    );
    for (const [n, runs] of [...d.spikes].sort((a, b) => a[0] - b[0])) {
      const fs = runs.map((k) => spikeFigures(k, d.params.spikeWindowS));
      const rec = fs.every((f) => f.recoveryS !== null) ? num(spread(fs.map((f) => f.recoveryS as number))) : `not within the windows in ${fs.filter((f) => f.recoveryS === null).length} of ${fs.length}`;
      out.push(`| ${n} | ${fs.length} | ${ms(spread(fs.map((f) => f.baseP95)))} | ${ms(spread(fs.map((f) => f.spikeP95)))} | ${sum(fs.map((f) => f.spikeFailed))} | ${sum(fs.map((f) => f.spikeDropped))} | ${rec} |`);
    }
    out.push('');
  }

  out.push('## Correctness under concurrency (3 instances)', '');
  if (d.rateLimit.length + d.budget.length + d.failover.length === 0) out.push('No correctness files.', '');
  else {
    out.push('| check | runs | requests | over-limit or over-cap | worst run | result |', '|---|---:|---:|---:|---:|---|');
    if (d.rateLimit.length > 0) {
      const overs = d.rateLimit.map(overLimit);
      out.push(
        `| rate limit: admissions counted from the request log, bound = rpm + refill during the burst | ${d.rateLimit.length} | ${sum(d.rateLimit.map((r) => r.burst))} | ${sum(overs)} | ${Math.max(...overs)} | ${sum(overs) === 0 ? 'pass' : 'FAIL'} |`,
      );
    }
    for (const [label, runs] of [
      ['budget flood: tenants whose settled spend passed the cap', d.budget],
      ['budget flood with Redis restarted mid-run', d.failover],
    ] as const) {
      if (runs.length === 0) continue;
      const over = runs.map((r) => r.roundsOverCap);
      out.push(`| ${label} | ${runs.length} | ${sum(runs.map((r) => r.rounds * r.requestsPerRound))} | ${sum(over)} | ${Math.max(...over)} | ${sum(over) === 0 ? 'pass' : 'FAIL'} |`);
    }
    out.push('');
    if (d.rateLimit.length > 0) {
      const gap = d.rateLimit.filter((r) => r.admittedLog !== r.admittedK6).length;
      out.push(`Rate limit: the request log and the client agreed on the admitted count in ${d.rateLimit.length - gap} of ${d.rateLimit.length} runs. The log is the count used above.`, '');
    }
    const ledgerGap = [...d.budget, ...d.failover].filter((b) => b.ledgerRows !== b.admitted).length;
    if (d.budget.length + d.failover.length > 0) {
      out.push(`Budget: the ledger held a row for every admitted request in ${d.budget.length + d.failover.length - ledgerGap} of ${d.budget.length + d.failover.length} runs. Largest overshoot of a cap: ${Math.max(...[...d.budget, ...d.failover].map((b) => b.maxOvershootMicros))} micro-USD.`, '');
    }
  }

  out.push('## Superseded figures', '');
  if (d.superseded.length === 0) out.push('None recorded.', '');
  else {
    const idx = figureIndex(d);
    out.push('| figure | was | source | now | key |', '|---|---|---|---|---|');
    for (const s of d.superseded) out.push(`| ${s.label} | ${s.was} | ${s.source} | ${idx.get(s.replacedBy) ?? 'NOT IN THIS RUN'} | \`${s.replacedBy}\` |`);
    out.push('');
  }

  if (d.skipped.length > 0) out.push('## Not run on this base', '', ...d.skipped.map((l) => `- ${l}`), '');

  for (const a of d.appendices) {
    out.push(`## Scenario: ${a.name}`, '', a.text.trimEnd().replace(/^#/gm, '###'), '');
  }
  return out.join('\n');
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}
const files = (dir: string, re: RegExp) => (existsSync(dir) ? readdirSync(dir).filter((f) => re.test(f)).sort() : []);

function groupBy<K>(dir: string, re: RegExp, key: (m: RegExpExecArray) => K): Map<K, K6[]> {
  const g = new Map<K, K6[]>();
  for (const f of files(dir, re)) {
    const k = key(re.exec(f)!);
    g.set(k, [...(g.get(k) ?? []), readJson<K6>(join(dir, f))]);
  }
  return g;
}

export function load(dir: string): Data {
  const cluster = join(dir, 'cluster');
  const corr = join(dir, 'correctness');
  const jsons = <T>(re: RegExp) => files(corr, re).map((f) => readJson<T>(join(corr, f)));
  // Each scenario folder may hold its summary at the top or one per repeat (rep-<n>/).
  const appendices = readdirSync(dir)
    .sort()
    .filter((n) => statSync(join(dir, n)).isDirectory())
    .flatMap((n) =>
      [n, ...files(join(dir, n), /^rep-\d+$/).map((r) => `${n}/${r}`)].flatMap((rel) =>
        ['summary.md', 'latency.md']
          .filter((f) => existsSync(join(dir, rel, f)))
          .map((f) => ({ name: f === 'summary.md' ? rel : `${rel} (${f})`, text: readFileSync(join(dir, rel, f), 'utf8') })),
      ),
    );
  const overhead = { instant: [], realistic: [] } as Record<Profile, OverheadRep[]>;
  const overheadDir = join(dir, 'overhead');
  for (const rep of files(overheadDir, /^rep-\d+$/)) {
    for (const p of PROFILES) {
      const direct = join(overheadDir, rep, `direct-${p}.json`);
      const gateway = join(overheadDir, rep, `gateway-${p}.json`);
      if (existsSync(direct) && existsSync(gateway)) {
        overhead[p].push({ direct: slice(readJson<K6>(direct), 'phase:measure'), gateway: slice(readJson<K6>(gateway), 'phase:measure') });
      }
    }
  }
  return {
    overhead,
    skipped: existsSync(join(dir, 'skipped.txt')) ? readFileSync(join(dir, 'skipped.txt'), 'utf8').split('\n').filter((l) => l !== '') : [],
    params: readJson<Params>(join(dir, 'params.json')),
    conditions: ['hardware.txt', 'conditions.txt'].filter((f) => existsSync(join(dir, f))).map((f) => readFileSync(join(dir, f), 'utf8').trimEnd()).join('\n\n') || null,
    ramps: groupBy(cluster, /^ramp-(\d+)i-\d+\.json$/, (m) => Number(m[1])),
    steady: groupBy(cluster, /^steady-(\d+)i-(\d+)-\d+\.json$/, (m) => steadyKey(Number(m[1]), Number(m[2]))),
    spikes: groupBy(cluster, /^spike-(\d+)i-\d+\.json$/, (m) => Number(m[1])),
    rateLimit: jsons<RateLimitRun>(/^ratelimit-\d+\.json$/),
    budget: jsons<BudgetRun>(/^budget-\d+\.json$/),
    failover: jsons<BudgetRun>(/^budget-failover-\d+\.json$/),
    superseded: existsSync(join(dir, 'superseded.json')) ? readJson<Superseded[]>(join(dir, 'superseded.json')) : [],
    appendices,
  };
}

/** The req/s to hold for the steady runs: `fraction` of the lowest repeat's ceiling, rounded down. */
export function steadyRate(d: Data, instances: number, fraction: number): number {
  const runs = d.ramps.get(instances);
  if (!runs || runs.length === 0) throw new Error(`no ramp files for ${instances} instance(s)`);
  const cs = runs.map((k) => ceiling(rampSteps(k)).rate);
  if (cs.some((c) => c === null)) throw new Error('a ramp never passed its first step; no ceiling to take a fraction of');
  return Math.floor(Math.min(...(cs as number[])) * fraction);
}

if (import.meta.main) {
  const [a, b, c, f] = process.argv.slice(2);
  if (a === 'ceiling') {
    if (!b || !c) throw new Error('usage: node bench/final-summary.ts ceiling <final-dir> <instances> [fraction]');
    console.log(steadyRate(load(b), Number(c), f ? Number(f) : 0.6));
  } else if (a) {
    writeFileSync(join(a, 'summary.md'), render(load(a)));
    console.log(`wrote ${join(a, 'summary.md')}`);
  } else {
    throw new Error('usage: node bench/final-summary.ts <final-dir>');
  }
}
