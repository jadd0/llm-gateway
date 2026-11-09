import http, { type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { FastifyInstance } from 'fastify';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { keyStoreFromConfig } from '../auth/key-store.ts';
import { buildApp } from '../app.ts';
import { createDb, type Db } from '../db/client.ts';
import { cleanup, seedKey, testConfig } from '../test-env.ts';
import { formatReset } from './plugin.ts';

const base = testConfig();
const prefix = base.redisKeyPrefix;
const T0 = 1_700_000_000_000;
let now = T0; // pinned limiter clock: a bucket refills only when a test moves it
let upstreamHits = 0;
let upstream: Server;
let app: FastifyInstance;
let handle: Db;
let redis: Redis;
const tenantIds: string[] = [];

beforeAll(async () => {
  upstream = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      upstreamHits++;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"id":"x","choices":[]}');
    });
  });
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
  handle = createDb({ databaseUrl: base.databaseUrl, poolSize: 2 });
  redis = new Redis(base.redisUrl!);
  app = buildApp(
    testConfig({
      API_KEY_PEPPER: base.apiKeyPepper,
      REDIS_KEY_PREFIX: prefix,
      OPENAI_BASE_URL: `${url}/v1`,
      RATE_LIMIT_REDIS_TIMEOUT_MS: '5000',
    }),
    { rateLimitClock: () => now },
  );
  // A route that settles twice, to prove only the first settle counts.
  app.register(async (a) => {
    // Raw bytes, as the chat route keeps them.
    a.addContentTypeParser('application/json', { parseAs: 'buffer' }, (_req, body, done) => done(null, body));
    a.post('/__settle-twice', { config: { rateLimited: true } }, async (request) => {
      await request.rateLimit!.settle(500);
      await request.rateLimit!.settle(5);
      return { estimate: request.rateLimit!.estimate };
    });
  });
  await app.ready();
});

afterAll(async () => {
  await app.close();
  upstream.closeAllConnections();
  await new Promise((resolve) => upstream.close(resolve));
  await cleanup(handle.db, redis, tenantIds, prefix);
  redis.disconnect();
  await handle.close();
});

const fresh = async (limits: { rpm?: number; tpm?: number }) => {
  const s = await seedKey(handle.db, base, limits);
  tenantIds.push(s.tenantId);
  return s;
};
const chat = (key: string, body: unknown = { model: 'mock-m', messages: [{ role: 'user', content: 'hi' }], max_tokens: 10 }) =>
  app.inject({
    method: 'POST',
    url: '/v1/chat/completions',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    payload: typeof body === 'string' ? body : JSON.stringify(body),
  });
const field = async (keyId: string, bucket: 'req' | 'tok') =>
  Number(await redis.hget(`${prefix}rl:{${keyId}}:${bucket}`, 'tokens'));

