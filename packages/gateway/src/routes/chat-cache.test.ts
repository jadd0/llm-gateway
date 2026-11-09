import { randomBytes } from 'node:crypto';
import http, { type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { FastifyInstance } from 'fastify';
import { and, eq, sql } from 'drizzle-orm';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../app.ts';
import { keyStoreFromConfig } from '../auth/key-store.ts';
import { periodOf } from '../budget/period.ts';
import { KEY_VERSION } from '../cache/key.ts';
import type { CacheFill } from '../cache/plugin.ts';
import { createDb, type Db } from '../db/client.ts';
import { spendLedger, tenants, tenantSpend } from '../db/schema.ts';
import { cleanup, seedKey, testConfig } from '../test-env.ts';

// The upstream stands in for the provider and counts the calls it gets. Its answer says which call made it, so a
// reply served from the cache is told apart from a fresh one. Behaviour is picked by model name:
//   mock-a        answers "answer-<n>" (1 prompt + 10 completion tokens: 31 micro-USD at the mock price)
//   mock-b        the same, for fallback targets
//   mock-big      like mock-a but reports 100000 tokens used
//   mock-slow     like mock-a after 300 ms, so identical requests overlap
//   mock-500      answers 500
//   mock-lead500  its first call waits 200 ms and answers 500; later calls answer
//   mock-fb-a     answers 500 (first in a fallback chain to mock-b)
//   mock-filter   finishes with content_filter
const base = testConfig({
  CACHE_ENABLED: 'true',
  BUDGET_ENABLED: 'true',
  BUDGET_REDIS_TIMEOUT_MS: '5000',
  RATE_LIMIT_REDIS_TIMEOUT_MS: '5000',
  CACHE_REDIS_TIMEOUT_MS: '2000',
  MODEL_FALLBACKS: 'mock-fb-a>mock-b',
});
const prefix = base.redisKeyPrefix;
const T0 = 1_700_000_000_000;

let upstream: Server;
let app: FastifyInstance;
let handle: Db;
let redis: Redis;
let gw = '';
const calls: Record<string, number> = {};
const abandons: Record<string, number> = {};
const total = () => Object.values(calls).reduce((a, b) => a + b, 0);
const tenantIds: string[] = [];
let cacheDown = false;

beforeAll(async () => {
  upstream = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', async () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { model: string; stream?: boolean; stream_options?: { include_usage?: boolean } };
      const n = (calls[body.model] = (calls[body.model] ?? 0) + 1);
      if (body.model === 'mock-slow') await new Promise((r) => setTimeout(r, 300));
      if (body.model === 'mock-lead500' && n === 1) {
        await new Promise((r) => setTimeout(r, 200));
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end('{"error":{"message":"boom"}}');
        return;
      }
      if (body.model === 'mock-500' || body.model === 'mock-fb-a') {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end('{"error":{"message":"boom"}}');
        return;
      }
      const finish = body.model === 'mock-filter' ? 'content_filter' : 'stop';
      const usage = body.model === 'mock-big' ? { prompt_tokens: 1, completion_tokens: 99_999, total_tokens: 100_000 } : { prompt_tokens: 1, completion_tokens: 10, total_tokens: 11 };
      const text = `answer-${n}`;
      if (body.stream) {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        const send = (o: unknown) => res.write(`data: ${JSON.stringify(o)}\n\n`);
        send({ id: 'c', model: body.model, choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] });
        send({ id: 'c', model: body.model, choices: [{ index: 0, delta: { content: text.slice(0, 3) }, finish_reason: null }] });
        send({ id: 'c', model: body.model, choices: [{ index: 0, delta: { content: text.slice(3) }, finish_reason: null }] });
        send({ id: 'c', model: body.model, choices: [{ index: 0, delta: {}, finish_reason: finish }] });
        if (body.stream_options?.include_usage) send({ id: 'c', model: body.model, choices: [], usage });
        res.end('data: [DONE]\n\n');
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({ id: 'c', object: 'chat.completion', model: body.model, choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: finish }], usage }),
      );
    });
  });
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  handle = createDb({ databaseUrl: base.databaseUrl, poolSize: 8 });
  redis = new Redis(base.redisUrl!);
  app = buildApp(
    testConfig({
      API_KEY_PEPPER: base.apiKeyPepper,
      REDIS_KEY_PREFIX: prefix,
      OPENAI_BASE_URL: `http://127.0.0.1:${(upstream.address() as AddressInfo).port}/v1`,
      CACHE_ENABLED: 'true',
      BUDGET_ENABLED: 'true',
      BUDGET_REDIS_TIMEOUT_MS: '5000',
      BUDGET_EPOCH_REFRESH_MS: '3600000',
      RATE_LIMIT_REDIS_TIMEOUT_MS: '5000',
      CACHE_REDIS_TIMEOUT_MS: '2000',
      MODEL_FALLBACKS: 'mock-fb-a>mock-b',
      CACHE_REPLAY_CHUNK_CHARS: '4',
    }),
    {
      rateLimitClock: () => T0,
      cacheClock: () => T0,
      wrapCacheStore: (s) => ({
        get: async (k) => (cacheDown ? { status: 'unavailable' } : s.get(k)),
        set: async (k, e) => (cacheDown ? 'unavailable' : s.set(k, e)),
      }),
    },
  );
  // Counts `abandon` calls per prompt: the fill is wrapped as the cache plugin assigns it to the request.
  app.addHook('onRequest', async (request) => {
    let fill: CacheFill | null = null;
    Object.defineProperty(request, 'cacheFill', {
      get: () => fill,
      set: (f: CacheFill | null) => {
        const content = (JSON.parse((request.body as Buffer).toString('utf8')) as { messages: Array<{ content?: string }> }).messages[0]?.content;
        if (f && typeof content === 'string') {
          const abandon = f.abandon.bind(f);
          f.abandon = () => {
            abandons[content] = (abandons[content] ?? 0) + 1;
            abandon();
          };
        }
        fill = f;
      },
    });
  });
  await app.listen({ port: 0, host: '127.0.0.1' });
  gw = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await app.close();
  upstream.closeAllConnections();
  await new Promise((resolve) => upstream.close(resolve));
  await cleanup(handle.db, redis, tenantIds, prefix);
  redis.disconnect();
  await handle.close();
});

