// The semantic cache's threshold, measured. For labelled pairs of prompts it asks: at each similarity threshold,
// how many paraphrases would the cache serve (hit rate), and how many of the answers it serves belong to a
// different question (wrong-answer rate)? Four ways, side by side, so the effect of each choice is visible:
//
//   pairwise       the pair (a, b) alone: the answer of `a` is cached, the request is `b`.
//   nn             store-wide nearest neighbour, as production runs: the store holds the `a` of every pair, each
//                  `b` is looked up in it, and what is served is whatever entry is nearest, not necessarily its own `a`.
//   +guards        the same, but the nearest entry must also pass the guards (numbers, quotes, names, negation,
//                  content words) before it is served, exactly as the gateway applies them.
//
//   node --env-file-if-exists=.env.local bench/semantic/eval.ts --qqp 6000 --paws 4000 --embedders local,voyage
//
// A served answer is right only when the pair is a duplicate and the entry served is the pair's own `a` (or the identical
// text of `b`); any other entry served counts as wrong, because the data does not label the
// other entries against `b` (conservative). The threshold is chosen on the dev half, by nearest neighbour with
// guards, and every reported figure is from the test half.
// Cross-model: `b` embedded by one model and `a` by the other (an API query against a local entry, and back).
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, appendFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { loadConfig } from '../../packages/gateway/src/config.ts';
import { localEmbedder, unit, voyageEmbedder, type Embedder } from '../../packages/gateway/src/semantic/embedder.ts';
import { failedGuard, GUARD_RULES, guardSignature, type GuardOptions, type GuardRule, type GuardSignature } from '../../packages/gateway/src/semantic/guards.ts';
import { DATASETS, loadPairs, type Pair, type Source } from './datasets.ts';

/** 0.80, 0.81, ... 0.99 as whole percents, so no threshold is a float sum. */
export const THRESHOLDS = Array.from({ length: 20 }, (_, i) => 80 + i);

export interface Scored {
  /** Cosine similarity of the request to the candidate entry. */
  sim: number;
  /** The request's pair is a duplicate: what the hit rate is a share of. */
  duplicate: boolean;
  source: Source;
  /** Serving the candidate gives a right answer (only a duplicate pair can be answered right). Absent: right exactly when the pair is a duplicate. */
  right?: boolean;
  /** The first guard that refuses the candidate; absent when they all pass. */
  guard?: GuardRule | undefined;
}

export interface CurveRow {
  /** Whole percent: 95 is a threshold of 0.95. */
  threshold: number;
  /** Requests served at or above the threshold (and past the guards, when they are on). */
  served: number;
  /** Served requests whose answer is right. */
  hits: number;
  /** Served requests whose answer belongs to a different question. */
  wrong: number;
  /** Duplicate pairs in the set: what the hit rate is a share of. */
  duplicates: number;
  /** hits / duplicates. */
  hitRate: number;
  /** wrong / served; null when nothing is served. */
  wrongRate: number | null;
}

export function curve(items: readonly Scored[], thresholds: readonly number[] = THRESHOLDS, o: { guards?: boolean } = {}): CurveRow[] {
  const duplicates = items.filter((i) => i.duplicate).length;
  return thresholds.map((threshold) => {
    const cut = threshold / 100;
    const served = items.filter((i) => i.sim >= cut && (!o.guards || i.guard === undefined));
    // A hit is a right answer to a duplicate pair, so hits and duplicates are counted over the same population.
    const hits = served.filter((i) => i.duplicate && (i.right ?? true)).length;
    const wrong = served.length - hits;
    if (hits > duplicates) throw new Error(`hit rate above 1: ${hits} hits of ${duplicates} duplicates`);
    return {
      threshold,
      served: served.length,
      hits,
      wrong,
      duplicates,
      hitRate: duplicates === 0 ? 0 : hits / duplicates,
      wrongRate: served.length === 0 ? null : wrong / served.length,
    };
  });
}

/**
 * The threshold that serves the most right answers while no more than `maxWrongRate` of what it serves is wrong.
 * Rows are the dev curve. A tie goes to the higher threshold. Undefined when no threshold serves anything within
 * the budget.
 */
export function pickThreshold(rows: readonly CurveRow[], maxWrongRate: number): CurveRow | undefined {
  let best: CurveRow | undefined;
  for (const r of rows) {
    if (r.hits === 0 || r.wrongRate === null || r.wrongRate > maxWrongRate) continue;
    if (best === undefined || r.hits > best.hits || (r.hits === best.hits && r.threshold > best.threshold)) best = r;
  }
  return best;
}