describe('rate limit plugin', { timeout: 30_000 }, () => {
  it('429 carries retry-after, ratelimit headers and an OpenAI-shaped body', async () => {
    const s = await fresh({ rpm: 2, tpm: 100_000 });
    const first = await chat(s.key);
    expect(first.statusCode).toBe(200);
    expect(first.headers).toMatchObject({
      'x-ratelimit-limit-requests': '2',
      'x-ratelimit-remaining-requests': '1',
      'x-ratelimit-limit-tokens': '100000',
      'x-ratelimit-remaining-tokens': '99989', // 'hi' is 1 token + max_tokens 10
    });
    expect(first.headers['x-ratelimit-reset-requests']).toBe('30s');
    expect((await chat(s.key)).statusCode).toBe(200);
    const hits = upstreamHits;

    const res = await chat(s.key);
    expect(res.statusCode).toBe(429);
    expect(res.headers['retry-after']).toBe('30'); // one request token at 2 per minute
    expect(res.headers).toMatchObject({
      'x-ratelimit-limit-requests': '2',
      'x-ratelimit-remaining-requests': '0',
      'x-ratelimit-limit-tokens': '100000',
    });
    expect(res.headers['x-ratelimit-reset-requests']).toBeDefined();
    expect(res.headers['x-ratelimit-remaining-tokens']).toBeDefined();
    expect(res.headers['x-ratelimit-reset-tokens']).toBeDefined();
    const json = res.json();
    expect(json).toEqual({
      error: {
        message: expect.stringContaining('requests'),
        type: 'rate_limit_exceeded',
        code: 'rate_limit_exceeded',
      },
    });
    expect(upstreamHits).toBe(hits); // a rejected request never reaches the provider
  });

  it('retry-after rounds up to whole seconds', async () => {
    const s = await fresh({ rpm: 7, tpm: 100_000 });
    for (let i = 0; i < 7; i++) expect((await chat(s.key)).statusCode).toBe(200);
    const res = await chat(s.key);
    expect(res.statusCode).toBe(429);
    expect(res.headers['retry-after']).toBe('9'); // 60 / 7 = 8.57 s
  });

  it('only the first settle corrects the charge', async () => {
    const s = await fresh({ rpm: 100, tpm: 1000 });
    const res = await app.inject({
      method: 'POST',
      url: '/__settle-twice',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${s.key}` },
      payload: JSON.stringify({ model: 'mock-m', messages: [], max_tokens: 100 }),
    });
    expect(res.json()).toEqual({ estimate: 100 });
    // Charged 100, then corrected to an actual 500 (a 400 debit); the second settle(5) is ignored.
    expect(await field(s.keyId, 'tok')).toBe(500);
  });

  it('a denied request is not charged and a tokens-limited key says tokens', async () => {
    // Tokens run out first: each request costs 1 + 1024 (default max_tokens), the key holds 3000.
    const s = await fresh({ rpm: 100, tpm: 3000 });
    const plain = { model: 'mock-m', messages: [{ role: 'user', content: 'hi' }] };
    expect((await chat(s.key, plain)).statusCode).toBe(200);
    expect((await chat(s.key, plain)).statusCode).toBe(200);
    for (let i = 0; i < 5; i++) {
      const res = await chat(s.key, plain);
      expect(res.statusCode).toBe(429);
      expect(res.json().error.message).toContain('tokens');
    }
    // Requests consumed equals requests admitted, exactly: 100 - 2.
    expect(await field(s.keyId, 'req')).toBe(98);
    expect(await field(s.keyId, 'tok')).toBe(3000 - 2 * 1025);
  });

  it('request whose estimate exceeds tpm gets 400 request_too_large and touches no bucket', async () => {
    const s = await fresh({ rpm: 100, tpm: 500 });
    const hits = upstreamHits;
    // The caller asked for 1000 output tokens from a key that holds 500 a minute.
    const res = await chat(s.key, { model: 'mock-m', messages: [{ role: 'user', content: 'hi' }], max_tokens: 1000 });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatchObject({ type: 'invalid_request_error', code: 'request_too_large' });
    expect(res.headers['retry-after']).toBeUndefined();
    // A prompt alone bigger than the key's minute, with no max_tokens, is refused the same way.
    const big = await chat(s.key, { model: 'mock-m', messages: [{ role: 'user', content: 'x'.repeat(2400) }] });
    expect(big.statusCode).toBe(400);
    expect(big.json().error.code).toBe('request_too_large');
    expect(await redis.exists(`${prefix}rl:{${s.keyId}}:req`, `${prefix}rl:{${s.keyId}}:tok`)).toBe(0);
    expect(upstreamHits).toBe(hits);
    // The same key can still send a request that fits.
    expect((await chat(s.key)).statusCode).toBe(200);
  });

  it('a small request with no max_tokens is admitted by a key whose minute is smaller than the default allowance', async () => {
    const s = await fresh({ rpm: 100, tpm: 1000 });
    const res = await chat(s.key, { model: 'mock-m', messages: [{ role: 'user', content: 'hi' }] });
    expect(res.statusCode).toBe(200);
    // 1 prompt token plus the output allowance trimmed to what is left of the minute (999), not 1024.
    expect(res.headers['x-ratelimit-remaining-tokens']).toBe('0');
  });

  it('a body the route rejects is not charged', async () => {
    const s = await fresh({ rpm: 5, tpm: 100_000 });
    for (const body of [{}, { model: 'mock-m' }, { model: 1, messages: [] }, { model: 'mock-m', messages: 'x' }, { model: 'mock-m', messages: [], stream: 'yes' }]) {
      const res = await chat(s.key, body);
      expect(res.statusCode).toBe(400);
      expect(res.headers['x-ratelimit-limit-requests']).toBeUndefined();
    }
    expect(await redis.exists(`${prefix}rl:{${s.keyId}}:req`, `${prefix}rl:{${s.keyId}}:tok`)).toBe(0);
  });

  it('limit change via set-limits applies to the next request', async () => {
    const s = await fresh({ rpm: 1, tpm: 100_000 });
    expect((await chat(s.key)).statusCode).toBe(200);
    const blocked = await chat(s.key);
    expect(blocked.statusCode).toBe(429);
    expect(blocked.headers['x-ratelimit-limit-requests']).toBe('1');

    const store = keyStoreFromConfig(base, handle.db, redis);
    expect(await store.setLimits(s.hash, { rpm: 600, tpm: 100_000 })).toMatchObject({ updated: true, cached: true });
    now += 6000; // 6 s at the new rate (10 per second) is 60 request tokens
    const res = await chat(s.key);
    expect(res.statusCode).toBe(200);
    expect(res.headers['x-ratelimit-limit-requests']).toBe('600');
  });

  it('a body that is not a JSON object is left to the route and charges nothing', async () => {
    const s = await fresh({ rpm: 5, tpm: 100_000 });
    for (const body of ['not json', '[1,2]', 'null']) {
      const res = await chat(s.key, body);
      expect(res.statusCode).toBe(400);
      expect(res.headers['x-ratelimit-limit-requests']).toBeUndefined();
    }
    expect(await redis.exists(`${prefix}rl:{${s.keyId}}:req`)).toBe(0);
  });

  it('unknown routes and unauthenticated calls are not limited', async () => {
    const s = await fresh({ rpm: 1, tpm: 1000 });
    for (let i = 0; i < 3; i++) {
      const res = await app.inject({ method: 'GET', url: '/v1/nope', headers: { authorization: `Bearer ${s.key}` } });
      expect(res.statusCode).toBe(404);
    }
    expect(await redis.exists(`${prefix}rl:{${s.keyId}}:req`)).toBe(0);
  });

  it('Redis unreachable: requests are served without ratelimit headers', async () => {
    const open = buildApp(
      testConfig({
        API_KEY_PEPPER: base.apiKeyPepper,
        REDIS_KEY_PREFIX: prefix,
        OPENAI_BASE_URL: `http://127.0.0.1:${(upstream.address() as AddressInfo).port}/v1`,
        REDIS_URL: 'redis://127.0.0.1:1',
        AUTH_CACHE: 'none', // the key is looked up in Postgres, so only the limiter sees the dead Redis
      }),
    );
    try {
      const s = await fresh({ rpm: 1, tpm: 100_000 });
      for (let i = 0; i < 3; i++) {
        const res = await open.inject({
          method: 'POST',
          url: '/v1/chat/completions',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${s.key}` },
          payload: JSON.stringify({ model: 'mock-m', messages: [], max_tokens: 5 }),
        });
        expect(res.statusCode).toBe(200);
        expect(res.headers['x-ratelimit-limit-requests']).toBeUndefined();
      }
    } finally {
      await open.close();
    }
  });
});

describe('formatReset', () => {
  it('writes durations the way OpenAI does', () => {
    expect(formatReset(0)).toBe('0ms');
    expect(formatReset(20)).toBe('20ms');
    expect(formatReset(1000)).toBe('1s');
    expect(formatReset(1500)).toBe('1.5s');
    expect(formatReset(30_000)).toBe('30s');
    expect(formatReset(60_000)).toBe('1m0s');
    expect(formatReset(360_000)).toBe('6m0s');
  });
});
