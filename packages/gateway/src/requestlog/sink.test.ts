import { randomUUID } from 'node:crypto';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../app.ts';
import { cleanup, testConfig } from '../test-env.ts';
import { createDb, type Db } from '../db/client.ts';
import { fromStreamFields, streamKey, toLogFields, type LogEntry } from './entry.ts';
import { createStreamSink } from './sink.ts';

const entry = (n: number): LogEntry => ({
  requestId: randomUUID(), startedAt: n, tenantId: null, keyId: null, model: 'm', servedModel: null, provider: null, status: 200,
  errorCode: null, stream: false, promptTokens: null, completionTokens: null, costMicros: 0, savedMicros: 0, cache: null, attempts: 0,
  fallbackUsed: false, latencyMs: n, ttfbMs: null, upstreamMs: null,
});

// A Redis that takes XADD only while `up`, and remembers what it took, in order.
function fakeRedis() {
  const state = { up: false, taken: [] as string[][] };
  return {
    state,
    redis: {
      xadd: async (_key: string, _id: string, ...fields: string[]) => {
        if (!state.up) throw Object.assign(new Error('Connection is closed.'), { code: 'ECONNRESET' });
        state.taken.push(fields);
        return '1-0';
      },
    } as never,
  };
}
const startedAts = (taken: string[][]) => taken.map((f) => (fromStreamFields(f) as { entry: LogEntry }).entry.startedAt);
const until = async (done: () => boolean) => {
  const end = Date.now() + 5000;
  while (!done() && Date.now() < end) await new Promise((r) => setTimeout(r, 5));
  expect(done()).toBe(true);
};

describe('stream sink', () => {
  it('redis down buffers then flushes in order', async () => {
    const f = fakeRedis();
    const sink = createStreamSink({ redis: f.redis, keyPrefix: 'p:', bufferMax: 100, flushMs: 10 });
    for (let i = 1; i <= 5; i++) sink.write(entry(i));
    await until(() => sink.buffered() === 5);
    expect(f.state.taken).toHaveLength(0);
    // A write behind buffered ones waits its turn rather than overtaking them.
    f.state.up = true;
    sink.write(entry(6));
    await until(() => f.state.taken.length === 6);
    expect(startedAts(f.state.taken)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(sink.buffered()).toBe(0);
    expect(sink.dropped()).toBe(0);
    await sink.close();
  });

  it('buffer overflow drops and counts', async () => {
    const f = fakeRedis();
    const warnings: object[] = [];
    const sink = createStreamSink({ redis: f.redis, keyPrefix: 'p:', bufferMax: 3, flushMs: 10, log: { warn: (o) => void warnings.push(o) } });
    for (let i = 1; i <= 5; i++) sink.write(entry(i));
    await until(() => sink.buffered() + sink.dropped() === 5);
    expect(sink.buffered()).toBe(3);
    expect(sink.dropped()).toBe(2);
    f.state.up = true;
    await until(() => f.state.taken.length === 3);
    expect(startedAts(f.state.taken)).toEqual([1, 2, 3]); // the oldest were kept
    expect(warnings.some((w) => 'dropped' in w)).toBe(true);
    await sink.close();
  });

  it('close flushes the buffer when Redis is back, and drops (counted) what it cannot send', async () => {
    const f = fakeRedis();
    const sink = createStreamSink({ redis: f.redis, keyPrefix: 'p:', bufferMax: 100, flushMs: 100_000, closeWaitMs: 300 });
    sink.write(entry(1));
    sink.write(entry(2));
    await until(() => sink.buffered() === 2);
    f.state.up = true;
    await sink.close(); // no timer tick needed
    expect(startedAts(f.state.taken)).toEqual([1, 2]);

    const g = fakeRedis();
    const stuck = createStreamSink({ redis: g.redis, keyPrefix: 'p:', bufferMax: 100, flushMs: 100_000, closeWaitMs: 100 });
    stuck.write(entry(1));
    await until(() => stuck.buffered() === 1);
    await stuck.close();
    expect(stuck.buffered()).toBe(0);
    expect(stuck.dropped()).toBe(1);
  });
});

describe('graceful shutdown', () => {
  const base = testConfig();
  let handle: Db;
  let redis: Redis;
  beforeAll(() => {
    handle = createDb({ databaseUrl: base.databaseUrl, poolSize: 2 });
    redis = new Redis(base.redisUrl!);
  });
  afterAll(async () => {
    await cleanup(handle.db, redis, [], base.redisKeyPrefix);
    redis.disconnect();
    await handle.close();
  });

  it('app.close() sends the entries still buffered before it lets go of Redis', async () => {
    const prefix = `${base.redisKeyPrefix}shutdown:`;
    const app = buildApp(testConfig({ REDIS_KEY_PREFIX: prefix, API_KEY_PEPPER: base.apiKeyPepper, RATE_LIMIT_ENABLED: 'false', BUDGET_ENABLED: 'false', CACHE_ENABLED: 'false' }));
    await app.ready();
    // Unauthenticated requests are still logged. Redis is made unreachable for the app's client for a moment by
    // pointing a copy of the sink at a closed port is not possible here, so the entries are in flight at close.
    const sent = await Promise.all(Array.from({ length: 20 }, () => app.inject({ method: 'GET', url: '/nothing', headers: { authorization: 'Bearer gw_x' } })));
    expect(sent.every((r) => r.statusCode === 401)).toBe(true);
    await app.close();
    const rows = await redis.xrange(streamKey(prefix), '-', '+');
    expect(rows).toHaveLength(20);
    expect(rows.every(([, f]) => fromStreamFields(f).kind === 'log')).toBe(true);
    void toLogFields;
  });
});
