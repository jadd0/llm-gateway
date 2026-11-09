import { randomBytes } from 'node:crypto';
import http, { type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../app.ts';
import { KEY_VERSION } from '../cache/key.ts';
import { createDb, type Db } from '../db/client.ts';
import { semanticCache, spendLedger, tenants } from '../db/schema.ts';
import { angle, stubEmbedder } from '../semantic/test-support.ts';
import { cleanup, seedKey, testConfig } from '../test-env.ts';

// The upstream answers "answer-<n>" (1 prompt + 10 completion tokens: 31 micro-USD at the mock price) and counts
// its calls, so an answer served from the cache is told apart from a fresh one. The embedder is a stub that
// knows exactly how similar the prompts are: `pair(x)` makes two prompts at similarity 0.98, `other(x)` one
// that is unrelated to them.
const base = testConfig({ CACHE_ENABLED: 'true', SEMANTIC_ENABLED: 'true', BUDGET_ENABLED: 'true' });
const prefix = base.redisKeyPrefix;
const T0 = 1_700_000_000_000;

let upstream: Server;
let app: FastifyInstance;
let handle: Db;
let redis: Redis;
let gw = '';
let calls = 0;
const table: Record<string, number[]> = {};
const stub = stubEmbedder(table);
const tenantIds: string[] = [];

beforeAll(async () => {
  upstream = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { model: string; stream?: boolean };
      calls += 1;
      // An answer too big for the cache to keep: its leader fills nothing.
      const text = JSON.stringify(body).includes('bigout') ? 'x'.repeat(300_000) : `answer-${calls}`;
      const usage = { prompt_tokens: 1, completion_tokens: 10, total_tokens: 11 };
      if (body.stream) {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        const send = (o: unknown) => res.write(`data: ${JSON.stringify(o)}\n\n`);
        send({ id: 'c', model: body.model, choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] });
        send({ id: 'c', model: body.model, choices: [{ index: 0, delta: { content: text }, finish_reason: null }] });
        send({ id: 'c', model: body.model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
        send({ id: 'c', model: body.model, choices: [], usage });
        res.end('data: [DONE]\n\n');
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: 'c', object: 'chat.completion', model: body.model, choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }], usage }));
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
      SEMANTIC_ENABLED: 'true',
      SEMANTIC_THRESHOLD: '0.95',
      BUDGET_ENABLED: 'true',
      BUDGET_REDIS_TIMEOUT_MS: '5000',
      BUDGET_EPOCH_REFRESH_MS: '3600000',
      RATE_LIMIT_REDIS_TIMEOUT_MS: '5000',
      CACHE_REDIS_TIMEOUT_MS: '2000',
      CACHE_REPLAY_CHUNK_CHARS: '4',
    }),
    { rateLimitClock: () => T0, cacheClock: () => T0, semanticEmbedder: stub.embedder },
  );
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

const uniq = () => randomBytes(6).toString('hex');
/** Two prompts whose embeddings are 0.98 similar. */
let turn = 0;
const pair = (): [string, string] => {
  const id = uniq();
  const a = `capital of ${id}?`;
  const b = `what is the capital city of ${id}`;
  // Each pair sits at its own place on the circle, so two pairs in one test are not near each other.
  const at = (turn += 1) * 37;
  table[a] = angle(at);
  table[b] = angle(at + (Math.acos(0.98) * 180) / Math.PI);
  return [a, b];
};
/** A prompt that is not similar to anything. */
const other = (): string => {
  const o = `unrelated ${uniq()}`;
  table[o] = angle(turn * 37 + 180);
  return o;
};
async function tenant(opts: { shared?: boolean; semantic?: boolean } = {}) {
  const s = await seedKey(handle.db, base);
  tenantIds.push(s.tenantId);
  await handle.db.update(tenants).set({ cacheShared: opts.shared ?? false, semanticCache: opts.semantic ?? true }).where(eq(tenants.id, s.tenantId));
  return s;
}
const req = (content: string, extra: object = {}) => ({ model: 'mock-a', temperature: 0, max_tokens: 20, messages: [{ role: 'user', content }], ...extra });
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
const rowsOf = (scope: string) => handle.db.select().from(semanticCache).where(eq(semanticCache.scope, scope));
/** Sends the prompt, waits for its fill to land, and returns the number of upstream calls it took (1). */
async function seed(t: { key: string; tenantId: string }, body: object, headers: Record<string, string> = {}) {
  const had = (await rowsOf(t.tenantId)).length;
  const before = calls;
  const res = await post(t.key, body, headers);
  expect(res.status).toBe(200);
  expect(res.headers.get('x-gateway-cache')).toBe('miss');
  expect(calls).toBe(before + 1);
  expect(await until(async () => (await rowsOf(t.tenantId)).length === had + 1)).toBe(true);
  return json(res);
}