/**
 * When no threshold meets the budget: the threshold with the lowest wrong rate among those that still serve at
 * least `minHitRate` of the duplicates. A tie goes to the higher hit rate, then to the higher threshold. Undefined when none serves that many.
 */
export function recommendThreshold(rows: readonly CurveRow[], minHitRate: number): CurveRow | undefined {
  let best: CurveRow | undefined;
  for (const r of rows) {
    if (r.wrongRate === null || r.hitRate < minHitRate) continue;
    if (best === undefined || r.wrongRate < best.wrongRate! || (r.wrongRate === best.wrongRate && r.hitRate >= best.hitRate)) best = r;
  }
  return best;
}

const dot = (a: readonly number[], b: readonly number[]) => {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i]! * b[i]!;
  return s;
};

export type Vectors = Map<string, number[]>;

/** The guards' view of a prompt, computed once per text. */
export function signer(): (text: string) => GuardSignature {
  const memo = new Map<string, GuardSignature>();
  return (text) => {
    let sig = memo.get(text);
    if (!sig) memo.set(text, (sig = guardSignature(text)));
    return sig;
  };
}

/** Pairwise: cosine similarity of each pair, `b` from `queryVectors` and `a` from `entryVectors`, and the guards' verdict on the pair. */
export function score(pairs: readonly Pair[], queryVectors: Vectors, entryVectors: Vectors, guard?: GuardOptions, sig: (t: string) => GuardSignature = signer()): Scored[] {
  return pairs.map((p) => {
    const q = queryVectors.get(p.b);
    const e = entryVectors.get(p.a);
    if (!q || !e) throw new Error(`no vector for pair ${p.id}`);
    const refused = guard ? failedGuard(sig(p.a), sig(p.b), guard) : undefined;
    return { sim: dot(q, e), duplicate: p.duplicate, source: p.source, guard: refused };
  });
}

/**
 * Store-wide nearest neighbour, as the gateway looks up: the store holds the distinct `a` of `pairs`, each pair's
 * `b` is asked of it, and the entry nearest to `b` is the candidate, whichever pair it came from. It is a right
 * answer only when the pair is a duplicate and the entry is its own `a` or the identical text of `b`. Ties go to the
 * earlier entry.
 */
export function scoreNearest(pairs: readonly Pair[], queryVectors: Vectors, entryVectors: Vectors, guard?: GuardOptions, sig: (t: string) => GuardSignature = signer()): Scored[] {
  const texts = [...new Set(pairs.map((p) => p.a))];
  const dims = entryVectors.get(texts[0] ?? '')?.length ?? 0;
  const flat = new Float32Array(texts.length * dims);
  texts.forEach((t, i) => {
    const v = entryVectors.get(t);
    if (!v) throw new Error('no vector for an entry');
    flat.set(v, i * dims);
  });
  return pairs.map((p) => {
    const q = queryVectors.get(p.b);
    if (!q) throw new Error(`no vector for pair ${p.id}`);
    const qf = Float32Array.from(q);
    let best = -1;
    let bestSim = -Infinity;
    for (let i = 0; i < texts.length; i++) {
      let d = 0;
      const o = i * dims;
      for (let k = 0; k < dims; k++) d += qf[k]! * flat[o + k]!;
      if (d > bestSim) {
        bestSim = d;
        best = i;
      }
    }
    const entry = texts[best];
    if (entry === undefined) throw new Error('empty store');
    const refused = guard ? failedGuard(sig(entry), sig(p.b), guard) : undefined;
    return { sim: bestSim, duplicate: p.duplicate, source: p.source, right: p.duplicate && (entry === p.a || entry === p.b), guard: refused };
  });
}

// ---- embedding, with a file cache so a long run on a slow machine can be resumed -----------------------------

const textKey = (t: string) => createHash('sha1').update(t).digest('hex');

