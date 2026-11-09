// HNSW against IVFFlat against no vector index, on the query the gateway runs: the nearest stored prompt among
// the rows of one scope and one context.
//
//   node --env-file-if-exists=.env.local bench/semantic/index-bench.ts --sizes 10000,100000 --vectors local
//
// For each table size and each variant it builds the index (build seconds, size on disk), then runs the same
// held-out queries and reports recall@1 against the exact answer and the p50 / p95 time of the whole query
// (transaction included, as the gateway does it). Two filters: `1 context` (every row of the scope is a
// candidate) and `50 contexts` (a request may only match 1 row in 50), because a filtered vector search is where
// an approximate index loses recall. The table is a scratch copy of semantic_cache's shape in this database and
// is dropped at the end; the planner picks the plan, and the plan it picked is reported.
import { performance } from 'node:perf_hooks';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import type pg from 'pg';
import { loadConfig } from '../../packages/gateway/src/config.ts';
import { createDb } from '../../packages/gateway/src/db/client.ts';
import { localEmbedder, unit, voyageEmbedder, type Embedder } from '../../packages/gateway/src/semantic/embedder.ts';
import { loadPairs, rng, sample } from './datasets.ts';
import { embedAll, hashEmbedder } from './eval.ts';

export type VariantName = 'exact' | 'hnsw' | 'ivfflat';
export const VARIANTS: VariantName[] = ['exact', 'hnsw', 'ivfflat'];
export const FILTERS = [
  { name: '1 context', column: 'ctx1' },
  { name: '50 contexts', column: 'ctx50' },
] as const;
const CONTEXTS = 50;

export function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return Number.NaN;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[i]!;
}

export interface Answer {
  id: number;
  distance: number;
}

/** Share of queries whose answer is the exact one (or a row exactly as near: ties are not misses). */
export function recallAt1(exact: readonly (Answer | undefined)[], got: readonly (Answer | undefined)[], tolerance = 1e-6): number {
  if (exact.length === 0 || exact.length !== got.length) throw new Error('recallAt1 needs two lists of the same, non-zero length');
  let ok = 0;
  for (let i = 0; i < exact.length; i++) {
    const e = exact[i];
    const g = got[i];
    if (e === undefined && g === undefined) ok += 1;
    else if (e !== undefined && g !== undefined && (g.id === e.id || Math.abs(g.distance - e.distance) <= tolerance)) ok += 1;
  }
  return ok / exact.length;
}

/** pgvector's advice for IVFFlat: rows / 1000 up to a million rows, sqrt(rows) beyond; never below 10 lists here. */
export const ivfLists = (rows: number) => Math.max(10, rows <= 1_000_000 ? Math.floor(rows / 1000) : Math.floor(Math.sqrt(rows)));

export interface Measure {
  size: number;
  variant: VariantName;
  settings: string;
  buildS: number;
  sizeMb: number;
  filter: string;
  recall: number;
  p50Ms: number;
  p95Ms: number;
  /** What the planner chose for the first query. */
  plan: string;
}

const literal = (v: readonly number[]) => `[${v.map((x) => Number(x.toPrecision(7))).join(',')}]`;

async function inTx<T>(pool: pg.Pool, fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const r = await fn(c);
    await c.query('COMMIT');
    return r;
  } catch (err) {
    await c.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    c.release();
  }
}

export interface BenchOptions {
  pool: pg.Pool;
  table: string;
  /** vectors[0..size) are the rows, the next `queries` are the queries. */
  vectors: readonly (readonly number[])[];
  size: number;
  queries: number;
  seed: number;
  variants?: readonly VariantName[];
  log?: (m: string) => void;
}

const dimsOf = (o: BenchOptions) => o.vectors[0]!.length;

async function load(o: BenchOptions): Promise<void> {
  const { pool, table } = o;
  await pool.query(`DROP TABLE IF EXISTS ${table}`);
  await pool.query(
    `CREATE UNLOGGED TABLE ${table} (id bigserial PRIMARY KEY, scope text NOT NULL, ctx1 text NOT NULL, ctx50 text NOT NULL, embedding vector(${dimsOf(o)}) NOT NULL)`,
  );
  for (let i = 0; i < o.size; i += 500) {
    const end = Math.min(o.size, i + 500);
    const rows = Array.from({ length: end - i }, (_, k) => o.vectors[i + k]!);
    await pool.query(
      `INSERT INTO ${table} (scope, ctx1, ctx50, embedding)
       SELECT 'bench', 'c', 'c' || (n % ${CONTEXTS}), v::vector FROM unnest($1::int[], $2::text[]) AS x(n, v)`,
      [Array.from({ length: end - i }, (_, k) => i + k), rows.map(literal)],
    );
  }
  await pool.query(`CREATE INDEX ON ${table} (scope, ctx1)`);
  await pool.query(`CREATE INDEX ON ${table} (scope, ctx50)`);
  await pool.query(`ANALYZE ${table}`);
}

