import type { Phase } from './timeouts.ts';

/** How one attempt ended, as far as retrying is concerned. */
export type Outcome = { kind: 'status'; status: number } | { kind: 'error'; phase: Phase };

const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504, 529]);

/**
 * Whether another attempt (on the same model) may follow. A status is retried only if it says the provider,
 * not the request, was the problem; every other 4xx is the client's.
 * A body that broke mid-way, a deadline and unknown errors are never retried.
 */
export function isRetryable(o: Outcome): boolean {
  if (o.kind === 'status') return RETRYABLE_STATUSES.has(o.status);
  return o.phase === 'connect' || o.phase === 'headers';
}

// The gateway's own credential or model name is wrong for this provider (or the provider has dropped the
// model). The same request would fail again, but another provider may not share the problem.
const PROVIDER_SIDE_STATUSES = new Set([401, 403, 404]);

/**
 * Whether the next model in the chain may be tried: everything that is retryable, plus 401, 403 and 404.
 * The rest of the 4xx (400, 413, 422...) are about the request itself, so any model would refuse them.
 */
export function fallsOver(o: Outcome): boolean {
  return isRetryable(o) || (o.kind === 'status' && PROVIDER_SIDE_STATUSES.has(o.status));
}

/**
 * What a failed attempt says about the provider's health, for the breaker. Only a status the provider is to
 * blame for, or a connection that could not be made or answered, is a failure. A 429 is quota, not health,
 * and a 400 or 401 shows the provider is alive; both count as answered. Anything else tells nothing.
 */
export function breakerSignal(o: Outcome): 'failure' | 'answered' | 'abandoned' {
  if (o.kind === 'status') return o.status !== 429 && isRetryable(o) ? 'failure' : 'answered';
  return isRetryable(o) ? 'failure' : 'abandoned';
}

/**
 * Whether the same model may be tried again. A headers timeout may not: the provider could still be
 * working on, and billing, the request the gateway gave up on.
 */
export function retriesSameModel(o: Outcome): boolean {
  return isRetryable(o) && !(o.kind === 'error' && o.phase === 'headers');
}

export interface Backoff {
  baseMs: number;
  capMs: number;
}

/** Full jitter: retry n (1 is the first retry) waits a random time in [0, min(cap, base * 4^(n-1))). */
export function backoffMs(retry: number, { baseMs, capMs }: Backoff, random: () => number = Math.random): number {
  const ceiling = Math.min(capMs, baseMs * 4 ** (retry - 1));
  return Math.floor(random() * ceiling);
}

/** A retry-after header (whole seconds or an HTTP date) in ms from `nowMs`, or undefined if absent or unreadable. */
export function retryAfterMs(header: string | string[] | undefined, nowMs: number): number | undefined {
  const v = Array.isArray(header) ? header[0] : header;
  if (v === undefined) return undefined;
  const t = v.trim();
  if (/^\d+$/.test(t)) return Number(t) * 1000;
  const at = Date.parse(t);
  return Number.isNaN(at) ? undefined : Math.max(0, at - nowMs);
}

export interface RetryPolicy extends Backoff {
  /** Attempts per model, the first included. */
  maxAttempts: number;
  /** The longest retry-after the gateway will sit out. */
  retryAfterMaxMs: number;
  /** No attempt starts with less than this left of the call's deadline. */
  minRemainingMs: number;
}

export type RetryStep = { action: 'retry'; waitMs: number } | { action: 'next-model' };

/**
 * What follows a failed attempt: wait and try the same model again, or move to the next model.
 * `attemptsMade` counts attempts on this model so far, the one that just failed included.
 */
export function planRetry(
  a: { outcome: Outcome; retryAfter?: string | string[] | undefined; attemptsMade: number; remainingMs: number; nowMs: number },
  policy: RetryPolicy,
  random: () => number = Math.random,
): RetryStep {
  if (!retriesSameModel(a.outcome) || a.attemptsMade >= policy.maxAttempts) return { action: 'next-model' };
  const told = a.outcome.kind === 'status' ? retryAfterMs(a.retryAfter, a.nowMs) : undefined;
  const waitMs = told ?? backoffMs(a.attemptsMade, policy, random);
  if (told !== undefined && told > policy.retryAfterMaxMs) return { action: 'next-model' };
  if (a.remainingMs - waitMs < policy.minRemainingMs) return { action: 'next-model' };
  return { action: 'retry', waitMs };
}
