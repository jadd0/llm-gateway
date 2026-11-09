// Latency histograms with fixed, log-scale buckets. A rollup stores counts per bucket instead of a percentile, so
// the latency of any range is the merge (element-wise sum) of its histograms and the percentile is read from the
// merged counts. Averaging stored percentiles would be wrong: the p95 of two halves is not their mean.
//
// Changing these constants invalidates every stored histogram, so they are fixed in code and not configurable.

/** Each bucket's upper bound is this much above the previous one: the bucketing error is at most 5%. */
export const BUCKET_RATIO = 1.05;
/** Latency (ms) the regular buckets reach; anything slower lands in one open-ended bucket. */
export const LATENCY_MAX_MS = 120_000;

// bounds[i] is the largest latency (ms) bucket i holds: 1, 1.05, 1.1025, ... up to the first one past LATENCY_MAX_MS.
export const BOUNDS: readonly number[] = (() => {
  const b: number[] = [];
  for (let v = 1; ; v *= BUCKET_RATIO) {
    b.push(v);
    if (v >= LATENCY_MAX_MS) break;
  }
  return b;
})();

/** Number of buckets: one per bound (bucket 0 also holds 0 ms) plus the open-ended last one. */
export const LATENCY_BUCKETS = BOUNDS.length + 1;

/** The bucket a latency falls in: the first whose bound is at least the latency. */
export function bucketOf(ms: number): number {
  if (!(ms > BOUNDS[0]!)) return 0; // 0 ms, 1 ms, and anything not a positive number
  let lo = 0;
  let hi = BOUNDS.length; // BOUNDS.length is the open-ended bucket
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (ms <= BOUNDS[mid]!) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

/** The latency a percentile read from bucket `i` reports: its upper bound. The open-ended bucket reports the last bound. */
export const upperBound = (i: number): number => BOUNDS[Math.min(i, BOUNDS.length - 1)]!;

/** A histogram as stored: counts by bucket, trailing zeros dropped. */
export type Histogram = number[];

/** Counts of a list of latencies. */
export function histogramOf(latenciesMs: Iterable<number>): Histogram {
  const h: Histogram = [];
  for (const ms of latenciesMs) {
    const i = bucketOf(ms);
    while (h.length <= i) h.push(0);
    h[i]!++;
  }
  return h;
}

/** Element-wise sum; the shorter histogram counts as zeros. Associative and commutative. */
export function merge(a: readonly number[], b: readonly number[]): Histogram {
  const out: Histogram = new Array<number>(Math.max(a.length, b.length)).fill(0);
  for (let i = 0; i < out.length; i++) out[i] = (a[i] ?? 0) + (b[i] ?? 0);
  return out;
}

export const total = (h: readonly number[]): number => h.reduce((s, n) => s + n, 0);

/**
 * The q-quantile (0 < q <= 1), nearest-rank: the upper bound of the bucket holding the ceil(q * n)-th smallest
 * sample. The exact value is no higher than this and, short of the open-ended bucket, within one bucket width
 * (5%) below it. Null for an empty histogram.
 */
export function percentile(h: readonly number[], q: number): number | null {
  const n = total(h);
  if (n === 0) return null;
  const rank = Math.max(1, Math.ceil(q * n));
  let seen = 0;
  for (let i = 0; i < h.length; i++) {
    seen += h[i] ?? 0;
    if (seen >= rank) return upperBound(i);
  }
  return upperBound(h.length - 1);
}
