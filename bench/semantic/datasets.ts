// The labelled paraphrase sets the semantic-cache evaluation runs on, downloaded at run time and never committed.
//
//   QQP   Quora Question Pairs: real questions people asked, labelled duplicate or not. Fetched from Quora's own
//         file server. Quora publishes no licence file with it and its terms of service govern use (the release
//         page was behind a bot check when this was written), so the file is used here for internal evaluation
//         only, kept out of git (.datasets/), and only aggregate figures leave this machine.
//   PAWS  PAWS-Wiki (labeled_final, test split, 8000 pairs): sentence pairs with the same words in a different
//         order, half of which mean something else. Google LLC: "may be freely used for any purpose"
//         (github.com/google-research-datasets/paws, LICENSE). Its original download (a Google Cloud Storage
//         bucket) refuses anonymous reads now, so the same rows are read from the Hugging Face datasets server
//         and written to one canonical file.
//
// Each file is checked against a pinned sha256; a mismatch stops the run rather than evaluating on different data.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export type Source = 'qqp' | 'paws';

export interface Pair {
  id: string;
  source: Source;
  a: string;
  b: string;
  /** True when the two mean the same thing, so one's answer is right for the other. */
  duplicate: boolean;
}

export const DATASETS = {
  qqp: {
    url: 'https://qim.fs.quoracdn.net/quora_duplicate_questions.tsv',
    file: 'quora_duplicate_questions.tsv',
    bytes: 58_176_133,
    sha256: 'b3350dbb1d98db1f5abca85d736ba514bf4da253fae53939303d79fe921ec7c8',
    licence: 'Quora terms of service; no licence file published with the data',
  },
  paws: {
    // The rows API serves 100 rows per request; the canonical file below is what the hash covers.
    url: 'https://datasets-server.huggingface.co/rows?dataset=google-research-datasets%2Fpaws&config=labeled_final&split=test',
    file: 'paws-wiki-labeled-final-test.tsv',
    rows: 8000,
    sha256: '095277a9c8889f56475638337f5b8a343a33ae89965fe36abd61dff2eec3a4a6',
    licence: 'Google LLC: freely used for any purpose, acknowledgement appreciated',
  },
} as const;

export const sha256 = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');

/** One line per pair: id, label, sentence one, sentence two. Tabs and line breaks inside a sentence become spaces. */
const clean = (s: string) => s.replace(/[\t\r\n]+/g, ' ').trim();

export function pawsToTsv(rows: Array<{ id: number; sentence1: string; sentence2: string; label: number }>): string {
  return rows.map((r) => [r.id, r.label, clean(r.sentence1), clean(r.sentence2)].join('\t')).join('\n') + '\n';
}

/** Quora's file: id, qid1, qid2, question1, question2, is_duplicate. Rows with a missing question are dropped. */
export function parseQqp(tsv: string): Pair[] {
  const out: Pair[] = [];
  const lines = tsv.split('\n');
  for (let i = 1; i < lines.length; i++) {
    const f = lines[i]!.replace(/\r$/, '').split('\t');
    if (f.length !== 6) continue;
    const [id, , , a, b, label] = f as [string, string, string, string, string, string];
    if (!a.trim() || !b.trim() || (label !== '0' && label !== '1')) continue;
    out.push({ id: `qqp-${id}`, source: 'qqp', a: a.trim(), b: b.trim(), duplicate: label === '1' });
  }
  return out;
}

export function parsePaws(tsv: string): Pair[] {
  const out: Pair[] = [];
  for (const line of tsv.split('\n')) {
    const f = line.split('\t');
    if (f.length !== 4) continue;
    const [id, label, a, b] = f as [string, string, string, string];
    if (!a || !b || (label !== '0' && label !== '1')) continue;
    out.push({ id: `paws-${id}`, source: 'paws', a, b, duplicate: label === '1' });
  }
  return out;
}

