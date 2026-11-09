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

const HEADERS_CODES = new Set(['UND_ERR_HEADERS_TIMEOUT']);
const BODY_CODES = new Set(['UND_ERR_BODY_TIMEOUT']);
const DEADLINE_CODES = new Set(['UND_ERR_ABORTED', 'ABORT_ERR']);
const TIMEOUT_CODES = new Set(['UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT', 'UND_ERR_CONNECT_TIMEOUT']);
const KNOWN_CODES = new Set([...CONNECT_CODES, ...HEADERS_CODES, ...BODY_CODES, ...DEADLINE_CODES]);

/**
 * Walks an error and its causes (an aggregate or wrapped error, as happy-eyeballs connect failures are, carries
 * the code on its cause) and returns the first code that is in `wanted`, or '' if none is. An AbortError by
 * name counts as ABORT_ERR.
 */
export function codeOf(err: unknown, wanted: ReadonlySet<string> = KNOWN_CODES): string {
  const seen = new Set<unknown>();
  let e: unknown = err;
  while (e !== null && typeof e === 'object' && !seen.has(e) && seen.size < 8) {
    seen.add(e);
    const { code, name, cause } = e as { code?: unknown; name?: unknown; cause?: unknown };
    if (typeof code === 'string' && wanted.has(code)) return code;
    if (name === 'AbortError' && wanted.has('ABORT_ERR')) return 'ABORT_ERR';
    e = cause;
  }
  return '';
}

/** Sorts an undici (or socket) error into the phase it failed in. */
export function phaseOf(err: unknown): Phase {
  const code = codeOf(err);
  if (HEADERS_CODES.has(code)) return 'headers';
  if (BODY_CODES.has(code)) return 'body';
  if (DEADLINE_CODES.has(code)) return 'deadline';
  if (CONNECT_CODES.has(code)) return 'connect';
  return 'other';
}

/** Whether an error is a timeout of any of the three limits (a connect timeout is a connect-phase error). */
export function isTimeout(err: unknown): boolean {
  return codeOf(err, TIMEOUT_CODES) !== '';
}
