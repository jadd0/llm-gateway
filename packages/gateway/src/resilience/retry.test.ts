import { describe, expect, it } from 'vitest';
import { backoffMs, breakerSignal, fallsOver, isRetryable, planRetry, retriesSameModel, retryAfterMs, type Outcome, type RetryPolicy } from './retry.ts';
import type { Phase } from './timeouts.ts';

const status = (s: number): Outcome => ({ kind: 'status', status: s });
const error = (phase: Phase): Outcome => ({ kind: 'error', phase });

describe('retry classification', () => {
  it('retryable statuses and errors are classified exactly', () => {
    const statuses = Array.from({ length: 600 }, (_, i) => i).filter((s) => isRetryable(status(s)));
    expect(statuses).toEqual([429, 500, 502, 503, 504, 529]);
    const phases: Phase[] = ['connect', 'headers', 'body', 'deadline', 'other'];
    expect(phases.filter((p) => isRetryable(error(p)))).toEqual(['connect', 'headers']);
    // A headers timeout moves on to the next model; it is never repeated on the same one.
    expect(phases.filter((p) => retriesSameModel(error(p)))).toEqual(['connect']);
    expect([429, 500, 502, 503, 504, 529].every((s) => retriesSameModel(status(s)))).toBe(true);
  });

  it('400 401 403 404 413 are never retried', () => {
    for (const s of [400, 401, 403, 404, 413]) {
      expect(isRetryable(status(s))).toBe(false);
      expect(retriesSameModel(status(s))).toBe(false);
    }
  });
});

describe('falling over to the next model and the breaker', () => {
  it('401 403 404 move on to the next model; 400 413 422 do not', () => {
    const statuses = Array.from({ length: 600 }, (_, i) => i).filter((s) => fallsOver(status(s)));
    expect(statuses).toEqual([401, 403, 404, 429, 500, 502, 503, 504, 529]);
    for (const s of [401, 403, 404]) expect(retriesSameModel(status(s))).toBe(false);
    const phases: Phase[] = ['connect', 'headers', 'body', 'deadline', 'other'];
    expect(phases.filter((p) => fallsOver(error(p)))).toEqual(['connect', 'headers']);
  });

  it('only the provider-blamed statuses and connection errors are breaker failures; 429 never is', () => {
    const failures = Array.from({ length: 600 }, (_, i) => i).filter((s) => breakerSignal(status(s)) === 'failure');
    expect(failures).toEqual([500, 502, 503, 504, 529]);
    for (const s of [400, 401, 403, 404, 413, 422, 429]) expect(breakerSignal(status(s))).toBe('answered');
    expect(breakerSignal(error('connect'))).toBe('failure');
    expect(breakerSignal(error('headers'))).toBe('failure');
    expect(['body', 'deadline', 'other'].map((p) => breakerSignal(error(p as Phase)))).toEqual(['abandoned', 'abandoned', 'abandoned']);
  });
});

describe('backoff', () => {
  const b = { baseMs: 200, capMs: 2000 };
  it('backoff stays within full-jitter bounds', () => {
    // Ceilings: 200, 800, 2000 (capped; 3200 would be next).
    expect([1, 2, 3, 4].map((n) => backoffMs(n, b, () => 0.999999))).toEqual([199, 799, 1999, 1999]);
    expect([1, 2, 3].map((n) => backoffMs(n, b, () => 0))).toEqual([0, 0, 0]);
    // Real randomness stays inside [0, ceiling) and is not constant.
    const draws = Array.from({ length: 500 }, () => backoffMs(2, b));
    expect(Math.min(...draws)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...draws)).toBeLessThan(800);
    expect(new Set(draws).size).toBeGreaterThan(50);
  });
});

describe('retry-after', () => {
  const now = Date.parse('2026-11-09T12:00:00Z');
  const policy: RetryPolicy = { baseMs: 200, capMs: 2000, maxAttempts: 3, retryAfterMaxMs: 5000, minRemainingMs: 1000 };
  const fail = (retryAfter: string | undefined, over: Partial<{ attemptsMade: number; remainingMs: number }> = {}) =>
    planRetry({ outcome: status(503), retryAfter, attemptsMade: 1, remainingMs: 60_000, nowMs: now, ...over }, policy, () => 0.5);

  it('retry-after seconds and http-date are honoured and capped', () => {
    expect(retryAfterMs('3', now)).toBe(3000);
    expect(retryAfterMs('Mon, 09 Nov 2026 12:00:04 GMT', now)).toBe(4000);
    expect(retryAfterMs('Mon, 09 Nov 2026 11:00:00 GMT', now)).toBe(0);
    expect(retryAfterMs('soon', now)).toBeUndefined();
    expect(retryAfterMs(undefined, now)).toBeUndefined();
    expect(fail('3')).toEqual({ action: 'retry', waitMs: 3000 });
    expect(fail('Mon, 09 Nov 2026 12:00:04 GMT')).toEqual({ action: 'retry', waitMs: 4000 });
    // Past the cap: no wait, the next model at once.
    expect(fail('3600')).toEqual({ action: 'next-model' });
    expect(fail('6')).toEqual({ action: 'next-model' });
    // Fits the cap but not the time left.
    expect(fail('4', { remainingMs: 4500 })).toEqual({ action: 'next-model' });
    expect(fail('4', { remainingMs: 5000 })).toEqual({ action: 'retry', waitMs: 4000 });
  });

  it('attempts per model are bounded and a headers timeout never retries the same model', () => {
    expect(fail(undefined)).toEqual({ action: 'retry', waitMs: 100 });
    expect(fail(undefined, { attemptsMade: 2 })).toEqual({ action: 'retry', waitMs: 400 });
    expect(fail(undefined, { attemptsMade: 3 })).toEqual({ action: 'next-model' });
    expect(planRetry({ outcome: error('headers'), attemptsMade: 1, remainingMs: 60_000, nowMs: now }, policy)).toEqual({ action: 'next-model' });
    expect(planRetry({ outcome: error('connect'), attemptsMade: 1, remainingMs: 60_000, nowMs: now }, policy, () => 0.5)).toEqual({ action: 'retry', waitMs: 100 });
    // A backoff that would leave under the minimum does not wait.
    expect(fail(undefined, { attemptsMade: 2, remainingMs: 1300 })).toEqual({ action: 'next-model' });
  });
});
