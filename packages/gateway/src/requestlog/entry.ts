// What goes through the request-log stream. Every entry is a flat list of string fields (a Redis stream entry
// is a field/value list), versioned with `v`, and is one of two kinds:
//   log    one per request: the row for request_log (written by the sink, after the response)
//   spend  a settled hold, a refund, or a cache hit: the rows for spend_ledger / tenant_spend (written by the
//          settle script in the same Redis call that changes the balance, so the two cannot come apart)
// The two kinds travel in two streams (see streamKey, spendKey) so that trimming one can never remove the other.
// Nothing here can carry prompt or completion text: the fields are ids, names of models and providers,
// counts, money in micro-USD, and timings.

export const ENTRY_VERSION = '1';

export interface LogEntry {
  requestId: string;
  /** Request start, unix ms (the gateway's clock). */
  startedAt: number;
  tenantId: string | null;
  keyId: string | null;
  /** The model the client asked for. */
  model: string | null;
  /** The model that served it, after any fallback. */
  servedModel: string | null;
  provider: string | null;
  status: number;
  errorCode: string | null;
  stream: boolean;
  promptTokens: number | null;
  completionTokens: number | null;
  costMicros: number;
  savedMicros: number;
  cache: string | null;
  attempts: number;
  fallbackUsed: boolean;
  latencyMs: number;
  ttfbMs: number | null;
  upstreamMs: number | null;
}

/** One settled hold (charge or refund) or one cache hit, as the ledger records it. */
export interface SpendEntry {
  /** `charge`: replaces the hold with what was spent. `refund`: drops the hold. `hit`: a zero-cost cache row. */
  kind: 'charge' | 'refund' | 'hit';
  /** The reservation id for a charge or refund (the request id); a fresh id for a hit. */
  id: string;
  tenantId: string;
  period: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
  costMicros: number;
  estimated: boolean;
  savedMicros: number;
  /** Which cache served a hit; absent for a charge or refund, and for a hit queued before the semantic cache (exact). */
  cacheKind?: 'exact' | 'semantic';
}

export type StreamEntry = { kind: 'log'; entry: LogEntry } | { kind: 'spend'; entry: SpendEntry };

const str = (v: string | number | boolean | null): string => (v === null ? '' : typeof v === 'boolean' ? (v ? '1' : '0') : String(v));

/** The entry as the flat field/value list XADD takes. Null becomes an empty string. */
export function toLogFields(e: LogEntry): string[] {
  return [
    'v', ENTRY_VERSION, 'k', 'log',
    'id', e.requestId, 'at', str(e.startedAt), 'tn', str(e.tenantId), 'ky', str(e.keyId),
    'md', str(e.model), 'sm', str(e.servedModel), 'pv', str(e.provider),
    'st', str(e.status), 'ec', str(e.errorCode), 'sr', str(e.stream),
    'pt', str(e.promptTokens), 'ct', str(e.completionTokens), 'co', str(e.costMicros), 'sv', str(e.savedMicros),
    'ch', str(e.cache), 'an', str(e.attempts), 'fb', str(e.fallbackUsed),
    'ms', str(e.latencyMs), 'tf', str(e.ttfbMs), 'up', str(e.upstreamMs),
  ];
}

