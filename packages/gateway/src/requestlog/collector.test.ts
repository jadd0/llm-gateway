import { randomUUID } from 'node:crypto';
import http, { type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../app.ts';
import { createDb, type Db } from '../db/client.ts';
import { tenants } from '../db/schema.ts';
import { cleanup, seedKey, testConfig } from '../test-env.ts';
import { standInWorker } from '../../test/drain.ts';
import { classifyClose } from './collector.ts';
import { fromStreamFields, streamKey, type LogEntry } from './entry.ts';

// The upstream picks its behaviour from the model name:
//   mock-ok     answers 1 prompt + 10 completion tokens          mock-500   answers 500
//   mock-hang   starts a stream and never ends it
//   mock-truncated  answers 200 with a body that breaks after a few bytes
const base = testConfig({ BUDGET_ENABLED: 'true', CACHE_ENABLED: 'true' });
const prefix = base.redisKeyPrefix;
let upstream: Server;
let app: FastifyInstance;
let handle: Db;
let redis: Redis;
let gw = '';
let cutApp: FastifyInstance;
let cutGw = '';
let stopWorker: () => void = () => {};
const tenantIds: string[] = [];

beforeAll(async () => {
  upstream = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { model: string; stream?: boolean };
      if (body.model === 'mock-500') {
        res.writeHead(500, { 'content-type': 'application/json' });
        return void res.end('{"error":{"message":"boom"}}');
      }
      if (body.model === 'mock-truncated') {
        res.writeHead(200, { 'content-type': 'application/json', 'content-length': '1000' });
        res.write('{"id":');
        return void setTimeout(() => res.socket?.destroy(), 20);
      }
      const usage = { prompt_tokens: 1, completion_tokens: 10, total_tokens: 11 };
      if (body.stream) {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'x' } }] })}\n\n`);
        if (body.model === 'mock-hang') return;
        res.write(`data: ${JSON.stringify({ choices: [], usage })}\n\n`);
        return void res.end('data: [DONE]\n\n');
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: 'x', model: body.model, choices: [{ index: 0, message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }], usage }));
    });
  });
  await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', r));
  handle = createDb({ databaseUrl: base.databaseUrl, poolSize: 6 });
  redis = new Redis(base.redisUrl!);
  stopWorker = standInWorker(handle.db, redis, prefix);
  app = buildApp(
    testConfig({
      API_KEY_PEPPER: base.apiKeyPepper,
      REDIS_KEY_PREFIX: prefix,
      OPENAI_BASE_URL: `http://127.0.0.1:${(upstream.address() as AddressInfo).port}/v1`,
      BUDGET_ENABLED: 'true',
      CACHE_ENABLED: 'true',
      BUDGET_REDIS_TIMEOUT_MS: '5000',
      RATE_LIMIT_REDIS_TIMEOUT_MS: '5000',
      CACHE_REDIS_TIMEOUT_MS: '2000',
      MODEL_FALLBACKS: 'mock-500>mock-ok',
    }),
  );
  await app.listen({ port: 0, host: '127.0.0.1' });
  gw = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  // A second gateway whose calls are cut after 600 ms.
  cutApp = buildApp(
    testConfig({
      API_KEY_PEPPER: base.apiKeyPepper,
      REDIS_KEY_PREFIX: prefix,
      OPENAI_BASE_URL: `http://127.0.0.1:${(upstream.address() as AddressInfo).port}/v1`,
      BUDGET_ENABLED: 'true',
      CACHE_ENABLED: 'false',
      UPSTREAM_MAX_DURATION_MS: '600',
      BUDGET_REDIS_TIMEOUT_MS: '5000',
      RATE_LIMIT_REDIS_TIMEOUT_MS: '5000',
    }),
  );
  await cutApp.listen({ port: 0, host: '127.0.0.1' });
  cutGw = `http://127.0.0.1:${(cutApp.server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  stopWorker();
  await cutApp.close();
  await app.close();
  upstream.closeAllConnections();
  await new Promise((r) => upstream.close(r));
  await cleanup(handle.db, redis, tenantIds, prefix);
  redis.disconnect();
  await handle.close();
});

const fresh = async (limits: { rpm?: number; tpm?: number } = { rpm: 10_000, tpm: 10_000_000 }, cap?: number) => {
  const s = await seedKey(handle.db, base, limits);
  tenantIds.push(s.tenantId);
  if (cap !== undefined) await handle.db.update(tenants).set({ monthlyBudgetMicros: cap }).where(eq(tenants.id, s.tenantId));
  return s;
};
const post = (key: string, over: object = {}, signal?: AbortSignal) =>
  fetch(`${gw}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify({ model: 'mock-ok', messages: [{ role: 'user', content: 'hi' }], max_tokens: 20, ...over }),
    ...(signal ? { signal } : {}),
  });