const uniq = () => `prompt ${randomBytes(6).toString('hex')}`;
async function tenant(shared = false) {
  const s = await seedKey(handle.db, base);
  tenantIds.push(s.tenantId);
  if (shared) await handle.db.update(tenants).set({ cacheShared: true }).where(eq(tenants.id, s.tenantId));
  return s;
}
const req = (model: string, content: string, extra: object = {}) => ({ model, temperature: 0, max_tokens: 20, messages: [{ role: 'user', content }], ...extra });
const post = (key: string, body: object, headers: Record<string, string> = {}) =>
  fetch(`${gw}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}`, ...headers },
    body: JSON.stringify(body),
  });
const json = async (res: Response) => (await res.json()) as any;
const until = async (cond: () => Promise<boolean> | boolean, timeoutMs = 3000) => {
  const end = Date.now() + timeoutMs;
  while (!(await cond()) && Date.now() < end) await new Promise((r) => setTimeout(r, 15));
  return cond();
};
// The cache entries (not locks) a scope holds.
const entries = async (scope: string) => (await redis.keys(`${prefix}cache:${KEY_VERSION}:${scope}:*`)).filter((k) => !k.endsWith(':lock'));
const sse = (text: string) =>
  text
    .split('\n\n')
    .filter(Boolean)
    .map((e) => (e === 'data: [DONE]' ? '[DONE]' : JSON.parse(e.slice(6))));
const contentOf = (events: any[]) => events.filter((e) => e !== '[DONE]').map((e) => e.choices[0]?.delta?.content ?? '').join('');