/** A small seeded generator (mulberry32): the same seed always gives the same sample and split. */
export function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** `n` items drawn without replacement (all of them when there are fewer), in a seeded order. */
export function sample<T>(items: readonly T[], n: number, seed: number): T[] {
  const rand = rng(seed);
  const a = items.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a.slice(0, n);
}

/** Splits into a dev half (where the threshold is chosen) and a test half (where it is reported). Pairs never straddle. */
export function splitDevTest<T>(items: readonly T[], seed: number): { dev: T[]; test: T[] } {
  const shuffled = sample(items, items.length, seed);
  const cut = Math.floor(shuffled.length / 2);
  return { dev: shuffled.slice(0, cut), test: shuffled.slice(cut) };
}

// The datasets server rate-limits bursts; a refusal is retried with a growing pause before it is an error.
async function fetchBuffer(url: string): Promise<Buffer> {
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(url);
    if (res.ok) return Buffer.from(await res.arrayBuffer());
    if (attempt === 8 || (res.status !== 429 && res.status < 500)) throw new Error(`GET ${new URL(url).host} answered ${res.status}`);
    const told = Number(res.headers.get('retry-after'));
    await new Promise((r) => setTimeout(r, (Number.isFinite(told) && told > 0 ? Math.min(told, 60) : 5 * attempt) * 1000));
  }
}

function verified(name: string, data: string | Buffer, want: string): void {
  const got = sha256(data);
  if (got !== want) throw new Error(`${name}: sha256 is ${got}, pinned ${want}; the data changed, not evaluating on it`);
}

/** Downloads (once) into `dir` and returns the file's text. Pass `fetchPaws` in tests. */
export async function ensureDataset(
  source: Source,
  dir: string,
  io: { fetchBuffer?: typeof fetchBuffer; log?: (m: string) => void } = {},
): Promise<string> {
  const get = io.fetchBuffer ?? fetchBuffer;
  const spec = DATASETS[source];
  const path = join(dir, spec.file);
  mkdirSync(dir, { recursive: true });
  if (existsSync(path)) {
    const text = readFileSync(path);
    verified(spec.file, text, spec.sha256);
    return text.toString('utf8');
  }
  io.log?.(`downloading ${spec.file}`);
  if (source === 'qqp') {
    const data = await get(DATASETS.qqp.url);
    verified(spec.file, data, spec.sha256);
    writeFileSync(path, data);
    return data.toString('utf8');
  }
  const rows: Array<{ id: number; sentence1: string; sentence2: string; label: number }> = [];
  for (let offset = 0; offset < DATASETS.paws.rows; offset += 100) {
    const body = JSON.parse((await get(`${DATASETS.paws.url}&offset=${offset}&length=100`)).toString('utf8')) as {
      rows: Array<{ row: { id: number; sentence1: string; sentence2: string; label: number } }>;
    };
    rows.push(...body.rows.map((r) => r.row));
    await new Promise((r) => setTimeout(r, 250));
  }
  const tsv = pawsToTsv(rows);
  verified(spec.file, tsv, spec.sha256);
  writeFileSync(path, tsv);
  return tsv;
}

export interface LoadOptions {
  dir: string;
  qqp: number;
  paws: number;
  seed: number;
  log?: (m: string) => void;
}

/** The sampled pairs, split into dev and test. Sampling is per source, so both sets keep the requested mix. */
export async function loadPairs(o: LoadOptions): Promise<{ dev: Pair[]; test: Pair[] }> {
  const qqp = sample(parseQqp(await ensureDataset('qqp', o.dir, o.log ? { log: o.log } : {})), o.qqp, o.seed);
  const paws = sample(parsePaws(await ensureDataset('paws', o.dir, o.log ? { log: o.log } : {})), o.paws, o.seed + 1);
  const a = splitDevTest(qqp, o.seed + 2);
  const b = splitDevTest(paws, o.seed + 3);
  return { dev: [...a.dev, ...b.dev], test: [...a.test, ...b.test] };
}
