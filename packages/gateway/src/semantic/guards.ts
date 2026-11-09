import { createHash } from 'node:crypto';

// Embeddings rank prompts by meaning, and meaning is exactly what they blur: "refund order 1234" and "refund
// order 1235" are 0.98 similar. A guard compares what the vector cannot see, on the stored prompt and the
// request's, and a match that fails one is a miss. The guards only ever make the cache serve less.
//
// The stored side is a signature, not the prompt: every element is a truncated hash, so Postgres holds no
// prompt text (the vector itself is already a lossy encoding of it) and the guards still get what they need,
// which is equality and set difference.

export const GUARD_RULES = ['signature', 'numbers', 'quotes', 'names', 'negation', 'tokens'] as const;
export type GuardRule = (typeof GUARD_RULES)[number];

export interface GuardSignature {
  v: 1;
  /** Hashes of every number and ID, in order of hash, repeats kept. */
  numbers: string[];
  /** Hashes of every quoted string, in order of hash, repeats kept. */
  quotes: string[];
  /** Hashes of the distinct capitalised words that do not start a sentence, in order of hash. */
  names: string[];
  /** How many negation words. */
  negations: number;
  /** Hashes of the distinct content words (lowercased, stop words removed), in order of hash. */
  words: string[];
}

export interface GuardOptions {
  /** Whether the content-word guard runs. */
  tokenSet: boolean;
  /** The most content words by which the two prompts' sets may differ (symmetric difference). */
  maxDiff: number;
}

const hash = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 12);
const sortedHashes = (items: Iterable<string>) => [...items].map(hash).sort();

// 1234, 3.14, 1,000, A-123 (the letters before a hyphen belong to the ID; a '#' does not).
const NUMBER = /(?:\p{L}+-)?\p{Nd}+(?:[.,]\p{Nd}+)*/gu;
// 'x', "x", `x`, curly pairs. An apostrophe inside a word (don't, Bob's) never opens a quote.
const QUOTE = /(?<![\p{L}\p{N}])(?:'([^'\n]+)'|"([^"\n]+)"|`([^`\n]+)`|“([^”\n]+)”|‘([^’\n]+)’)(?![\p{L}\p{N}])/gu;
const WORD = /[\p{L}\p{M}]+(?:['’][\p{L}\p{M}]+)*/gu;

const NEGATION = new Set(['no', 'not', 'never', 'none', 'nobody', 'nothing', 'nowhere', 'neither', 'nor', 'without', 'cannot']);
const isNegation = (w: string) => NEGATION.has(w) || /n['’]t$/.test(w);

const STOP = new Set(
  (
    'a about above after again all also am an and any are as at be because been before being below between both but by can could did do does doing down during each few for from further had has have having he her here hers herself him himself his how i if in into is it its itself just me more most my myself of off on once only or other our ours ourselves out over own same she should so some such than that the their theirs them themselves then there these they this those through to too under until up very was we were what when where which while who whom why will with would you your yours yourself yourselves ' +
    "s t d ll re ve m o y please tell"
  ).split(/\s+/),
);

/** Capitalised words that are not the first word of a sentence: proper nouns, product names, acronyms. */
function namesOf(text: string): Set<string> {
  const out = new Set<string>();
  for (const m of text.matchAll(WORD)) {
    const w = m[0];
    if (!/^\p{Lu}/u.test(w) || w === 'I' || /^I['’]/.test(w)) continue;
    const before = text.slice(0, m.index).replace(/[\s"'“‘(\[]+$/u, '');
    // The start of the text, or after a sentence end or a line break.
    if (before === '' || /[.!?:;]$/.test(before) || /\n\s*["'“‘(\[]*$/.test(text.slice(0, m.index))) continue;
    out.add(w.toLowerCase());
  }
  return out;
}

/** What the guards compare, from a prompt's text. Pure; the fill stores it and a lookup computes it for the request. */
export function guardSignature(text: string): GuardSignature {
  const numbers = [...text.matchAll(NUMBER)].map((m) => m[0].toLowerCase());
  const quotes = [...text.matchAll(QUOTE)].map((m) => (m[1] ?? m[2] ?? m[3] ?? m[4] ?? m[5] ?? '').trim());
  const lowered = [...text.matchAll(WORD)].map((m) => m[0].toLowerCase().replaceAll('’', "'"));
  let negations = 0;
  const words = new Set<string>();
  for (const w of lowered) {
    if (isNegation(w)) {
      negations += 1;
      continue;
    }
    const base = w.replace(/'s$/, '').replaceAll("'", '');
    if (base.length >= 2 && !STOP.has(base)) words.add(base);
  }
  return { v: 1, numbers: sortedHashes(numbers), quotes: sortedHashes(quotes), names: sortedHashes(namesOf(text)), negations, words: sortedHashes(words) };
}

const same = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((x, i) => x === b[i]);

/** Symmetric difference of two sorted, duplicate-free arrays. */
function symmetricDifference(a: readonly string[], b: readonly string[]): number {
  const inB = new Set(b);
  let shared = 0;
  for (const x of a) if (inB.has(x)) shared += 1;
  return a.length + b.length - 2 * shared;
}

/**
 * The first guard that the stored prompt and the request fail, or undefined when both pass. In order: numbers
 * and IDs (as multisets), quoted strings (as multisets), names (as sets), negation words (their count), then
 * the content words (their sets differ by at most `maxDiff` words, when the guard is on).
 */
export function failedGuard(stored: GuardSignature | undefined, request: GuardSignature, o: GuardOptions): GuardRule | undefined {
  // A row from a signature version this code does not know cannot be compared: not served.
  if (!stored || stored.v !== 1) return 'signature';
  if (!same(stored.numbers, request.numbers)) return 'numbers';
  if (!same(stored.quotes, request.quotes)) return 'quotes';
  if (!same(stored.names, request.names)) return 'names';
  if (stored.negations !== request.negations) return 'negation';
  if (o.tokenSet && symmetricDifference(stored.words, request.words) > o.maxDiff) return 'tokens';
  return undefined;
}