export async function embedAll(
  embedder: Embedder,
  texts: readonly string[],
  o: { concurrency: number; cacheFile?: string; log?: (m: string) => void },
): Promise<Vectors> {
  const out: Vectors = new Map();
  const cached = new Map<string, number[]>();
  if (o.cacheFile && existsSync(o.cacheFile)) {
    for (const line of readFileSync(o.cacheFile, 'utf8').split('\n')) {
      if (!line) continue;
      const { t, v } = JSON.parse(line) as { t: string; v: number[] };
      cached.set(t, v);
    }
  }
  const todo = [...new Set(texts)];
  let next = 0;
  let done = 0;
  const failures: string[] = [];
  const worker = async () => {
    for (;;) {
      const i = next++;
      if (i >= todo.length) return;
      const text = todo[i]!;
      const key = textKey(text);
      let v = cached.get(key);
      if (!v) {
        // A patient call; one retry, because a model that is still loading answers the first request late.
        const got = (await embedder.embed(text, { patient: true })) ?? (await embedder.embed(text, { patient: true }));
        if (!got) {
          failures.push(text);
          continue;
        }
        v = got.vector;
        if (o.cacheFile) appendFileSync(o.cacheFile, `${JSON.stringify({ t: key, v: v.map((x) => Number(x.toPrecision(7))) })}\n`);
      }
      out.set(text, v);
      done += 1;
      if (done % 500 === 0) o.log?.(`  embedded ${done}/${todo.length}`);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, o.concurrency) }, worker));
  if (failures.length > 0) throw new Error(`${failures.length} of ${todo.length} texts could not be embedded; not reporting on a partial set`);
  return out;
}

/** A bag-of-words hash embedder for smoke runs without a model. Word order does not matter to it, as to no real model worth its price. */
export function hashEmbedder(dimensions = 1024): Embedder {
  return {
    async embed(text) {
      const v = new Array<number>(dimensions).fill(0);
      for (const w of text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []) {
        v[createHash('md5').update(w).digest().readUInt32BE(0) % dimensions]! += 1;
      }
      const vector = unit(v);
      return vector ? { vector, embedder: 'stub-hash' } : undefined;
    },
  };
}

// ---- the evaluation ---------------------------------------------------------------------------------------

export const MODES = ['pairwise', 'pairwise+guards', 'nn', 'nn+guards'] as const;
export type Mode = (typeof MODES)[number];
type Curves = Record<Mode, CurveRow[]>;

export interface EvalInput {
  dev: readonly Pair[];
  test: readonly Pair[];
  /** name -> vectors of every text, per input type: vectors[inputType][embedder]. */
  vectors: Record<string, Record<string, Vectors>>;
  /** The most wrong answers among those served that is allowed (0.01). */
  maxWrongRate: number;
  /** The guards the gateway would run. */
  guard: GuardOptions;
  /** When no threshold meets the budget: the least share of duplicates a recommended threshold must still serve. */
  minHitRate: number;
}

export interface Picked {
  threshold: number;
  dev: CurveRow;
  test: CurveRow;
  testBySource: Record<string, CurveRow>;
  /** Test requests whose nearest entry was at or above the threshold and refused by each guard. */
  refusedBy: Record<GuardRule, number>;
}

export interface ComboResult {
  inputType: string;
  query: string;
  entry: string;
  kind: 'same-model' | 'cross-model';
  dev: Curves;
  test: Curves;
  testBySource: Record<string, Curves>;
  /** Chosen on dev by nearest neighbour with guards, within the budget; undefined when nothing fits. */
  chosen: Picked | undefined;
  /** When nothing fits the budget: the lowest wrong rate that still serves `minHitRate` of the duplicates. */
  recommended: Picked | undefined;
  /** The test row (nearest neighbour with guards) at the threshold chosen for the query model's same-model curve (cross-model only). */
  atSameModelThreshold?: CurveRow | undefined;
}

function curvesOf(sets: { pairwise: readonly Scored[]; nn: readonly Scored[] }): Curves {
  return {
    pairwise: curve(sets.pairwise),
    'pairwise+guards': curve(sets.pairwise, THRESHOLDS, { guards: true }),
    nn: curve(sets.nn),
    'nn+guards': curve(sets.nn, THRESHOLDS, { guards: true }),
  };
}