describe('response cache on POST /v1/chat/completions', () => {
  it('second identical request is a hit with no upstream call', async () => {
    const t = await tenant();
    const body = req('mock-a', uniq());
    const before = calls['mock-a'] ?? 0;
    const first = await post(t.key, body);
    expect(first.status).toBe(200);
    expect(first.headers.get('x-gateway-cache')).toBe('miss');
    const firstJson = await json(first);
    expect(firstJson.choices[0].message.content).toBe(`answer-${before + 1}`);

    const second = await post(t.key, body);
    expect(second.status).toBe(200);
    expect(second.headers.get('x-gateway-cache')).toBe('hit');
    expect(second.headers.get('x-gateway-attempts')).toBe('0');
    expect(second.headers.get('x-gateway-model')).toBe('mock-a');
    expect(calls['mock-a']).toBe(before + 1);
    const hit = await json(second);
    expect(hit.object).toBe('chat.completion');
    expect(hit.id).toMatch(/^chatcmpl-cache-/);
    expect(hit.id).not.toBe(firstJson.id);
    expect(hit.created).toBe(T0 / 1000);
    expect(hit.model).toBe('mock-a');
    expect(hit.choices[0].message.content).toBe(`answer-${before + 1}`);
    expect(hit.choices[0].finish_reason).toBe('stop');
    expect(hit.usage).toEqual({ prompt_tokens: 1, completion_tokens: 10, total_tokens: 11 });
    // The stream flag, field order, a string vs a text part and fields that do not matter: the same entry.
    const reshaped = { max_tokens: 20, messages: [{ content: [{ type: 'text', text: body.messages[0]!.content }], role: 'user' }], model: 'mock-a', temperature: 0, user: 'someone', metadata: { x: 1 } };
    expect((await post(t.key, reshaped)).headers.get('x-gateway-cache')).toBe('hit');
    expect(calls['mock-a']).toBe(before + 1);
  });

  it('streamed request hits an entry made by a non-streamed one, and the other way round', async () => {
    const t = await tenant();
    const body = req('mock-a', uniq());
    const n0 = calls['mock-a'] ?? 0;
    const made = await json(await post(t.key, body));
    const text = made.choices[0].message.content as string;

    const streamed = await post(t.key, { ...body, stream: true });
    expect(streamed.headers.get('x-gateway-cache')).toBe('hit');
    expect(streamed.headers.get('content-type')).toBe('text/event-stream');
    const events = sse(await streamed.text());
    expect(events.at(-1)).toBe('[DONE]');
    expect(contentOf(events)).toBe(text);
    expect(events.filter((e) => e !== '[DONE]' && e.choices[0]?.delta?.content).length).toBeGreaterThan(1); // cut into pieces
    expect(events.some((e) => e !== '[DONE]' && 'usage' in e)).toBe(false); // not asked for
    expect(calls['mock-a']).toBe(n0 + 1);

    const withUsage = sse(await (await post(t.key, { ...body, stream: true, stream_options: { include_usage: true } })).text());
    expect(withUsage.at(-2)).toMatchObject({ choices: [], usage: { prompt_tokens: 1, completion_tokens: 10, total_tokens: 11 } });

    // A streamed miss fills the cache for the non-streamed request that follows.
    const other = req('mock-a', uniq());
    const miss = await post(t.key, { ...other, stream: true });
    expect(miss.headers.get('x-gateway-cache')).toBe('miss');
    const streamedText = contentOf(sse(await miss.text()));
    expect(streamedText).toMatch(/^answer-\d+$/);
    expect(await until(async () => (await entries(t.tenantId)).length === 2)).toBe(true);
    const hit = await post(t.key, other);
    expect(hit.headers.get('x-gateway-cache')).toBe('hit');
    expect((await json(hit)).choices[0].message.content).toBe(streamedText);
  });

  it('no-store bypasses read and write', async () => {
    const t = await tenant();
    const body = req('mock-a', uniq());
    const n0 = calls['mock-a'] ?? 0;
    const skipped = await post(t.key, body, { 'cache-control': 'no-store' });
    expect(skipped.headers.get('x-gateway-cache')).toBe('bypass');
    expect(await entries(t.tenantId)).toHaveLength(0); // not written
    expect((await post(t.key, body)).headers.get('x-gateway-cache')).toBe('miss'); // nothing to read
    expect(await entries(t.tenantId)).toHaveLength(1);
    const again = await post(t.key, body, { 'cache-control': 'max-age=0, No-Store' });
    expect(again.headers.get('x-gateway-cache')).toBe('bypass'); // present entry, not read
    expect((await json(again)).choices[0].message.content).toBe(`answer-${n0 + 3}`);
    expect(calls['mock-a']).toBe(n0 + 3);
  });

  it('no-cache refreshes', async () => {
    const t = await tenant();
    const body = req('mock-a', uniq());
    const n0 = calls['mock-a'] ?? 0;
    await post(t.key, body);
    const refreshed = await post(t.key, body, { 'cache-control': 'no-cache' });
    expect(refreshed.headers.get('x-gateway-cache')).toBe('refresh');
    expect((await json(refreshed)).choices[0].message.content).toBe(`answer-${n0 + 2}`);
    const next = await post(t.key, body);
    expect(next.headers.get('x-gateway-cache')).toBe('hit');
    expect((await json(next)).choices[0].message.content).toBe(`answer-${n0 + 2}`); // the refreshed answer
    expect(calls['mock-a']).toBe(n0 + 2);
  });

  it("private tenant never sees another tenant's entry", async () => {
    const a = await tenant();
    const b = await tenant();
    const body = req('mock-a', uniq());
    const n0 = calls['mock-a'] ?? 0;
    const made = await json(await post(a.key, body));
    expect((await post(a.key, body)).headers.get('x-gateway-cache')).toBe('hit'); // A can read its own: the control
    // B sends the identical bytes: a miss, answered by the provider.
    const first = await post(b.key, body);
    expect(first.headers.get('x-gateway-cache')).toBe('miss');
    const bContent = (await json(first)).choices[0].message.content;
    expect(bContent).toBe(`answer-${n0 + 2}`);
    expect(bContent).not.toBe(made.choices[0].message.content);
    // Then every field and header that might name A: B only ever gets B's own answer.
    const attempts: [object, Record<string, string>][] = [
      [{ ...body, user: a.tenantId, metadata: { tenant: a.tenantId, tenantName: a.tenant } }, { 'x-tenant-id': a.tenantId, 'openai-organization': a.tenant, 'x-gateway-tenant': a.tenantId }],
      [{ ...body, stream: true }, { 'x-tenant-id': a.tenantId }],
    ];
    for (const [b1, headers] of attempts) {
      const res = await post(b.key, b1, headers);
      expect(res.headers.get('x-gateway-cache')).toBe('hit');
      const text = await res.text();
      const answer = text.startsWith('data:') ? contentOf(sse(text)) : (JSON.parse(text).choices[0].message.content as string);
      expect(answer).toBe(bContent);
    }
    expect(calls['mock-a']).toBe(n0 + 2); // A's miss and B's miss, nothing else reached the provider
    expect(await entries(a.tenantId)).toHaveLength(1);
    expect((await entries(b.tenantId)).length).toBe(1);
  });

  it('shared tenants share, private tenants do not see shared', async () => {
    const s1 = await tenant(true);
    const s2 = await tenant(true);
    const p = await tenant();
    const body = req('mock-a', uniq());
    const n0 = calls['mock-a'] ?? 0;
    const made = await json(await post(s1.key, body));
    const s2res = await post(s2.key, body);
    expect(s2res.headers.get('x-gateway-cache')).toBe('hit');
    expect((await json(s2res)).choices[0].message.content).toBe(made.choices[0].message.content);
    expect(calls['mock-a']).toBe(n0 + 1);
    // A private tenant does not read the pool, and a shared tenant does not read a private tenant's entries.
    const pres = await post(p.key, body);
    expect(pres.headers.get('x-gateway-cache')).toBe('miss');
    await pres.text();
    const pOwn = req('mock-a', uniq());
    await post(p.key, pOwn);
    expect((await post(p.key, pOwn)).headers.get('x-gateway-cache')).toBe('hit');
    expect((await post(s1.key, pOwn)).headers.get('x-gateway-cache')).toBe('miss');
    expect(await entries(p.tenantId)).toHaveLength(2);
    expect((await entries('shared')).length).toBeGreaterThanOrEqual(2);
  });

  it('hit writes a zero-cost ledger row with saved_micros, and the balance does not move', async () => {
    const t = await tenant();
    const body = req('mock-a', uniq());
    const period = periodOf(Date.now());
    await post(t.key, body);
    const spendRow = async () =>
      (await handle.db.select().from(tenantSpend).where(and(eq(tenantSpend.tenantId, t.tenantId), eq(tenantSpend.period, period))))[0];
    expect(await until(async () => (await spendRow())?.spentMicros === 31)).toBe(true);
    const before = (await spendRow())!;
    for (let i = 0; i < 10; i++) expect((await post(t.key, body)).headers.get('x-gateway-cache')).toBe('hit');
    const ledger = () =>
      handle.db
        .select({
          rows: sql<string>`count(*)`,
          hits: sql<string>`count(*) filter (where ${spendLedger.cached})`,
          cost: sql<string>`coalesce(sum(${spendLedger.costMicros}), 0)`,
          saved: sql<string>`coalesce(sum(${spendLedger.savedMicros}), 0)`,
          prompt: sql<string>`coalesce(sum(${spendLedger.promptTokens}) filter (where ${spendLedger.cached}), 0)`,
          completion: sql<string>`coalesce(sum(${spendLedger.completionTokens}) filter (where ${spendLedger.cached}), 0)`,
        })
        .from(spendLedger)
        .where(eq(spendLedger.tenantId, t.tenantId));
    expect(await until(async () => Number((await ledger())[0]!.hits) === 10)).toBe(true);
    const [sum] = await ledger();
    expect(Number(sum!.rows)).toBe(11);
    expect(Number(sum!.cost)).toBe(31); // only the miss cost anything
    expect(Number(sum!.saved)).toBe(310); // 10 hits x 31
    expect([Number(sum!.prompt), Number(sum!.completion)]).toEqual([10, 100]);
    expect(await spendRow()).toEqual(before); // spend and charge count untouched
  });

  it('hit refunds the token estimate and counts one request', async () => {
    const t = await tenant();
    // The token bucket's Redis key expires on the real clock while the limiter's clock is pinned, and a nearly
    // full bucket expires within milliseconds: a correction arriving after that finds no bucket and starts from
    // a full one. A large max_tokens makes the estimate take enough of the bucket to outlast the upstream call,
    // and a provider that reports 100000 tokens used then keeps it half empty.
    const body = req('mock-big', uniq(), { max_tokens: 5000 });
    const remaining = (res: Response, kind: 'requests' | 'tokens') => Number(res.headers.get(`x-ratelimit-remaining-${kind}`));
    // The bucket as Redis holds it. Corrections to it are sent without the request waiting for them, so each
    // step waits until the bucket shows what it should.
    const bucket = async () => Number(await redis.hget(`${prefix}rl:{${t.keyId}}:tok`, 'tokens'));
    const miss = await post(t.key, body);
    await miss.text();
    expect(miss.headers.get('x-gateway-cache')).toBe('miss');
    const limit = Number(miss.headers.get('x-ratelimit-limit-tokens'));
    await until(async () => (await bucket()) === limit - 100_000); // settled to the real usage
    expect(await bucket()).toBe(limit - 100_000);

    const h1 = await post(t.key, body);
    await h1.text();
    expect(h1.headers.get('x-gateway-cache')).toBe('hit');
    // The hit took its estimate and gave it back: the bucket is what the miss left.
    await until(async () => (await bucket()) === limit - 100_000);
    expect(await bucket()).toBe(limit - 100_000);
    const h2 = await post(t.key, body);
    await h2.text();
    expect(h2.headers.get('x-gateway-cache')).toBe('hit');
    // Each hit is a request (nothing refills while the clock is pinned)...
    expect(remaining(h1, 'requests')).toBe(remaining(miss, 'requests') - 1);
    expect(remaining(h2, 'requests')).toBe(remaining(h1, 'requests') - 1);
    // ...and both hits saw the same token bucket, so the first one's tokens had gone back before the second asked.
    // Each header is read after the hit's estimate was taken (a few tokens: a short prompt and max_tokens 20).
    const estimate = limit - remaining(miss, 'tokens');
    expect(estimate).toBeGreaterThan(0);
    expect(remaining(h1, 'tokens')).toBe(limit - 100_000 - estimate);
    expect(remaining(h2, 'tokens')).toBe(remaining(h1, 'tokens'));
  });

  it('budget-exhausted tenant is still served a hit', async () => {
    const t = await tenant();
    const body = req('mock-a', uniq());
    await post(t.key, body);
    expect((await post(t.key, body)).headers.get('x-gateway-cache')).toBe('hit');
    // Spent: a cap of 1 micro-USD, written through the key store so the cached tenant record is replaced too.
    await keyStoreFromConfig(base, handle.db, redis).setBudget(t.tenantId, 1);
    const fresh = await post(t.key, req('mock-a', uniq()));
    expect(fresh.status).toBe(402); // the control: a request that needs the provider is refused
    expect(fresh.headers.get('x-gateway-cache')).toBe('miss');
    const hit = await post(t.key, body);
    expect(hit.status).toBe(200);
    expect(hit.headers.get('x-gateway-cache')).toBe('hit');
    expect(hit.headers.get('x-budget-remaining-usd')).toBeNull(); // no hold was taken
  });

  it('error reply is not cached', async () => {
    const t = await tenant();
    const body = req('mock-500', uniq());
    const n0 = calls['mock-500'] ?? 0;
    for (let i = 1; i <= 2; i++) {
      const res = await post(t.key, body);
      expect(res.status).toBe(500);
      expect(res.headers.get('x-gateway-cache')).toBe('miss');
      await res.text();
      expect(calls['mock-500']).toBe(n0 + i);
    }
    // Nor are streamed errors, or an answer that was filtered.
    const streamed = await post(t.key, { ...body, stream: true });
    expect(streamed.status).toBe(500);
    await streamed.text();
    const filtered = req('mock-filter', uniq());
    for (const stream of [false, true]) {
      const res = await post(t.key, { ...filtered, stream });
      expect(res.status).toBe(200);
      await res.text();
    }
    await new Promise((r) => setTimeout(r, 100));
    expect(await entries(t.tenantId)).toHaveLength(0);
  });

  it('x-gateway-cache header on hit, miss, bypass, uncacheable, unavailable', async () => {
    const t = await tenant();
    const body = req('mock-a', uniq());
    const seen = async (b: object, headers: Record<string, string> = {}) => {
      const res = await post(t.key, b, headers);
      await res.text();
      return res.headers.get('x-gateway-cache');
    };
    expect(await seen(body)).toBe('miss');
    expect(await seen(body)).toBe('hit');
    expect(await seen(body, { 'cache-control': 'no-store' })).toBe('bypass');
    const { temperature: _t, ...noTemp } = body;
    expect(await seen(noTemp)).toBe('uncacheable');
    expect(await seen({ ...body, n: 2 })).toBe('uncacheable');
    expect(await seen({ ...body, tools: [{ type: 'function', function: { name: 'f', parameters: {} } }] })).toBe('uncacheable');
    expect(await seen({ ...body, model: 'no-such-model' })).toBe('uncacheable'); // the route's 400
    expect(await seen({ model: 'mock-a' })).toBe('uncacheable'); // a body the route refuses
    cacheDown = true;
    try {
      expect(await seen(body)).toBe('unavailable'); // served by the provider regardless
    } finally {
      cacheDown = false;
    }
    // Uncacheable requests are neither read nor written.
    expect(await entries(t.tenantId)).toHaveLength(1);
  });

  it('an answer from a fallback model is served but not cached', async () => {
    const t = await tenant();
    const body = req('mock-fb-a', uniq());
    const nb = calls['mock-b'] ?? 0;
    for (let i = 1; i <= 2; i++) {
      const res = await post(t.key, body);
      expect(res.status).toBe(200);
      expect(res.headers.get('x-gateway-cache')).toBe('miss');
      expect(res.headers.get('x-gateway-model')).toBe('mock-b'); // mock-fb-a failed over to mock-b
      expect(res.headers.get('x-gateway-attempts')).toBe('2');
      await res.text();
      expect(calls['mock-b']).toBe(nb + i); // the second request had to go upstream again
    }
    const streamed = await post(t.key, { ...body, stream: true });
    expect(streamed.headers.get('x-gateway-model')).toBe('mock-b');
    await streamed.text();
    await new Promise((r) => setTimeout(r, 100));
    expect(await entries(t.tenantId)).toHaveLength(0);
    // A streamed request served by a fallback model stores nothing and lets go of its fill, once, as the non-streamed path does.
    const sbody = req('mock-fb-a', uniq(), { stream: true });
    await (await post(t.key, sbody)).text();
    await new Promise((r) => setTimeout(r, 100));
    expect(abandons[sbody.messages[0]!.content]).toBe(1);
    // The serving model asked for by name is an ordinary request and is cached under its own name.
    const direct = { ...body, model: 'mock-b' };
    await (await post(t.key, direct)).text();
    const again = await post(t.key, direct);
    expect(again.headers.get('x-gateway-cache')).toBe('hit');
    expect(again.headers.get('x-gateway-model')).toBe('mock-b');
    await again.text();
  });

  it('a request with no output limit and one capped at the gateway default are different requests', async () => {
    const t = await tenant();
    const prompt = uniq();
    const uncapped = { model: 'mock-a', temperature: 0, messages: [{ role: 'user', content: prompt }] };
    const capped = { ...uncapped, max_tokens: base.rateLimitDefaultMaxTokens };
    const n0 = calls['mock-a'] ?? 0;
    for (const body of [uncapped, capped]) {
      const res = await post(t.key, body);
      expect(res.headers.get('x-gateway-cache')).toBe('miss');
      await res.text();
    }
    expect(calls['mock-a']).toBe(n0 + 2);
    for (const body of [uncapped, capped]) {
      const res = await post(t.key, body);
      expect(res.headers.get('x-gateway-cache')).toBe('hit');
      await res.text();
    }
    expect(await entries(t.tenantId)).toHaveLength(2);
  });

  it('a hit on a model with no price still records its tokens, with nothing saved', async () => {
    const t = await tenant();
    await app.recordCacheHit!({
      tenantId: t.tenantId,
      model: 'model-without-a-price',
      usage: { promptTokens: 7, completionTokens: 5, totalTokens: 12 },
      kind: 'exact',
    });
    const [row] = await handle.db.select().from(spendLedger).where(eq(spendLedger.tenantId, t.tenantId));
    expect(row).toMatchObject({ cached: true, model: 'model-without-a-price', promptTokens: 7, completionTokens: 5, costMicros: 0, savedMicros: 0, cacheKind: 'exact' });
  });

  it('identical concurrent misses make one upstream call', async () => {
    const t = await tenant();
    const body = req('mock-slow', uniq());
    const n0 = calls['mock-slow'] ?? 0;
    const results = await Promise.all(Array.from({ length: 20 }, () => post(t.key, body)));
    expect(calls['mock-slow']).toBe(n0 + 1);
    const kinds = results.map((r) => r.headers.get('x-gateway-cache'));
    expect(kinds.filter((k) => k === 'miss')).toHaveLength(1);
    expect(kinds.filter((k) => k === 'hit')).toHaveLength(19);
    const contents = await Promise.all(results.map(async (r) => (await json(r)).choices[0].message.content));
    expect(new Set(contents).size).toBe(1);
    // Streamed requests never wait for each other: each goes upstream.
    const sbody = { ...req('mock-slow', uniq()), stream: true };
    const m0 = calls['mock-slow']!;
    const streams = await Promise.all(Array.from({ length: 3 }, () => post(t.key, sbody)));
    await Promise.all(streams.map((r) => r.text()));
    expect(calls['mock-slow']).toBe(m0 + 3);
  });

  it('a failed leader does not fail the requests waiting on it', async () => {
    const t = await tenant();
    const body = req('mock-lead500', uniq());
    const results = await Promise.all(Array.from({ length: 6 }, () => post(t.key, body)));
    const statuses = results.map((r) => r.status).sort();
    expect(statuses.filter((s) => s === 500)).toHaveLength(1); // only the leader had the failure
    expect(statuses.filter((s) => s === 200)).toHaveLength(5);
    await Promise.all(results.map((r) => r.text()));
    expect(calls['mock-lead500']).toBe(6); // each waiter went upstream itself
  });

  it('a request with Redis unavailable to the cache still completes', async () => {
    const t = await tenant();
    cacheDown = true;
    try {
      const res = await post(t.key, req('mock-a', uniq()));
      expect(res.status).toBe(200);
      expect(res.headers.get('x-gateway-cache')).toBe('unavailable');
    } finally {
      cacheDown = false;
    }
  });
});