async function query(c: pg.PoolClient, o: BenchOptions, column: string, context: string, vector: readonly number[]): Promise<Answer | undefined> {
  const r = await c.query<{ id: string; distance: number }>(
    `SELECT id, embedding <=> $2::vector AS distance FROM ${o.table} WHERE scope = 'bench' AND ${column} = $1 ORDER BY embedding <=> $2::vector LIMIT 1`,
    [context, literal(vector)],
  );
  const row = r.rows[0];
  return row ? { id: Number(row.id), distance: Number(row.distance) } : undefined;
}

// The queries' contexts: with 50 contexts a query belongs to context (index mod 50), with 1 context to the only one.
const contextOf = (column: string, i: number) => (column === 'ctx1' ? 'c' : `c${i % CONTEXTS}`);

/** Runs every variant over every filter and returns one row per (variant, filter). */
export async function runIndexBench(o: BenchOptions): Promise<Measure[]> {
  const log = o.log ?? (() => {});
  const queryVectors = o.vectors.slice(o.size, o.size + o.queries);
  if (queryVectors.length !== o.queries) throw new Error(`need ${o.size + o.queries} vectors, have ${o.vectors.length}`);
  await load(o);
  const results: Measure[] = [];
  const truth = new Map<string, (Answer | undefined)[]>();
  try {
    for (const variant of o.variants ?? VARIANTS) {
      let settings = 'btree on (scope, context) then sort';
      let setLocal: string[] = [];
      let buildS = 0;
      if (variant === 'hnsw') {
        settings = 'm 16, ef_construction 64, ef_search 40, iterative scan strict_order';
        setLocal = ['SET LOCAL hnsw.ef_search = 40', 'SET LOCAL hnsw.iterative_scan = strict_order'];
        const t0 = performance.now();
        await o.pool.query(`CREATE INDEX ${o.table}_vec ON ${o.table} USING hnsw (embedding vector_cosine_ops) WITH (m = 16, ef_construction = 64)`);
        buildS = (performance.now() - t0) / 1000;
      } else if (variant === 'ivfflat') {
        const lists = ivfLists(o.size);
        settings = `lists ${lists}, probes 10, iterative scan relaxed_order`;
        setLocal = ['SET LOCAL ivfflat.probes = 10', 'SET LOCAL ivfflat.iterative_scan = relaxed_order'];
        const t0 = performance.now();
        await o.pool.query(`CREATE INDEX ${o.table}_vec ON ${o.table} USING ivfflat (embedding vector_cosine_ops) WITH (lists = ${lists})`);
        buildS = (performance.now() - t0) / 1000;
      }
      if (variant !== 'exact') await o.pool.query(`ANALYZE ${o.table}`);
      const sizeMb =
        variant === 'exact' ? 0 : Number((await o.pool.query<{ s: string }>(`SELECT pg_relation_size('${o.table}_vec') AS s`)).rows[0]!.s) / 1_048_576;
      log(`  ${variant}: built in ${buildS.toFixed(1)} s`);

      for (const f of FILTERS) {
        const answers: (Answer | undefined)[] = [];
        const times: number[] = [];
        const one = (i: number) =>
          inTx(o.pool, async (c) => {
            for (const s of setLocal) await c.query(s);
            return query(c, o, f.column, contextOf(f.column, i), queryVectors[i]!);
          });
        // The first 20 queries are not timed: they warm the cache the timed ones would otherwise pay for.
        for (let i = 0; i < Math.min(20, queryVectors.length); i++) await one(i);
        for (let i = 0; i < queryVectors.length; i++) {
          const t0 = performance.now();
          answers.push(await one(i));
          times.push(performance.now() - t0);
        }
        const plan = await inTx(o.pool, async (c) => {
          for (const s of setLocal) await c.query(s);
          const ex = await c.query<{ 'QUERY PLAN': unknown }>(
            `EXPLAIN (FORMAT JSON) SELECT id FROM ${o.table} WHERE scope = 'bench' AND ${f.column} = $1 ORDER BY embedding <=> $2::vector LIMIT 1`,
            [contextOf(f.column, 0), literal(queryVectors[0]!)],
          );
          return JSON.stringify(ex.rows[0]!['QUERY PLAN']).includes(`${o.table}_vec`) ? 'vector index' : 'btree + sort';
        });
        if (variant === 'exact') truth.set(f.name, answers);
        const exact = truth.get(f.name);
        times.sort((a, b) => a - b);
        results.push({
          size: o.size,
          variant,
          settings,
          buildS,
          sizeMb,
          filter: f.name,
          recall: exact ? recallAt1(exact, answers) : 1,
          p50Ms: percentile(times, 50),
          p95Ms: percentile(times, 95),
          plan,
        });
      }
      if (variant !== 'exact') await o.pool.query(`DROP INDEX ${o.table}_vec`);
    }
  } finally {
    await o.pool.query(`DROP TABLE IF EXISTS ${o.table}`);
  }
  return results;
}