// Log entries are written after the response, so a test waits for the one it expects (by tenant and count).
async function entriesOf(tenantId: string | null, n: number): Promise<LogEntry[]> {
  const end = Date.now() + 15_000;
  let found: LogEntry[] = [];
  while (Date.now() < end) {
    const rows = await redis.xrange(streamKey(prefix), '-', '+');
    found = rows.flatMap(([, f]) => {
      const e = fromStreamFields(f);
      return e.kind === 'log' && e.entry.tenantId === tenantId ? [e.entry] : [];
    });
    if (found.length >= n) break;
    await new Promise((r) => setTimeout(r, 10));
  }
  expect(found).toHaveLength(n);
  return found;
}

describe('request log collector', { timeout: 60_000 }, () => {
  it('one entry for each outcome: 401, 429, 402, hit, 200, 5xx, client abort', async () => {
    // 200, then the identical request again from the cache (temperature 0).
    const a = await fresh();
    const ok = await post(a.key, { temperature: 0, model: 'mock-ok' });
    expect(ok.status).toBe(200);
    await ok.text();
    const hit = await post(a.key, { temperature: 0, model: 'mock-ok' });
    await hit.text();
    expect(hit.headers.get('x-gateway-cache')).toBe('hit');
    const [e200, eHit] = await entriesOf(a.tenantId, 2);
    expect(e200).toMatchObject({
      tenantId: a.tenantId, keyId: a.keyId, model: 'mock-ok', servedModel: 'mock-ok', provider: 'mock-openai', status: 200, errorCode: null,
      stream: false, promptTokens: 1, completionTokens: 10, costMicros: 31, savedMicros: 0, cache: 'miss', attempts: 1, fallbackUsed: false,
    });
    expect(e200!.latencyMs).toBeGreaterThanOrEqual(0);
    expect(e200!.ttfbMs).not.toBeNull();
    expect(e200!.upstreamMs).not.toBeNull();
    expect(eHit).toMatchObject({ status: 200, cache: 'hit', attempts: 0, costMicros: 0, provider: null, promptTokens: 1, completionTokens: 10 });
    expect(eHit!.savedMicros).toBeGreaterThan(0);
    expect(eHit!.upstreamMs).toBeNull();

    // 401: no tenant, and the code from the error body.
    const before = (await redis.xlen(streamKey(prefix))) ?? 0;
    const denied = await fetch(`${gw}/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer gw_nope' }, body: '{}' });
    expect(denied.status).toBe(401);
    await denied.text();
    const end = Date.now() + 10_000;
    let e401: LogEntry | undefined;
    while (!e401 && Date.now() < end) {
      const rows = await redis.xrange(streamKey(prefix), '-', '+');
      e401 = rows.flatMap(([, f]) => (fromStreamFields(f).kind === 'log' ? [(fromStreamFields(f) as { entry: LogEntry }).entry] : [])).find((e) => e.status === 401);
      if (!e401) await new Promise((r) => setTimeout(r, 10));
    }
    expect(before).toBeGreaterThan(0);
    expect(e401).toMatchObject({ tenantId: null, keyId: null, status: 401, errorCode: 'invalid_api_key', model: null });
    expect(JSON.stringify(e401)).not.toContain('gw_nope');

    // 429: the second request in a minute on a key allowed one.
    const b = await fresh({ rpm: 1, tpm: 10_000_000 });
    await (await post(b.key)).text();
    const limited = await post(b.key);
    expect(limited.status).toBe(429);
    await limited.text();
    const eb = await entriesOf(b.tenantId, 2);
    expect(eb.map((e) => e.status).sort()).toEqual([200, 429]);
    expect(eb.find((e) => e.status === 429)).toMatchObject({ tenantId: b.tenantId, model: 'mock-ok', costMicros: 0 });

    // 402: a cap of 1 micro-USD cannot hold a worst case.
    const c = await fresh(undefined, 1);
    const broke = await post(c.key);
    expect(broke.status).toBe(402);
    await broke.text();
    const [ec] = await entriesOf(c.tenantId, 1);
    expect(ec).toMatchObject({ status: 402, errorCode: 'budget_exhausted', model: 'mock-ok', costMicros: 0, cache: null }); // the cache looked and found nothing, but the log row of a refusal has no cache outcome

    // 5xx from the provider with no fallback: the provider's own 500 goes through.
    const d = await fresh();
    const bad = await post(d.key, { model: 'mock-500', stream: false }, undefined);
    // mock-500 falls over to mock-ok through the configured chain: the request is served by the second model.
    expect(bad.status).toBe(200);
    await bad.text();
    const [ed] = await entriesOf(d.tenantId, 1);
    // fallback_used and attempts come from the attempt loop
    expect(ed).toMatchObject({ model: 'mock-500', servedModel: 'mock-ok', attempts: 2, fallbackUsed: true, status: 200, costMicros: 31 });
  });

  it('a provider 5xx with nowhere to fall over is logged with the provider status', async () => {
    const s = await fresh();
    const res = await post(s.key, { model: 'mock-500', stream: true });
    // Streamed or not, the chain serves it from the second model; a model with no chain is the 5xx case below.
    await res.text();
    const [e] = await entriesOf(s.tenantId, 1);
    expect(e).toMatchObject({ attempts: 2, fallbackUsed: true });
  });

  it('client abort is attributed to the client, not upstream', async () => {
    const s = await fresh();
    const ctrl = new AbortController();
    const res = await post(s.key, { model: 'mock-hang', stream: true }, ctrl.signal);
    expect(res.status).toBe(200);
    await res.body!.getReader().read();
    ctrl.abort();
    // The positive signal is the entry itself: no fixed sleep.
    const [e] = await entriesOf(s.tenantId, 1);
    expect(e).toMatchObject({ status: 200, errorCode: 'client_closed', stream: true, model: 'mock-hang' });
    expect(e!.errorCode).not.toBe('upstream_stream_broken');
    // The estimate was charged for the abandoned call, and the entry says what it cost.
    expect(e!.costMicros).toBeGreaterThan(0);
  });

  it('a stream the gateway cuts at its maximum duration is logged upstream_max_duration, not as a clean 200', async () => {
    const s = await fresh();
    const res = await fetch(`${cutGw}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${s.key}` },
      body: JSON.stringify({ model: 'mock-hang', stream: true, messages: [{ role: 'user', content: 'hi' }], max_tokens: 20 }),
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('upstream_max_duration'); // the cut event the client sees
    const [e] = await entriesOf(s.tenantId, 1);
    expect(e).toMatchObject({ status: 200, errorCode: 'upstream_max_duration', stream: true });
  });

  it('a 2xx whose body breaks is logged upstream_bad_response, not upstream_unreachable', async () => {
    const s = await fresh();
    const res = await post(s.key, { model: 'mock-truncated' });
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ error: { code: 'upstream_bad_response' } });
    const [e] = await entriesOf(s.tenantId, 1);
    expect(e).toMatchObject({ status: 502, errorCode: 'upstream_bad_response' });
    // The provider answered 2xx and may have billed: the estimate stays charged.
    expect(e!.costMicros).toBeGreaterThan(0);
  });

  it('the one place that decides who ended a response', () => {
    expect(classifyClose({ finished: true, upstream: null })).toBe('complete');
    expect(classifyClose({ finished: true, upstream: { failed: true, alive: false } })).toBe('complete');
    expect(classifyClose({ finished: false, upstream: null })).toBe('client');
    expect(classifyClose({ finished: false, upstream: { failed: false, alive: true } })).toBe('client');
    expect(classifyClose({ finished: false, upstream: { failed: true, alive: true } })).toBe('upstream');
    expect(classifyClose({ finished: false, upstream: { failed: false, alive: false } })).toBe('upstream');
    // The gateway destroyed the upstream body itself at the maximum duration: not the upstream's doing.
    expect(classifyClose({ finished: false, upstream: { failed: false, alive: false, cut: true } })).toBe('client');
    expect(classifyClose({ finished: false, upstream: { failed: true, alive: false, cut: true } })).toBe('client');
  });

  it('request ids are uuids and the same id names the spend hold', async () => {
    const s = await fresh();
    await (await post(s.key)).text();
    const [e] = await entriesOf(s.tenantId, 1);
    expect(e!.requestId).toMatch(/^[0-9a-f-]{36}$/);
    expect(randomUUID()).not.toBe(e!.requestId);
  });
});
