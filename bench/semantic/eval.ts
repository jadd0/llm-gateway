// The semantic cache's threshold, measured. For labelled pairs of prompts it asks: at each similarity threshold,
// how many paraphrases would the cache serve (hit rate), and how many of the answers it serves belong to a
// different question (wrong-answer rate)?
//
//   node --env-file-if-exists=.env.local bench/semantic/eval.ts --qqp 6000 --paws 4000 --embedders local,voyage
//
// A pair is (a, b): `a` is the prompt whose answer is in the cache, `b` the new request. The pair is served when
// cosine(b, a) is at or above the threshold; it is a right answer when the pair is a duplicate and a wrong answer
// when it is not. The threshold is chosen on the dev half and every reported figure is from the test half.
// Cross-model: `b` embedded by one model and `a` by the other (an API query against a local entry, and back).
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, appendFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { loadConfig } from '../../packages/gateway/src/config.ts';
import { localEmbedder, unit, voyageEmbedder, type Embedder } from '../../packages/gateway/src/semantic/embedder.ts';
import { DATASETS, loadPairs, type Pair, type Source } from './datasets.ts';

/** 0.80, 0.81, ... 0.99 as whole percents, so no threshold is a float sum. */
export const THRESHOLDS = Array.from({ length: 20 }, (_, i) => 80 + i);

export interface Scored {
  sim: number;
  duplicate: boolean;
  source: Source;
}

export interface CurveRow {
  /** Whole percent: 95 is a threshold of 0.95. */
  threshold: number;
  /** Pairs at or above the threshold. */
  served: number;
  /** Served pairs that are duplicates: right answers. */
  hits: number;
  /** Served pairs that are not duplicates: another question's answer. */
  wrong: number;
  /** Duplicate pairs in the set: what the hit rate is a share of. */
  duplicates: number;
  /** hits / duplicates. */
  hitRate: number;
  /** wrong / served; null when nothing is served. */
  wrongRate: number | null;
}

