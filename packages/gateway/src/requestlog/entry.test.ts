import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { fromStreamFields, toLogFields, toSpendFields, type LogEntry, type SpendEntry } from './entry.ts';

const log = (over: Partial<LogEntry> = {}): LogEntry => ({
  requestId: randomUUID(), startedAt: 1_700_000_000_123, tenantId: randomUUID(), keyId: randomUUID(), model: 'mock-ok',
  servedModel: 'mock-b', provider: 'mock-openai', status: 200, errorCode: 'upstream_timeout', stream: true, promptTokens: 7,
  completionTokens: 12, costMicros: 31, savedMicros: 9, cache: 'miss', attempts: 2, fallbackUsed: true, latencyMs: 123,
  ttfbMs: 40, upstreamMs: 99, ...over,
});
const spend = (over: Partial<SpendEntry> = {}): SpendEntry => ({
  kind: 'charge', id: randomUUID(), tenantId: randomUUID(), period: '2026-11', model: 'mock-ok', promptTokens: 1,
  completionTokens: 10, costMicros: 31, estimated: true, savedMicros: 0, ...over,
});

describe('stream entries', () => {
  it('round-trips every field through stream fields', () => {
    const full = log();
    expect(fromStreamFields(toLogFields(full))).toEqual({ kind: 'log', entry: full });
    // Nulls (a refused request has no tenant, model, provider or timing) survive as nulls, and zero is not null.
    const bare = log({ tenantId: null, keyId: null, model: null, servedModel: null, provider: null, errorCode: null, promptTokens: null, completionTokens: null, cache: null, ttfbMs: null, upstreamMs: null, costMicros: 0, attempts: 0, fallbackUsed: false, stream: false, status: 401 });
    expect(fromStreamFields(toLogFields(bare))).toEqual({ kind: 'log', entry: bare });
    for (const kind of ['charge', 'refund', 'hit'] as const) {
      const s = spend({ kind, estimated: kind === 'charge', savedMicros: kind === 'hit' ? 55 : 0 });
      expect(fromStreamFields(toSpendFields(s))).toEqual({ kind: 'spend', entry: s });
    }
    // Every field is a flat string, and the version is first.
    expect(toLogFields(full).every((f) => typeof f === 'string')).toBe(true);
    expect(toLogFields(full).slice(0, 2)).toEqual(['v', '1']);
  });

  it('carries no message text, header or key: only the named fields', () => {
    const fields = toLogFields(log());
    const names = fields.filter((_, i) => i % 2 === 0);
    expect(names.sort()).toEqual(['an', 'at', 'ch', 'co', 'ct', 'ec', 'fb', 'id', 'k', 'ky', 'md', 'ms', 'pt', 'pv', 'sm', 'sr', 'st', 'sv', 'tf', 'tn', 'up', 'v']);
    const spendNames = toSpendFields(spend()).filter((_, i) => i % 2 === 0);
    expect(spendNames.sort()).toEqual(['ck', 'co', 'ct', 'es', 'id', 'k', 'md', 'pe', 'pt', 'sk', 'sv', 'tn', 'v']);
    // A value that looks like a key or a message cannot ride in an id or counter field: it does not parse.
    const withKey = toLogFields(log());
    withKey[withKey.indexOf('id') + 1] = 'gw_secretkeysecretkey';
    expect(() => fromStreamFields(withKey)).toThrow();
    const withText = toLogFields(log());
    withText[withText.indexOf('pt') + 1] = 'hello, what is the capital of France';
    expect(() => fromStreamFields(withText)).toThrow();
  });

  it('a hit carries which cache served it, and a value that names no cache is refused', () => {
    for (const cacheKind of ['exact', 'semantic'] as const) {
      const hit = spend({ kind: 'hit', cacheKind });
      expect(fromStreamFields(toSpendFields(hit))).toEqual({ kind: 'spend', entry: hit });
    }
    const bad = toSpendFields(spend({ kind: 'hit', cacheKind: 'semantic' }));
    bad[bad.indexOf('ck') + 1] = 'fuzzy';
    expect(() => fromStreamFields(bad)).toThrow('cache kind');
  });

  it('refuses an unknown version, kind or malformed value', () => {
    expect(() => fromStreamFields(['v', '2', 'k', 'log'])).toThrow('version');
    expect(() => fromStreamFields(['v', '1', 'k', 'other'])).toThrow('kind');
    expect(() => fromStreamFields([])).toThrow();
    const bad = toSpendFields(spend());
    bad[bad.indexOf('pe') + 1] = 'november';
    expect(() => fromStreamFields(bad)).toThrow('period');
  });
});
