import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ensureDataset, parsePaws, parseQqp, pawsToTsv, sample, sha256, splitDevTest, type Pair } from './datasets.ts';
import { curve, embedAll, evaluate, hashEmbedder, pickThreshold, renderSummary, THRESHOLDS, type CurveRow, type Scored } from './eval.ts';

const item = (sim: number, duplicate: boolean, source: 'qqp' | 'paws' = 'qqp'): Scored => ({ sim, duplicate, source });

describe('semantic evaluation', () => {
  it('wrong-answer rate counts non-duplicate pairs among served hits', () => {
    // 10 duplicates at 0.99 and 0.9, 4 non-duplicates at 0.96, 0.9, 0.5, 0.5.
    const items = [
      ...Array.from({ length: 5 }, () => item(0.99, true)),
      ...Array.from({ length: 5 }, () => item(0.9, true)),
      item(0.96, false),
      item(0.9, false),
      item(0.5, false),
      item(0.5, false),
    ];
    const rows = curve(items);
    const at = (t: number) => rows.find((r) => r.threshold === t)!;
    // 0.95: served = the five at 0.99 and the non-duplicate at 0.96.
    expect(at(95)).toMatchObject({ served: 6, hits: 5, wrong: 1, duplicates: 10, hitRate: 0.5 });
    expect(at(95).wrongRate).toBeCloseTo(1 / 6, 12);
    // 0.90: everything at or above 0.9 (a similarity exactly at the threshold is served).
    expect(at(90)).toMatchObject({ served: 12, hits: 10, wrong: 2, hitRate: 1 });
    // 0.99: only duplicates, no wrong answers; above every similarity nothing is served and the rate is undefined, not 0.
    expect(at(99)).toMatchObject({ served: 5, hits: 5, wrong: 0, wrongRate: 0 });
    expect(curve([item(0.5, false)]).every((r) => r.served === 0 && r.wrongRate === null)).toBe(true);
    expect(curve([]).length).toBe(THRESHOLDS.length);
  });

  it('threshold picked on dev is the highest-hit one under the budget', () => {
    const row = (threshold: number, hits: number, wrong: number): CurveRow => ({
      threshold,
      served: hits + wrong,
      hits,
      wrong,
      duplicates: 100,
      hitRate: hits / 100,
      wrongRate: hits + wrong === 0 ? null : wrong / (hits + wrong),
    });
    const rows = [row(80, 90, 40), row(85, 80, 20), row(88, 70, 0), row(90, 60, 0), row(95, 30, 0), row(99, 0, 0)];
    // Budget 1% of served: 0.80 (31% wrong) and 0.85 (20%) are over; 0.88 serves the most of what is left.
    expect(pickThreshold(rows, 0.01)?.threshold).toBe(88);
    // A looser budget admits a lower threshold with more hits.
    expect(pickThreshold(rows, 0.25)?.threshold).toBe(85);
    expect(pickThreshold(rows, 1)?.threshold).toBe(80);
    // Equal hits: the higher (safer) threshold.
    expect(pickThreshold([row(90, 10, 0), row(91, 10, 0)], 0.01)?.threshold).toBe(91);
    // A threshold that serves nothing is not a choice; no eligible threshold is undefined.
    expect(pickThreshold([row(99, 0, 0)], 0.01)).toBeUndefined();
    expect(pickThreshold([row(80, 10, 10)], 0.01)).toBeUndefined();
    expect(pickThreshold([], 0.01)).toBeUndefined();
    // Not monotonic: a lower threshold that happens to be clean and serves more still wins.
    expect(pickThreshold([row(86, 70, 9), row(90, 50, 0), row(92, 40, 0)], 0.01)?.threshold).toBe(90);
  });

  it('samples and splits are seeded, and a pair is on one side only', () => {
    const items = Array.from({ length: 200 }, (_, i) => i);
    expect(sample(items, 50, 1)).toEqual(sample(items, 50, 1));
    expect(sample(items, 50, 1)).not.toEqual(sample(items, 50, 2));
    expect(new Set(sample(items, 50, 1)).size).toBe(50);
    expect(sample(items, 500, 1)).toHaveLength(200);
    const { dev, test } = splitDevTest(items, 9);
    expect(dev).toHaveLength(100);
    expect(test).toHaveLength(100);
    expect(new Set([...dev, ...test]).size).toBe(200);
    expect(splitDevTest(items, 9)).toEqual({ dev, test });
  });

  it('parses the two files and refuses data that does not match its pin', async () => {
    const qqp = 'id\tqid1\tqid2\tquestion1\tquestion2\tis_duplicate\n0\t1\t2\tA?\tB?\t1\n1\t3\t4\tC?\t\t0\n2\t5\t6\tD?\tE?\t0\nbroken line\n';
    expect(parseQqp(qqp)).toEqual([
      { id: 'qqp-0', source: 'qqp', a: 'A?', b: 'B?', duplicate: true },
      { id: 'qqp-2', source: 'qqp', a: 'D?', b: 'E?', duplicate: false },
    ]);
    const tsv = pawsToTsv([
      { id: 1, sentence1: 'a\tb', sentence2: 'c\nd', label: 0 },
      { id: 2, sentence1: 'x', sentence2: 'y', label: 1 },
    ]);
    expect(parsePaws(tsv)).toEqual([
      { id: 'paws-1', source: 'paws', a: 'a b', b: 'c d', duplicate: false },
      { id: 'paws-2', source: 'paws', a: 'x', b: 'y', duplicate: true },
    ]);
    const dir = mkdtempSync(join(tmpdir(), 'ds-'));
    try {
      await expect(ensureDataset('qqp', dir, { fetchBuffer: async () => Buffer.from('not the file') })).rejects.toThrow(/sha256 is .*pinned/);
      // Nothing was kept from the refused download.
      await expect(ensureDataset('qqp', dir, { fetchBuffer: async () => Buffer.from('still not') })).rejects.toThrow(/pinned/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    expect(sha256('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });

  it('embeds each text once, resumes from the cache file and refuses a partial set', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'emb-'));
    try {
      const inner = hashEmbedder(16);
      let calls = 0;
      const counting = { embed: async (t: string, o?: { patient?: boolean }) => (calls++, inner.embed(t, o)) };
      const file = join(dir, 'e.jsonl');
      const first = await embedAll(counting, ['hello world', 'hello world', 'bye'], { concurrency: 2, cacheFile: file });
      expect(first.size).toBe(2);
      expect(calls).toBe(2);
      const again = await embedAll(counting, ['hello world', 'bye', 'new text'], { concurrency: 2, cacheFile: file });
      expect(calls).toBe(3); // only the new text
      expect(again.get('bye')).toEqual(first.get('bye')!.map((x) => Number(x.toPrecision(7))));
      const broken = { embed: async () => undefined };
      await expect(embedAll(broken, ['a'], { concurrency: 1 })).rejects.toThrow(/could not be embedded/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('evaluates every query/entry combination, with cross-model judged at the query model\'s threshold', async () => {
    const mk = (id: string, source: 'qqp' | 'paws', duplicate: boolean): Pair => ({ id, source, a: `${id}-a`, b: `${id}-b`, duplicate });
    const pairs = [mk('p1', 'qqp', true), mk('p2', 'qqp', true), mk('p3', 'paws', false), mk('p4', 'paws', false)];
    // Two toy models in one space. X puts the wrong pair p3 (0.970) above the duplicate p2 (0.940); Y keeps p3 far (0.6) below p2 (0.866).
    const unitAt = (deg: number) => [Math.cos((deg * Math.PI) / 180), Math.sin((deg * Math.PI) / 180)];
    const vec = (angles: Record<string, number>) => new Map(Object.entries(angles).map(([k, d]) => [k, unitAt(d)]));
    const X = vec({ 'p1-a': 0, 'p1-b': 5, 'p2-a': 0, 'p2-b': 20, 'p3-a': 0, 'p3-b': 14, 'p4-a': 0, 'p4-b': 90 });
    const Y = vec({ 'p1-a': 0, 'p1-b': 5, 'p2-a': 0, 'p2-b': 30, 'p3-a': 0, 'p3-b': 53, 'p4-a': 0, 'p4-b': 90 });
    const results = evaluate({ dev: pairs, test: pairs, vectors: { none: { X, Y } }, maxWrongRate: 0.01 });
    expect(results.map((r) => `${r.query}>${r.entry}`).sort()).toEqual(['X>X', 'X>Y', 'Y>X', 'Y>Y']);
    const xx = results.find((r) => r.query === 'X' && r.entry === 'X')!;
    const yy = results.find((r) => r.query === 'Y' && r.entry === 'Y')!;
    // Serving X's second duplicate (0.940) means serving its wrong pair (0.970) too, so X settles for the one clean duplicate
    // (0.996); the tie between 0.98 and 0.99 goes to the higher. Y can serve both duplicates, down to 0.866.
    expect(xx.chosen?.threshold).toBe(99);
    expect(xx.chosen?.test).toMatchObject({ served: 1, hits: 1, wrong: 0 });
    expect(yy.chosen?.threshold).toBe(86);
    expect(yy.chosen?.test).toMatchObject({ served: 2, hits: 2, wrong: 0 });
    expect(yy.chosen?.testBySource.qqp?.hits).toBe(2);
    // X queries against Y entries: judged at Y's own choice.
    const xy = results.find((r) => r.query === 'Y' && r.entry === 'X')!;
    expect(xy.kind).toBe('cross-model');
    expect(xy.atSameModelThreshold).toMatchObject({ threshold: 86, served: 2, hits: 2 });
    const text = renderSummary(
      { qqp: 2, paws: 2, seed: 1, dev: 4, test: 4, devDuplicates: 2, testDuplicates: 2, embedders: ['X', 'Y'], inputTypes: ['none'], maxWrongRate: 0.01, conditions: 'test' },
      results,
    );
    expect(text).toContain('| none | X | X | same-model | 0.99 |');
    expect(text).not.toMatch(/NaN|undefined/);
  });

  it('the stub embedder is deterministic, unit length, and blind to word order', async () => {
    const e = hashEmbedder(64);
    const a = (await e.embed('flights from New York to Florida'))!;
    const b = (await e.embed('flights from Florida to New York'))!;
    expect(a.vector.reduce((s, x) => s + x * x, 0)).toBeCloseTo(1, 10);
    expect(a.vector).toEqual((await e.embed('flights from New York to Florida'))!.vector);
    expect(a.vector.reduce((s, x, i) => s + x * b.vector[i]!, 0)).toBeCloseTo(1, 10);
    expect(await e.embed('   ')).toBeUndefined();
  });
});