export function toSpendFields(e: SpendEntry): string[] {
  return [
    'v', ENTRY_VERSION, 'k', 'spend',
    'id', e.id, 'sk', e.kind, 'tn', e.tenantId, 'pe', e.period, 'md', e.model,
    'pt', str(e.promptTokens), 'ct', str(e.completionTokens), 'co', str(e.costMicros),
    'es', str(e.estimated), 'sv', str(e.savedMicros), 'ck', e.cacheKind ?? '',
  ];
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PERIOD = /^\d{4}-\d{2}$/;

function map(fields: string[]): Map<string, string> {
  const m = new Map<string, string>();
  for (let i = 0; i + 1 < fields.length; i += 2) m.set(fields[i]!, fields[i + 1]!);
  return m;
}

const orNull = (v: string | undefined): string | null => (v === undefined || v === '' ? null : v);

// Integer fields are validated so a malformed entry fails here, once, instead of inside a batch insert.
function int(m: Map<string, string>, k: string): number {
  const v = m.get(k);
  if (v === undefined || !/^-?\d+$/.test(v)) throw new Error(`field ${k} is not an integer`);
  const n = Number(v);
  if (!Number.isSafeInteger(n)) throw new Error(`field ${k} is out of range`);
  return n;
}
const intOrNull = (m: Map<string, string>, k: string): number | null => (orNull(m.get(k)) === null ? null : int(m, k));
const uuid = (m: Map<string, string>, k: string): string => {
  const v = m.get(k);
  if (v === undefined || !UUID.test(v)) throw new Error(`field ${k} is not a uuid`);
  return v;
};
const uuidOrNull = (m: Map<string, string>, k: string): string | null => (orNull(m.get(k)) === null ? null : uuid(m, k));
const bool = (m: Map<string, string>, k: string): boolean => {
  const v = m.get(k);
  if (v !== '0' && v !== '1') throw new Error(`field ${k} is not a flag`);
  return v === '1';
};

/** Parses a stream entry. Throws on anything malformed or of an unknown version (the worker dead-letters it). */
export function fromStreamFields(fields: string[]): StreamEntry {
  const m = map(fields);
  if (m.get('v') !== ENTRY_VERSION) throw new Error('unknown entry version');
  const kind = m.get('k');
  if (kind === 'log') {
    return {
      kind: 'log',
      entry: {
        requestId: uuid(m, 'id'), startedAt: int(m, 'at'),
        tenantId: uuidOrNull(m, 'tn'), keyId: uuidOrNull(m, 'ky'),
        model: orNull(m.get('md')), servedModel: orNull(m.get('sm')), provider: orNull(m.get('pv')),
        status: int(m, 'st'), errorCode: orNull(m.get('ec')), stream: bool(m, 'sr'),
        promptTokens: intOrNull(m, 'pt'), completionTokens: intOrNull(m, 'ct'),
        costMicros: int(m, 'co'), savedMicros: int(m, 'sv'),
        cache: orNull(m.get('ch')), attempts: int(m, 'an'), fallbackUsed: bool(m, 'fb'),
        latencyMs: int(m, 'ms'), ttfbMs: intOrNull(m, 'tf'), upstreamMs: intOrNull(m, 'up'),
      },
    };
  }
  if (kind === 'spend') {
    const sk = m.get('sk');
    if (sk !== 'charge' && sk !== 'refund' && sk !== 'hit') throw new Error('unknown spend kind');
    const period = m.get('pe') ?? '';
    if (!PERIOD.test(period)) throw new Error('field pe is not a period');
    const ck = orNull(m.get('ck'));
    if (ck !== null && ck !== 'exact' && ck !== 'semantic') throw new Error('unknown cache kind');
    return {
      kind: 'spend',
      entry: {
        kind: sk, id: uuid(m, 'id'), tenantId: uuid(m, 'tn'), period, model: m.get('md') ?? '',
        promptTokens: int(m, 'pt'), completionTokens: int(m, 'ct'), costMicros: int(m, 'co'),
        estimated: bool(m, 'es'), savedMicros: int(m, 'sv'), ...(ck ? { cacheKind: ck } : {}),
      },
    };
  }
  throw new Error('unknown entry kind');
}

/**
 * The stream of request-log entries, under the instance's key prefix. It is length-capped (LOG_STREAM_MAX), so
 * under a worker outage the oldest log entries are dropped rather than Redis memory growing without bound.
 */
export const streamKey = (keyPrefix: string): string => `${keyPrefix}requestlog`;
/**
 * The stream of spend entries (settled holds, refunds, cache hits). Never length-capped: an entry here is
 * money, and is removed only once the worker has written it to Postgres.
 */
export const spendKey = (keyPrefix: string): string => `${keyPrefix}requestlog:spend`;
/** Entries the worker gave up on after too many deliveries. */
export const deadKey = (keyPrefix: string): string => `${keyPrefix}requestlog:dead`;

/** The `request_log` row for an entry: shared by the worker's batch insert and the inline sink. */
export function toRequestLogRow(e: LogEntry) {
  return {
    requestId: e.requestId, createdAt: new Date(e.startedAt), tenantId: e.tenantId, keyId: e.keyId, model: e.model,
    servedModel: e.servedModel, provider: e.provider, status: e.status, errorCode: e.errorCode, stream: e.stream,
    promptTokens: e.promptTokens, completionTokens: e.completionTokens, costMicros: e.costMicros, savedMicros: e.savedMicros,
    cache: e.cache, attempts: e.attempts, fallbackUsed: e.fallbackUsed, latencyMs: e.latencyMs, ttfbMs: e.ttfbMs, upstreamMs: e.upstreamMs,
  };
}