export function curve(items: readonly Scored[], thresholds: readonly number[] = THRESHOLDS): CurveRow[] {
  const duplicates = items.filter((i) => i.duplicate).length;
  return thresholds.map((threshold) => {
    const cut = threshold / 100;
    const served = items.filter((i) => i.sim >= cut);
    const hits = served.filter((i) => i.duplicate).length;
    const wrong = served.length - hits;
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

const dot = (a: readonly number[], b: readonly number[]) => {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i]! * b[i]!;
  return s;
};

export type Vectors = Map<string, number[]>;

/** Cosine similarity of each pair, `b` from `queryVectors` and `a` from `entryVectors`. */
export function score(pairs: readonly Pair[], queryVectors: Vectors, entryVectors: Vectors): Scored[] {
  return pairs.map((p) => {
    const q = queryVectors.get(p.b);
    const e = entryVectors.get(p.a);
    if (!q || !e) throw new Error(`no vector for pair ${p.id}`);
    return { sim: dot(q, e), duplicate: p.duplicate, source: p.source };
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

export interface EvalInput {
  dev: readonly Pair[];
  test: readonly Pair[];
  /** name -> vectors of every text, per input type: vectors[inputType][embedder]. */
  vectors: Record<string, Record<string, Vectors>>;
  /** The most wrong answers among those served that is allowed (0.01). */
  maxWrongRate: number;
}

export interface ComboResult {
  inputType: string;
  query: string;
  entry: string;
  kind: 'same-model' | 'cross-model';
  devCurve: CurveRow[];
  testCurve: CurveRow[];
  /** Chosen on dev; undefined when nothing fits the budget. */
  chosen: { threshold: number; dev: CurveRow; test: CurveRow; testBySource: Record<string, CurveRow> } | undefined;
  /** The test row at the threshold chosen for the query model's same-model curve (cross-model only). */
  atSameModelThreshold?: CurveRow | undefined;
}

export function evaluate(input: EvalInput): ComboResult[] {
  const results: ComboResult[] = [];
  for (const [inputType, byEmbedder] of Object.entries(input.vectors)) {
    const names = Object.keys(byEmbedder);
    for (const query of names) {
      for (const entry of names) {
        const q = byEmbedder[query]!;
        const e = byEmbedder[entry]!;
        const dev = score(input.dev, q, e);
        const test = score(input.test, q, e);
        const devCurve = curve(dev);
        const testCurve = curve(test);
        const pick = pickThreshold(devCurve, input.maxWrongRate);
        const at = (t: number) => testCurve.find((r) => r.threshold === t)!;
        const bySource: Record<string, CurveRow> = {};
        if (pick) {
          for (const source of new Set(test.map((s) => s.source))) {
            bySource[source] = curve(test.filter((s) => s.source === source)).find((r) => r.threshold === pick.threshold)!;
          }
        }
        results.push({
          inputType,
          query,
          entry,
          kind: query === entry ? 'same-model' : 'cross-model',
          devCurve,
          testCurve,
          chosen: pick ? { threshold: pick.threshold, dev: pick, test: at(pick.threshold), testBySource: bySource } : undefined,
        });
      }
    }
  }
  // A cross-model pair is judged at the threshold the query model's own index would use.
  for (const r of results) {
    if (r.kind !== 'cross-model') continue;
    const own = results.find((x) => x.inputType === r.inputType && x.query === r.query && x.entry === r.query);
    if (own?.chosen) r.atSameModelThreshold = r.testCurve.find((c) => c.threshold === own.chosen!.threshold);
  }
  return results;
}

// ---- report -----------------------------------------------------------------------------------------------

const pct = (x: number | null, dp = 2) => (x === null ? 'n/a' : `${(x * 100).toFixed(dp)}%`);

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
  conditions: string;
}

export function renderSummary(info: RunInfo, results: readonly ComboResult[]): string {
  const L: string[] = ['# Semantic cache evaluation', ''];
  L.push(
    `Sampled ${info.qqp} QQP and ${info.paws} PAWS pairs (seed ${info.seed}); dev ${info.dev} pairs (${info.devDuplicates} duplicates), test ${info.test} pairs (${info.testDuplicates} duplicates). Threshold chosen on dev as the most right answers served with at most ${pct(info.maxWrongRate, 1)} of served answers wrong; every figure below is on test.`,
    '',
    `Embedders: ${info.embedders.join(', ')}. Input types: ${info.inputTypes.join(', ')}. Conditions: ${info.conditions}.`,
    '',
    `Data: QQP sha256 ${DATASETS.qqp.sha256} (${DATASETS.qqp.licence}); PAWS-Wiki labeled_final test sha256 ${DATASETS.paws.sha256} (${DATASETS.paws.licence}).`,
    '',
  );
  L.push('## Chosen threshold per combination', '');
  L.push('| input type | query model | entry model | kind | threshold | hit rate | wrong rate | served | wrong | PAWS wrong rate | QQP wrong rate |');
  L.push('|---|---|---|---|---|---|---|---|---|---|---|');
  for (const r of results) {
    const c = r.chosen;
    if (!c) {
      L.push(`| ${r.inputType} | ${r.query} | ${r.entry} | ${r.kind} | none within budget | | | | | | |`);
      continue;
    }
    L.push(
      `| ${r.inputType} | ${r.query} | ${r.entry} | ${r.kind} | ${(c.threshold / 100).toFixed(2)} | ${pct(c.test.hitRate)} | ${pct(c.test.wrongRate)} | ${c.test.served} | ${c.test.wrong} | ${pct(c.testBySource.paws?.wrongRate ?? null)} | ${pct(c.testBySource.qqp?.wrongRate ?? null)} |`,
    );
  }
  const cross = results.filter((r) => r.kind === 'cross-model' && r.atSameModelThreshold);
  if (cross.length > 0) {
    L.push('', '## Cross-model at the query model\'s own threshold', '');
    L.push('| input type | query model | entry model | threshold | hit rate | wrong rate | served | wrong |');
    L.push('|---|---|---|---|---|---|---|---|');
    for (const r of cross) {
      const row = r.atSameModelThreshold!;
      L.push(`| ${r.inputType} | ${r.query} | ${r.entry} | ${(row.threshold / 100).toFixed(2)} | ${pct(row.hitRate)} | ${pct(row.wrongRate)} | ${row.served} | ${row.wrong} |`);
    }
  }
  for (const r of results) {
    L.push('', `## Curve (test): ${r.inputType}, ${r.query} query vs ${r.entry} entry`, '');
    L.push('| threshold | served | hits | wrong | hit rate | wrong rate |', '|---|---|---|---|---|---|');
    for (const c of r.testCurve) L.push(`| ${(c.threshold / 100).toFixed(2)} | ${c.served} | ${c.hits} | ${c.wrong} | ${pct(c.hitRate)} | ${pct(c.wrongRate)} |`);
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
  const results = evaluate({ dev, test, vectors, maxWrongRate });
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
