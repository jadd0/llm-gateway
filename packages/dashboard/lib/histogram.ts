// The percentile code is the log worker's: the same buckets that wrote the histograms read them back.
export { LATENCY_BUCKETS, BOUNDS, merge, percentile, total } from '../../log-worker/src/histogram.ts';