export function evaluate(input: EvalInput): ComboResult[] {
  const results: ComboResult[] = [];
  const sig = signer();
  for (const [inputType, byEmbedder] of Object.entries(input.vectors)) {
    const names = Object.keys(byEmbedder);
    for (const query of names) {
      for (const entry of names) {
        const q = byEmbedder[query]!;
        const e = byEmbedder[entry]!;
        const sets = (pairs: readonly Pair[]) => ({ pairwise: score(pairs, q, e, input.guard, sig), nn: scoreNearest(pairs, q, e, input.guard, sig) });
        const devSets = sets(input.dev);
        const testSets = sets(input.test);
        const dev = curvesOf(devSets);
        const test = curvesOf(testSets);
        const sources = [...new Set(testSets.nn.map((s) => s.source))];
        const testBySource: Record<string, Curves> = {};
        for (const source of sources) {
          testBySource[source] = curvesOf({ pairwise: testSets.pairwise.filter((i) => i.source === source), nn: testSets.nn.filter((i) => i.source === source) });
        }
        const picked = (row: CurveRow | undefined): Picked | undefined => {
          if (!row) return undefined;
          const at = (rows: readonly CurveRow[]) => rows.find((r) => r.threshold === row.threshold)!;
          const refusedBy = Object.fromEntries(GUARD_RULES.map((r) => [r, 0])) as Record<GuardRule, number>;
          for (const i of testSets.nn) if (i.sim >= row.threshold / 100 && i.guard) refusedBy[i.guard] += 1;
          return {
            threshold: row.threshold,
            dev: row,
            test: at(test['nn+guards']),
            testBySource: Object.fromEntries(sources.map((s) => [s, at(testBySource[s]!['nn+guards'])])),
            refusedBy,
          };
        };
        const chosenRow = pickThreshold(dev['nn+guards'], input.maxWrongRate);
        results.push({
          inputType,
          query,
          entry,
          kind: query === entry ? 'same-model' : 'cross-model',
          dev,
          test,
          testBySource,
          chosen: picked(chosenRow),
          recommended: chosenRow ? undefined : picked(recommendThreshold(dev['nn+guards'], input.minHitRate)),
        });
      }
    }
  }
  // A cross-model pair is judged at the threshold the query model's own index would use.
  for (const r of results) {
    if (r.kind !== 'cross-model') continue;
    const own = results.find((x) => x.inputType === r.inputType && x.query === r.query && x.entry === r.query);
    const t = own?.chosen?.threshold ?? own?.recommended?.threshold;
    if (t !== undefined) r.atSameModelThreshold = r.test['nn+guards'].find((c) => c.threshold === t);
  }
  return results;
}

// ---- report -----------------------------------------------------------------------------------------------

const pct = (x: number | null, dp = 2) => (x === null ? 'n/a' : `${(x * 100).toFixed(dp)}%`);
const th = (t: number) => (t / 100).toFixed(2);

export interface RunInfo {
  qqp: number;
  paws: number;
  seed: number;
  dev: number;
  test: number;
  devDuplicates: number;
  testDuplicates: number;
  embedders: string[];
  inputTypes: string[];
  maxWrongRate: number;
  minHitRate: number;
  guard: GuardOptions;
  conditions: string;
}

const MODE_LABEL: Record<Mode, string> = { pairwise: 'pairwise', 'pairwise+guards': 'pairwise + guards', nn: 'nearest neighbour', 'nn+guards': 'nearest neighbour + guards' };

