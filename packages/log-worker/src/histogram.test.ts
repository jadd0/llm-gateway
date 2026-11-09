import { describe, expect, it } from 'vitest';
import { BOUNDS, BUCKET_RATIO, LATENCY_BUCKETS, LATENCY_MAX_MS, bucketOf, histogramOf, merge, percentile, upperBound } from './histogram.ts';

// A small deterministic generator, so the samples never change between runs.
function lcg(seed: number) {
  let s = seed;
  return () => (s = (s * 1664525 + 1013904223) % 4294967296) / 4294967296;
}
const lognormal = (rand: () => number, median: number, sigma: number) => {
  const u = Math.max(rand(), 1e-12);
  const z = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rand());
  return Math.max(0, Math.round(median * Math.exp(sigma * z)));
};
const exact = (xs: number[], q: number) => [...xs].sort((a, b) => a - b)[Math.max(1, Math.ceil(q * xs.length)) - 1]!;

describe('latency buckets', () => {
  it('covers 0 ms to the cap in ~5% steps with an open-ended last bucket', () => {
    expect(BOUNDS[0]).toBe(1);
    expect(BOUNDS.at(-1)).toBeGreaterThanOrEqual(LATENCY_MAX_MS);
    expect(BOUNDS.at(-2)).toBeLessThan(LATENCY_MAX_MS);
    expect(LATENCY_BUCKETS).toBe(BOUNDS.length + 1);
    expect(bucketOf(0)).toBe(0);
    expect(bucketOf(1)).toBe(0);
    expect(bucketOf(2)).toBeGreaterThan(0);
    expect(bucketOf(240_000)).toBe(LATENCY_BUCKETS - 1);
    for (let i = 1; i < BOUNDS.length; i++) expect(BOUNDS[i]! / BOUNDS[i - 1]!).toBeCloseTo(BUCKET_RATIO, 10);
  });

  it('puts every latency in the bucket whose bound is the first at or above it', () => {
    for (const ms of [0, 1, 2, 3, 17, 100, 101, 999, 5000, 119_999, 120_000]) {
      const i = bucketOf(ms);
      expect(upperBound(i)).toBeGreaterThanOrEqual(ms);
      if (i > 0) expect(BOUNDS[i - 1]).toBeLessThan(ms);
    }
  });
});

describe('percentile', () => {
  it('percentile of merged histograms matches exact percentile within one bucket', () => {
    const rand = lcg(7);
    // Three slices with very different shapes, merged: the p95 of the whole is not the mean of the slices' p95.
    const fast = Array.from({ length: 4000 }, () => lognormal(rand, 40, 0.4));
    const slow = Array.from({ length: 300 }, () => lognormal(rand, 4000, 0.5));
    const mid = Array.from({ length: 1500 }, () => lognormal(rand, 300, 0.6));
    const all = [...fast, ...slow, ...mid];
    const merged = merge(merge(histogramOf(fast), histogramOf(slow)), histogramOf(mid));
    expect(all.length).toBeGreaterThan(5000);
    for (const q of [0.5, 0.9, 0.95, 0.99]) {
      const want = exact(all, q);
      const got = percentile(merged, q)!;
      expect(got).toBeGreaterThanOrEqual(want);
      // Within one bucket: no further above the exact value than the bucket's own width.
      expect(got).toBeLessThanOrEqual(Math.max(1, want * BUCKET_RATIO) * (1 + 1e-9));
    }
    // The mean of the slices' p95 is far from the true p95, so a rollup that averaged them could not pass above.
    const mean95 = [fast, slow, mid].map((xs) => percentile(histogramOf(xs), 0.95)!).reduce((a, b) => a + b, 0) / 3;
    expect(Math.abs(mean95 - exact(all, 0.95)) / exact(all, 0.95)).toBeGreaterThan(0.2);
  });

  it('is null for an empty histogram and exact for a single sample', () => {
    expect(percentile([], 0.95)).toBeNull();
    expect(percentile([0, 0], 0.5)).toBeNull();
    expect(percentile(histogramOf([1]), 0.95)).toBe(1);
  });
});

describe('merge', () => {
  it('merge is associative', () => {
    const rand = lcg(11);
    const mk = (n: number, m: number) => histogramOf(Array.from({ length: n }, () => lognormal(rand, m, 0.7)));
    const a = mk(500, 20);
    const b = mk(300, 900);
    const c = mk(50, 30_000);
    expect(a.length).not.toBe(c.length);
    expect(merge(merge(a, b), c)).toEqual(merge(a, merge(b, c)));
    expect(merge(a, b)).toEqual(merge(b, a));
    expect(merge(a, [])).toEqual(a);
  });
});