describe('semantic cache on POST /v1/chat/completions', () => {
  it('paraphrase is a semantic hit with no upstream call', async () => {
    const t = await tenant();
    const [a, b] = pair();
    const first = await seed(t, req(a));
    const before = calls;
    const res = await post(t.key, req(b));
    expect(res.status).toBe(200);
    expect(res.headers.get('x-gateway-cache')).toBe('semantic-hit');
    expect(calls).toBe(before);
    const hit = await json(res);
    expect(hit.choices[0].message.content).toBe(first.choices[0].message.content);
    expect(hit.id).toMatch(/^chatcmpl-cache-/);
    // The paraphrase itself was not stored: asking it again is again a semantic hit, never an exact one.
    expect((await post(t.key, req(b))).headers.get('x-gateway-cache')).toBe('semantic-hit');
    expect(await rowsOf(t.tenantId)).toHaveLength(1);
    // The exact request is still an exact hit.
    expect((await post(t.key, req(a))).headers.get('x-gateway-cache')).toBe('hit');
  });

  it('a prompt that is not close enough goes upstream', async () => {
    const t = await tenant();
    const [a] = pair();
    await seed(t, req(a));
    const before = calls;
    const res = await post(t.key, req(other()));
    expect(res.headers.get('x-gateway-cache')).toBe('miss');
    expect(res.headers.get('x-gateway-similarity')).toBeNull();
    expect(calls).toBe(before + 1);
  });

  it('headers on semantic hit', async () => {
    const t = await tenant();
    const [a, b] = pair();
    await seed(t, req(a));
    const res = await post(t.key, req(b));
    expect(res.headers.get('x-gateway-cache')).toBe('semantic-hit');
    expect(res.headers.get('x-gateway-similarity')).toBe('0.980');
    expect(res.headers.get('x-gateway-attempts')).toBe('0');
    expect(res.headers.get('x-gateway-model')).toBe('mock-a');
    // An exact hit carries no similarity.
    const exact = await post(t.key, req(a));
    expect(exact.headers.get('x-gateway-cache')).toBe('hit');
    expect(exact.headers.get('x-gateway-similarity')).toBeNull();
  });

  it('a streamed paraphrase is replayed as a stream', async () => {
    const t = await tenant();
    const [a, b] = pair();
    const first = await seed(t, req(a));
    const res = await post(t.key, req(b, { stream: true, stream_options: { include_usage: true } }));
    expect(res.headers.get('x-gateway-cache')).toBe('semantic-hit');
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const text = await res.text();
    expect(text.endsWith('data: [DONE]\n\n')).toBe(true);
    const events = text.split('\n\n').filter((e) => e && e !== 'data: [DONE]').map((e) => JSON.parse(e.slice(6)));
    expect(events.map((e: any) => e.choices[0]?.delta?.content ?? '').join('')).toBe(first.choices[0].message.content);
    expect(events.at(-1).usage).toEqual({ prompt_tokens: 1, completion_tokens: 10, total_tokens: 11 });
  });

  it('different system prompt never matches', async () => {
    const t = await tenant();
    const [a, b] = pair();
    const withSystem = (system: string, content: string) => req(content, { messages: [{ role: 'system', content: system }, { role: 'user', content }] });
    await seed(t, withSystem('You are terse.', a));
    // Positive control: the same system prompt does match.
    expect((await post(t.key, withSystem('You are terse.', b))).headers.get('x-gateway-cache')).toBe('semantic-hit');
    const before = calls;
    const res = await post(t.key, withSystem('You are verbose.', b));
    expect(res.headers.get('x-gateway-cache')).toBe('miss');
    expect(calls).toBe(before + 1);
  });

  it('a different earlier turn, model, max_tokens or temperature never matches either', async () => {
    const t = await tenant();
    const [a, b] = pair();
    const turns = (earlier: string, content: string) =>
      req(content, { messages: [{ role: 'user', content: earlier }, { role: 'assistant', content: 'ok' }, { role: 'user', content }] });
    await seed(t, turns('hello', a));
    expect((await post(t.key, turns('hello', b))).headers.get('x-gateway-cache')).toBe('semantic-hit');
    const variants: Array<[string, object]> = [
      ['earlier turn', turns('goodbye', b)],
      ['model', { ...turns('hello', b), model: 'mock-b' }],
      ['max_tokens', { ...turns('hello', b), max_tokens: 21 }],
      ['top_p', { ...turns('hello', b), top_p: 0.5 }],
    ];
    for (const [name, body] of variants) {
      const before = calls;
      const res = await post(t.key, body);
      expect(res.headers.get('x-gateway-cache'), name).toBe('miss');
      expect(calls, name).toBe(before + 1);
    }
  });

  it('other tenant never matches', async () => {
    const t1 = await tenant();
    const t2 = await tenant();
    const [a, b] = pair();
    await seed(t1, req(a));
    expect((await post(t1.key, req(b))).headers.get('x-gateway-cache')).toBe('semantic-hit');
    const before = calls;
    const res = await post(t2.key, req(b));
    expect(res.headers.get('x-gateway-cache')).toBe('miss');
    expect(calls).toBe(before + 1);
  });

  it('tenants in the shared pool match each other', async () => {
    const t1 = await tenant({ shared: true });
    const t2 = await tenant({ shared: true });
    const [a, b] = pair();
    await handle.db.delete(semanticCache).where(eq(semanticCache.scope, 'shared')); // other runs' rows
    const before = calls;
    const res1 = await post(t1.key, req(a));
    expect(res1.headers.get('x-gateway-cache')).toBe('miss');
    expect(await until(async () => (await rowsOf('shared')).length > 0)).toBe(true);
    const res2 = await post(t2.key, req(b));
    expect(res2.headers.get('x-gateway-cache')).toBe('semantic-hit');
    expect(calls).toBe(before + 1);
    await handle.db.delete(semanticCache).where(eq(semanticCache.scope, 'shared'));
    for (const k of await redis.keys(`${prefix}cache:${KEY_VERSION}:shared:*`)) await redis.del(k);
  });

  it('x-gateway-semantic: off and no-store skip it', async () => {
    const t = await tenant();
    const [a, b] = pair();
    await seed(t, req(a));
    const before = calls;
    const off = await post(t.key, req(b), { 'x-gateway-semantic': 'off' });
    expect(off.headers.get('x-gateway-cache')).toBe('miss');
    expect(calls).toBe(before + 1);
    // Skipped means skipped: the prompt was never embedded, and no row was made for it.
    expect(stub.calls.filter((c) => c.text === b)).toHaveLength(0);
    // no-store neither reads nor writes.
    const [c, d] = pair();
    const stored = await post(t.key, req(c), { 'cache-control': 'no-store' });
    expect(stored.headers.get('x-gateway-cache')).toBe('bypass');
    expect(stub.calls.filter((x) => x.text === c)).toHaveLength(0);
    await seed(t, req(d));
    const bypass = await post(t.key, req(c), { 'cache-control': 'no-store' });
    expect(bypass.headers.get('x-gateway-cache')).toBe('bypass');
    expect(stub.calls.filter((x) => x.text === c)).toHaveLength(0);
    // Positive control: without the header the paraphrase of `d` is served.
    expect((await post(t.key, req(c))).headers.get('x-gateway-cache')).toBe('semantic-hit');
  });

  it('no-cache skips the semantic read but refreshes the entry and its row', async () => {
    const t = await tenant();
    const [a, b] = pair();
    await seed(t, req(a));
    const before = calls;
    const refreshed = await post(t.key, req(b), { 'cache-control': 'no-cache' });
    expect(refreshed.headers.get('x-gateway-cache')).toBe('refresh');
    expect(calls).toBe(before + 1);
    expect(await until(async () => (await rowsOf(t.tenantId)).length === 2)).toBe(true);
    expect(new Set((await rowsOf(t.tenantId)).map((r) => r.exactKey)).size).toBe(2);
  });

  it('tenant switched off skips it', async () => {
    const t = await tenant({ semantic: false });
    const [a, b] = pair();
    const res = await post(t.key, req(a));
    expect(res.headers.get('x-gateway-cache')).toBe('miss');
    // Exact caching still works for the tenant; the semantic step does not run at all.
    expect((await post(t.key, req(a))).headers.get('x-gateway-cache')).toBe('hit');
    const before = calls;
    expect((await post(t.key, req(b))).headers.get('x-gateway-cache')).toBe('miss');
    expect(calls).toBe(before + 1);
    expect(stub.calls.filter((c) => c.text === a || c.text === b)).toHaveLength(0);
    expect(await rowsOf(t.tenantId)).toHaveLength(0);
  });

  it('semantic hit ledger row is cache_kind semantic, cost 0, saving recorded', async () => {
    const t = await tenant();
    const [a, b] = pair();
    await seed(t, req(a));
    expect((await post(t.key, req(b))).headers.get('x-gateway-cache')).toBe('semantic-hit');
    expect((await post(t.key, req(a))).headers.get('x-gateway-cache')).toBe('hit');
    const cachedRows = () => handle.db.select().from(spendLedger).where(eq(spendLedger.tenantId, t.tenantId));
    expect(await until(async () => (await cachedRows()).filter((r) => r.cached).length === 2)).toBe(true);
    const hits = (await cachedRows()).filter((r) => r.cached);
    expect(hits.map((r) => r.cacheKind).sort()).toEqual(['exact', 'semantic']);
    const sem = hits.find((r) => r.cacheKind === 'semantic')!;
    expect(sem).toMatchObject({ costMicros: 0, savedMicros: 31, promptTokens: 1, completionTokens: 10, model: 'mock-a' });
    // The ordinary row of the first request has no kind.
    expect((await cachedRows()).find((r) => !r.cached)!.cacheKind).toBeNull();
  });

  it('fill runs after the response is sent', async () => {
    const t = await tenant();
    const [a, b] = pair();
    stub.hold(true); // the fill's embedding (patient) waits; the lookup's does not
    try {
      const t0 = performance.now();
      const res = await post(t.key, req(a));
      await res.arrayBuffer();
      expect(res.status).toBe(200);
      expect(performance.now() - t0).toBeLessThan(1500);
      // The response is complete and the embedding has not been answered: no row yet, and the entry is exact-cached.
      expect(await rowsOf(t.tenantId)).toHaveLength(0);
      expect((await post(t.key, req(a))).headers.get('x-gateway-cache')).toBe('hit');
      expect((await post(t.key, req(b))).headers.get('x-gateway-cache')).toBe('miss');
    } finally {
      stub.release();
    }
    expect(await until(async () => (await rowsOf(t.tenantId)).length >= 1)).toBe(true);
  });

  it('a Redis entry that is gone is a miss, and its row is removed', async () => {
    const t = await tenant();
    const [a, b] = pair();
    await seed(t, req(a));
    const [row] = await rowsOf(t.tenantId);
    await redis.del(row!.exactKey);
    const before = calls;
    const res = await post(t.key, req(b));
    expect(res.headers.get('x-gateway-cache')).toBe('miss');
    expect(calls).toBe(before + 1);
    // The miss stored the new answer, and filled it; the dangling row for the first is gone.
    expect(await until(async () => (await rowsOf(t.tenantId)).every((r) => r.exactKey !== row!.exactKey))).toBe(true);
  });

  it('an embedder that is down is a plain miss', async () => {
    const t = await tenant();
    const [a, b] = pair();
    await seed(t, req(a));
    delete table[b]; // the stub fails for a text it does not know
    const before = calls;
    const res = await post(t.key, req(b));
    expect(res.status).toBe(200);
    expect(res.headers.get('x-gateway-cache')).toBe('miss');
    expect(calls).toBe(before + 1);
  });

  it('a request that is not cacheable is never embedded', async () => {
    const t = await tenant();
    const [a] = pair();
    const before = stub.calls.length;
    const res = await post(t.key, req(a, { temperature: 0.7 }));
    expect(res.headers.get('x-gateway-cache')).toBe('uncacheable');
    expect(stub.calls.length).toBe(before);
    // A last message that is not plain user text has nothing to compare either.
    const img = await post(t.key, req(a, { messages: [{ role: 'user', content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] }] }));
    expect(img.headers.get('x-gateway-cache')).toBe('miss');
    expect(stub.calls.length).toBe(before);
  });

  it('a tenant that never opted in is not embedded, stored or matched', async () => {
    // seedKey makes the tenant exactly as `keys create-tenant` does: nothing is switched on.
    const t = await seedKey(handle.db, base);
    tenantIds.push(t.tenantId);
    expect((await handle.db.select().from(tenants).where(eq(tenants.id, t.tenantId)))[0]!.semanticCache).toBe(false);
    const [a, b] = pair();
    expect((await post(t.key, req(a))).headers.get('x-gateway-cache')).toBe('miss');
    expect((await post(t.key, req(a))).headers.get('x-gateway-cache')).toBe('hit');
    const before = calls;
    expect((await post(t.key, req(b))).headers.get('x-gateway-cache')).toBe('miss');
    expect(calls).toBe(before + 1);
    expect(stub.calls.filter((c) => c.text === a || c.text === b)).toHaveLength(0);
    expect(await rowsOf(t.tenantId)).toHaveLength(0);
  });

  it('a close prompt with a different number is a miss that names the guard, and is not served', async () => {
    const t = await tenant();
    const id = uniq();
    const a = `refund order number 1234 for ${id}`;
    const b = `refund order number 1235 for ${id}`;
    table[a] = angle(1);
    table[b] = angle(1 + (Math.acos(0.982) * 180) / Math.PI);
    await seed(t, req(a));
    const before = calls;
    const res = await post(t.key, req(b));
    expect(res.headers.get('x-gateway-cache')).toBe('miss');
    expect(res.headers.get('x-gateway-semantic-guard')).toBe('numbers');
    expect(res.headers.get('x-gateway-similarity')).toBeNull();
    expect(calls).toBe(before + 1);
    // Its own answer is what the next ask gets, and nothing was refused there.
    const again = await post(t.key, req(b));
    expect(again.headers.get('x-gateway-cache')).toBe('hit');
    expect(again.headers.get('x-gateway-semantic-guard')).toBeNull();
  });

  it('a burst of identical paraphrases asks the semantic cache once; followers that are off go upstream', async () => {
    const on = await tenant({ shared: true });
    const off = await tenant({ shared: true, semantic: false });
    const [a, b] = pair();
    await handle.db.delete(semanticCache).where(eq(semanticCache.scope, 'shared'));
    expect((await post(on.key, req(a))).headers.get('x-gateway-cache')).toBe('miss');
    expect(await until(async () => (await rowsOf('shared')).length > 0)).toBe(true);
    const before = calls;
    stub.hold();
    const leader = post(on.key, req(b));
    await new Promise((r) => setTimeout(r, 150));
    // Same key, same process: followers. Two are on the semantic cache, one has opted out per request, one is a
    // tenant that is off. They must not be handed the leader's semantic answer.
    const followers = [post(on.key, req(b)), post(on.key, req(b)), post(on.key, req(b), { 'x-gateway-semantic': 'off' }), post(off.key, req(b))];
    await new Promise((r) => setTimeout(r, 150));
    stub.release();
    const results = await Promise.all([leader, ...followers]);
    expect(results.map((r) => r.headers.get('x-gateway-cache'))).toEqual(['semantic-hit', 'semantic-hit', 'semantic-hit', 'miss', 'miss']);
    // One embedding of b (the leader's), and only the two that went upstream called the provider.
    expect(stub.calls.filter((c) => c.text === b)).toHaveLength(1);
    expect(calls - before).toBe(2);
    await handle.db.delete(semanticCache).where(eq(semanticCache.scope, 'shared'));
    for (const k of await redis.keys(`${prefix}cache:${KEY_VERSION}:shared:*`)) await redis.del(k);
  });

  it('followers of a leader whose semantic lookup missed do not ask again', async () => {
    const t = await tenant();
    const q = `bigout ${uniq()}`;
    table[q] = angle(turn * 37 + 90);
    stub.hold();
    const before = calls;
    const leader = post(t.key, req(q));
    await new Promise((r) => setTimeout(r, 150));
    const followers = [post(t.key, req(q)), post(t.key, req(q)), post(t.key, req(q))];
    await new Promise((r) => setTimeout(r, 150));
    stub.release();
    const results = await Promise.all([leader, ...followers]);
    expect(results.map((r) => r.status)).toEqual([200, 200, 200, 200]);
    // Nothing could be stored, so every request went upstream; but only the leader looked for a similar prompt.
    expect(results.map((r) => r.headers.get('x-gateway-cache'))).toEqual(['miss', 'miss', 'miss', 'miss']);
    expect(calls - before).toBe(4);
    expect(stub.calls.filter((c) => c.text === q && !c.patient)).toHaveLength(1);
  });
});