export function renderSummary(info: RunInfo, results: readonly ComboResult[]): string {
  const L: string[] = ['# Semantic cache evaluation', ''];
  L.push(
    `Sampled ${info.qqp} QQP and ${info.paws} PAWS pairs (seed ${info.seed}); dev ${info.dev} pairs (${info.devDuplicates} duplicates), test ${info.test} pairs (${info.testDuplicates} duplicates). Every figure below is on test; the threshold was chosen on dev.`,
    '',
    `How it is measured. *Pairwise* looks at each pair alone. *Nearest neighbour* is how the gateway looks up: the store holds the first prompt of every pair, each second prompt is asked of it, and the nearest entry is the candidate. A served answer is right only when the pair is a duplicate and the entry is that pair's own first prompt (or the identical text); any other entry served counts as wrong. *Guards* refuse a candidate whose numbers, quoted strings, names or negation words differ from the request's${info.guard.tokenSet ? `, or whose content words differ by more than ${info.guard.maxDiff} (symmetric difference)` : ' (the content-word guard is off)'}. Hit rate is the share of duplicate pairs served right; wrong rate is the share of served answers that are wrong.`,
    '',
    `Threshold selection: nearest neighbour with guards, on dev: the most right answers served with at most ${pct(info.maxWrongRate, 1)} of served answers wrong. When no threshold fits that budget the table says so and recommends the threshold with the lowest wrong rate among those that still serve at least ${pct(info.minHitRate, 0)} of the duplicates.`,
    '',
    `Embedders: ${info.embedders.join(', ')}. Input types: ${info.inputTypes.join(', ')}. Conditions: ${info.conditions}.`,
    '',
    `Data: QQP sha256 ${DATASETS.qqp.sha256} (${DATASETS.qqp.licence}); PAWS-Wiki labeled_final test sha256 ${DATASETS.paws.sha256} (${DATASETS.paws.licence}).`,
    '',
  );
  L.push('## Chosen threshold per combination (nearest neighbour with guards)', '');
  L.push('| input type | query model | entry model | kind | outcome | threshold | hit rate | wrong rate | served | wrong | PAWS wrong rate | QQP wrong rate |');
  L.push('|---|---|---|---|---|---|---|---|---|---|---|---|');
  for (const r of results) {
    const c = r.chosen ?? r.recommended;
    const head = `| ${r.inputType} | ${r.query} | ${r.entry} | ${r.kind} |`;
    if (!c) {
      L.push(`${head} no threshold fits the budget, and none serves ${pct(info.minHitRate, 0)} of duplicates | | | | | | | |`);
      continue;
    }
    L.push(
      `${head} ${r.chosen ? `meets ${pct(info.maxWrongRate, 1)}` : `**none meets ${pct(info.maxWrongRate, 1)}**; recommended: lowest wrong rate with hit rate at least ${pct(info.minHitRate, 0)}`} | ${th(c.threshold)} | ${pct(c.test.hitRate)} | ${pct(c.test.wrongRate)} | ${c.test.served} | ${c.test.wrong} | ${pct(c.testBySource.paws?.wrongRate ?? null)} | ${pct(c.testBySource.qqp?.wrongRate ?? null)} |`,
    );
  }
  L.push('', '## What the guards refuse at that threshold (test, nearest entry at or above it)', '');
  L.push(`| input type | query model | entry model | threshold | ${GUARD_RULES.join(' | ')} |`, `|---|---|---|---|${GUARD_RULES.map(() => '---').join('|')}|`);
  for (const r of results) {
    const c = r.chosen ?? r.recommended;
    if (c) L.push(`| ${r.inputType} | ${r.query} | ${r.entry} | ${th(c.threshold)} | ${GUARD_RULES.map((g) => c.refusedBy[g]).join(' | ')} |`);
  }
  L.push('', '## At 0.95 with and without the guards (test)', '');
  L.push(`| input type | query model | entry model | source | ${MODES.map((m) => `${MODE_LABEL[m]}: hit / wrong`).join(' | ')} |`, `|---|---|---|---|${MODES.map(() => '---').join('|')}|`);
  const at95 = (rows: readonly CurveRow[]) => rows.find((c) => c.threshold === 95);
  for (const r of results) {
    for (const [source, curves] of [['all', r.test], ...Object.entries(r.testBySource)] as Array<[string, Curves]>) {
      L.push(`| ${r.inputType} | ${r.query} | ${r.entry} | ${source} | ${MODES.map((m) => { const row = at95(curves[m]); return row ? `${pct(row.hitRate)} / ${pct(row.wrongRate)}` : 'n/a'; }).join(' | ')} |`);
    }
  }
  const cross = results.filter((r) => r.kind === 'cross-model' && r.atSameModelThreshold);
  if (cross.length > 0) {
    L.push('', "## Cross-model at the query model's own threshold (nearest neighbour with guards)", '');
    L.push('| input type | query model | entry model | threshold | hit rate | wrong rate | served | wrong |');
    L.push('|---|---|---|---|---|---|---|---|');
    for (const r of cross) {
      const row = r.atSameModelThreshold!;
      L.push(`| ${r.inputType} | ${r.query} | ${r.entry} | ${th(row.threshold)} | ${pct(row.hitRate)} | ${pct(row.wrongRate)} | ${row.served} | ${row.wrong} |`);
    }
  }
  for (const r of results) {
    for (const [source, curves] of [['all', r.test], ...Object.entries(r.testBySource)] as Array<[string, Curves]>) {
      L.push('', `## Curve (test, ${source}): ${r.inputType}, ${r.query} query vs ${r.entry} entry`, '');
      L.push(`| threshold | ${MODES.map((m) => `${MODE_LABEL[m]}: served / hit / wrong`).join(' | ')} |`, `|---|${MODES.map(() => '---').join('|')}|`);
      THRESHOLDS.forEach((t, i) => {
        L.push(`| ${th(t)} | ${MODES.map((m) => { const c = curves[m][i]!; return `${c.served} / ${pct(c.hitRate)} / ${pct(c.wrongRate)}`; }).join(' | ')} |`);
      });
    }
  }
  return `${L.join('\n')}\n`;
}