/** Random unit vectors drawn around a few hundred centres, a stand-in for embeddings when no model is wanted. */
export function syntheticVectors(count: number, dimensions: number, seed: number): number[][] {
  const rand = rng(seed);
  const gauss = () => Math.sqrt(-2 * Math.log(1 - rand())) * Math.cos(2 * Math.PI * rand());
  const centres = Array.from({ length: 200 }, () => Array.from({ length: dimensions }, gauss));
  return Array.from({ length: count }, () => {
    const c = centres[Math.floor(rand() * centres.length)]!;
    return unit(c.map((x) => x + 0.6 * gauss()))!;
  });
}

export function renderTable(rows: readonly Measure[]): string {
  const sizes = [...new Set(rows.map((r) => r.size))];
  const out: string[] = ['# Vector index comparison', ''];
  for (const size of sizes) {
    out.push(`## ${size} vectors`, '');
    out.push('| index | settings | filter | plan | recall@1 | p50 ms | p95 ms | build s | size MB |', '|---|---|---|---|---|---|---|---|---|');
    for (const r of rows.filter((x) => x.size === size)) {
      out.push(
        `| ${r.variant} | ${r.settings} | ${r.filter} | ${r.plan} | ${(r.recall * 100).toFixed(1)}% | ${r.p50Ms.toFixed(2)} | ${r.p95Ms.toFixed(2)} | ${r.variant === 'exact' ? '' : r.buildS.toFixed(1)} | ${r.variant === 'exact' ? '' : r.sizeMb.toFixed(1)} |`,
      );
    }
    out.push('');
  }
  return out.join('\n');
}

async function main() {
  const { values } = parseArgs({
    options: {
      sizes: { type: 'string', default: '10000,100000' },
      queries: { type: 'string', default: '300' },
      vectors: { type: 'string', default: 'local' },
      seed: { type: 'string', default: '42' },
      concurrency: { type: 'string', default: '4' },
      dir: { type: 'string', default: resolve(import.meta.dirname, '../../.datasets') },
      out: { type: 'string', default: resolve(import.meta.dirname, '../results/pr-9') },
      conditions: { type: 'string', default: 'not recorded' },
    },
  });
  const config = loadConfig();
  const log = (m: string) => console.error(m);
  const sizes = values.sizes!.split(',').map(Number);
  const queries = Number(values.queries);
  const need = Math.max(...sizes) + queries;
  const seed = Number(values.seed);
  const target = new URL(config.databaseUrl);
  log(`database: ${target.hostname}:${target.port}${target.pathname}`);

  let vectors: number[][];
  const kind = values.vectors!;
  if (kind === 'synthetic') {
    vectors = syntheticVectors(need, config.semanticDimensions, seed);
  } else {
    const embedder: Embedder =
      kind === 'stub'
        ? hashEmbedder(config.semanticDimensions)
        : kind === 'voyage'
          ? voyageEmbedder({ apiKey: config.voyageApiKey!, baseUrl: config.voyageBaseUrl, model: config.voyageModel, dimensions: config.semanticDimensions, timeoutMs: 30_000, inputType: config.semanticInputType })
          : localEmbedder({ baseUrl: config.ollamaUrl, model: config.semanticLocalModel, dimensions: config.semanticDimensions, timeoutMs: 60_000, inputType: config.semanticInputType });
    // Questions from the same Quora pairs the evaluation uses, one text per vector.
    const { dev, test } = await loadPairs({ dir: values.dir!, qqp: 400_000, paws: 0, seed, log });
    const unique = [...new Set([...dev, ...test].flatMap((p) => [p.a, p.b]))];
    if (unique.length < need) throw new Error(`only ${unique.length} distinct questions for ${need} vectors`);
    const texts = sample(unique, need, seed);
    mkdirSync(values.dir!, { recursive: true });
    const embedded = await embedAll(embedder, texts, { concurrency: Number(values.concurrency), ...(kind === 'stub' ? {} : { cacheFile: join(values.dir!, `emb-${kind}-${config.semanticInputType}.jsonl`) }), log });
    vectors = texts.map((t) => embedded.get(t)!);
  }

  const handle = createDb({ databaseUrl: config.databaseUrl, poolSize: 2 });
  const rows: Measure[] = [];
  try {
    await handle.pool.query('CREATE EXTENSION IF NOT EXISTS vector');
    for (const size of sizes) {
      log(`${size} vectors`);
      rows.push(...(await runIndexBench({ pool: handle.pool, table: `semantic_bench_${size}`, vectors, size, queries, seed, log })));
    }
  } finally {
    await handle.close();
  }
  mkdirSync(values.out!, { recursive: true });
  writeFileSync(join(values.out!, 'index-bench.json'), `${JSON.stringify({ vectors: kind, queries, seed, conditions: values.conditions, rows }, null, 2)}\n`);
  writeFileSync(join(values.out!, 'index-bench.md'), `${renderTable(rows)}\nVectors: ${kind}; ${queries} held-out queries per cell; conditions: ${values.conditions}.\n`);
  console.log(`wrote ${join(values.out!, 'index-bench.md')}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err: unknown) => {
    console.error(`index bench failed: ${(err as Error).message}`);
    process.exit(1);
  });
}
