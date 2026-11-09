import type { Config } from '../config.ts';

/** The three limits one upstream attempt lives under. */
export interface PhaseTimeouts {
  /** Opening the connection. */
  connectMs: number;
  /** Waiting for response headers (a non-streamed completion sends none until it is finished). */
  headersMs: number;
  /** Silence between body bytes. */
  idleMs: number;
}

export const phaseTimeouts = (c: Pick<Config, 'upstreamConnectTimeoutMs' | 'upstreamHeadersTimeoutMs' | 'upstreamIdleTimeoutMs'>): PhaseTimeouts => ({
  connectMs: c.upstreamConnectTimeoutMs,
  headersMs: c.upstreamHeadersTimeoutMs,
  idleMs: c.upstreamIdleTimeoutMs,
});

/**
 * Where an attempt failed.
 * - connect: no usable connection (refused, reset, unreachable, connect timeout); nothing was answered.
 * - headers: the request went out and no response headers came in time; the provider may still be working.
 * - body: silence while reading a body that had started.
 * - deadline: the call's own deadline or the client leaving aborted it.
 * - other: anything else (not retried).
 */
export type Phase = 'connect' | 'headers' | 'body' | 'deadline' | 'other';

const CONNECT_CODES = new Set([
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_SOCKET',
  'ECONNREFUSED',
  'ECONNRESET',
  'ECONNABORTED',
  'EPIPE',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ETIMEDOUT',
]);

/** Sorts an undici (or socket) error into the phase it failed in. */
export function phaseOf(err: unknown): Phase {
  const e = err as { code?: unknown; name?: unknown; cause?: unknown } | null;
  const code = typeof e?.code === 'string' ? e.code : '';
  if (code === 'UND_ERR_HEADERS_TIMEOUT') return 'headers';
  if (code === 'UND_ERR_BODY_TIMEOUT') return 'body';
  if (code === 'UND_ERR_ABORTED' || code === 'ABORT_ERR' || e?.name === 'AbortError') return 'deadline';
  if (CONNECT_CODES.has(code)) return 'connect';
  // An aggregate or wrapped error (happy-eyeballs connect failures) carries the code on its cause.
  if (e?.cause !== undefined && e.cause !== err) return phaseOf(e.cause);
  return 'other';
}