// ---- command line -----------------------------------------------------------------------------------------

async function main() {
  const { values } = parseArgs({
    options: {
      qqp: { type: 'string', default: '6000' },
      paws: { type: 'string', default: '4000' },
      seed: { type: 'string', default: '42' },
      embedders: { type: 'string', default: 'local' },
      'input-types': { type: 'string', default: 'none' },
      budget: { type: 'string', default: '0.01' },
      'min-hit-rate': { type: 'string', default: '0.05' },
      concurrency: { type: 'string', default: '4' },
      dir: { type: 'string', default: resolve(import.meta.dirname, '../../.datasets') },
      out: { type: 'string', default: resolve(import.meta.dirname, '../results/pr-9') },
      conditions: { type: 'string', default: 'not recorded' },
    },
  });
  const config = loadConfig();
  const log = (m: string) => console.error(m);
  const names = values.embedders!.split(',');
  const inputTypes = values['input-types']!.split(',');
  const build = (name: string, inputType: 'none' | 'query'): Embedder => {
    if (name === 'stub') return hashEmbedder(config.semanticDimensions);
    if (name === 'local') {
      return localEmbedder({ baseUrl: config.ollamaUrl, model: config.semanticLocalModel, dimensions: config.semanticDimensions, timeoutMs: 60_000, inputType });
    }
    if (name === 'voyage') {
      if (!config.voyageApiKey) throw new Error('VOYAGE_API_KEY is not set');
      return voyageEmbedder({ apiKey: config.voyageApiKey, baseUrl: config.voyageBaseUrl, model: config.voyageModel, dimensions: config.semanticDimensions, timeoutMs: 30_000, inputType });
    }
    throw new Error(`unknown embedder "${name}" (local, voyage, stub)`);
  };

  const { dev, test } = await loadPairs({ dir: values.dir!, qqp: Number(values.qqp), paws: Number(values.paws), seed: Number(values.seed), log });
  const texts = [...dev, ...test].flatMap((p) => [p.a, p.b]);
  mkdirSync(values.dir!, { recursive: true });
  const vectors: EvalInput['vectors'] = {};
  for (const inputType of inputTypes) {
    if (inputType !== 'none' && inputType !== 'query') throw new Error(`unknown input type "${inputType}"`);
    vectors[inputType] = {};
    for (const name of names) {
      log(`embedding ${texts.length} texts: ${name}, input type ${inputType}`);
      const cacheFile = name === 'stub' ? undefined : join(values.dir!, `emb-${name}-${inputType}.jsonl`);
      vectors[inputType]![name] = await embedAll(build(name, inputType), texts, { concurrency: Number(values.concurrency), ...(cacheFile ? { cacheFile } : {}), log });
    }
  }
  const maxWrongRate = Number(values.budget);
  const guard: GuardOptions = { tokenSet: config.semanticGuardTokenSet, maxDiff: config.semanticGuardMaxDiff };
  const minHitRate = Number(values['min-hit-rate']);
  const results = evaluate({ dev, test, vectors, maxWrongRate, guard, minHitRate });
  const info: RunInfo = {
    qqp: Number(values.qqp),
    paws: Number(values.paws),
    seed: Number(values.seed),
    dev: dev.length,
    test: test.length,
    devDuplicates: dev.filter((p) => p.duplicate).length,
    testDuplicates: test.filter((p) => p.duplicate).length,
    embedders: names,
    inputTypes,
    maxWrongRate,
    minHitRate,
    guard,
    conditions: values.conditions!,
  };
  mkdirSync(values.out!, { recursive: true });
  writeFileSync(join(values.out!, 'eval.json'), `${JSON.stringify({ info, results }, null, 2)}\n`);
  writeFileSync(join(values.out!, 'summary.md'), renderSummary(info, results));
  console.log(`wrote ${join(values.out!, 'summary.md')}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err: unknown) => {
    console.error(`eval failed: ${(err as Error).message}`);
    process.exit(1);
  });
}
