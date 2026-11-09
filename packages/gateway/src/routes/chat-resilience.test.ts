import http, { type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { FastifyInstance } from 'fastify';
import { sql } from 'drizzle-orm';
import { Redis } from 'ioredis';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createMockServer, type Settings } from '../../../mock-provider/src/server.ts';
import type { Breaker } from '../resilience/breaker.ts';
import { buildApp } from '../app.ts';
import { createDb, type Db } from '../db/client.ts';
import { tenants } from '../db/schema.ts';
import { costMicros, priceFor } from '../pricing/prices.ts';
import { estimateWorstCase } from '../usage/estimate.ts';
import { cleanup, seedKey, testConfig } from '../test-env.ts';
import { eq } from 'drizzle-orm';

// Two mock providers stand for two models: A serves the OpenAI format (mock-openai-1), B the Anthropic
// format (mock-anthropic-1), each on its own origin so one can be killed while the other keeps answering.
// The chain is A then B. Retries wait a few milliseconds so a test runs fast; the breaker only opens when
// a test sets BREAKER_MIN_FAILURES.
interface Mini {
  settings: Settings;
  server: Server;
  url: string;
  hits: number;
}
const newSettings = (): Settings => ({ latencyMs: 0, tokenDelayMs: 0, completionTokens: 5, errorRate: 0, outage: 'off' });
async function startMock(): Promise<Mini> {
  const settings = newSettings();
  const server = createMockServer(settings);
  const mini: Mini = { settings, server, url: '', hits: 0 };
  server.on('request', (req) => {
    if (req.method === 'POST' && !req.url?.startsWith('/__control')) mini.hits++;
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  mini.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return mini;
}
const stubServer = async (handler: http.RequestListener) => {
  const server = http.createServer(handler);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return { server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, hits: 0 };
};
const deadUrl = async () => {
  const s = await stubServer(() => {});
  await new Promise((r) => s.server.close(r));
  return s.url;
};

const base = testConfig({ BUDGET_ENABLED: 'true' });
const prefix = base.redisKeyPrefix;
let A: Mini;
let B: Mini;
let handle: Db;
let redis: Redis;
const tenantIds: string[] = [];
const apps: FastifyInstance[] = [];
const closers: Array<() => Promise<unknown>> = [];

beforeAll(async () => {
  A = await startMock();
  B = await startMock();
  handle = createDb({ databaseUrl: base.databaseUrl, poolSize: 4 });
  redis = new Redis(base.redisUrl!);
});
beforeEach(async () => {
  Object.assign(A.settings, newSettings());
  Object.assign(B.settings, newSettings());
  A.hits = 0;
  B.hits = 0;
  const stale = await redis.keys(`${prefix}breaker:*`);
  if (stale.length) await redis.del(...stale);
});
afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
  for (const close of closers.splice(0)) await close();
});
afterAll(async () => {
  for (const m of [A, B]) {
    m.server.closeAllConnections();
    await new Promise((r) => m.server.close(r));
  }
  await cleanup(handle.db, redis, tenantIds, prefix);
  redis.disconnect();
  await handle.close();
});

const MODELS = { a: 'mock-openai-1', b: 'mock-anthropic-1' };

// A gateway over the two mocks. `env` overrides settings, `extra` the app's test hooks.
async function gateway(env: Record<string, string> = {}, extra: Parameters<typeof buildApp>[1] = {}) {
  const config = testConfig({
    API_KEY_PEPPER: base.apiKeyPepper,
    REDIS_KEY_PREFIX: prefix,
    BUDGET_ENABLED: 'true',
    MOCK_BASE_URL: A.url,
    MOCK_ANTHROPIC_BASE_URL: B.url,
    MODEL_FALLBACKS: `${MODELS.a}>${MODELS.b}`,
    RETRY_MAX_ATTEMPTS_PER_MODEL: '3',
    RETRY_BASE_MS: '1',
    RETRY_CAP_MS: '5',
    ...env,
  });
  const app = buildApp(config, extra);
  apps.push(app);
  await app.listen({ port: 0, host: '127.0.0.1' });
  return `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
}

async function tenant(limits: { rpm?: number; tpm?: number } = { rpm: 100_000, tpm: 100_000_000 }, capMicros?: number) {
  const s = await seedKey(handle.db, base, limits);
  tenantIds.push(s.tenantId);
  if (capMicros !== undefined) await handle.db.update(tenants).set({ monthlyBudgetMicros: capMicros }).where(eq(tenants.id, s.tenantId));
  return s;
}

const send = (gw: string, key: string, over: object = {}) =>
  fetch(`${gw}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify({ model: MODELS.a, messages: [{ role: 'user', content: 'hi' }], max_tokens: 20, ...over }),
  });

// A mock that fails its first `n` requests with `status`, then answers normally.
function failFirst(m: Mini, n: number, status = 503) {
  m.settings.outage = 'error';
  m.settings.errorStatus = status;
  let done = 0;
  const onRequest = (_req: http.IncomingMessage, res: http.ServerResponse) => {
    res.on('finish', () => {
      if (++done >= n) m.settings.outage = 'off';
    });
  };
  m.server.on('request', onRequest);
  closers.push(async () => void m.server.off('request', onRequest));
}

const ledger = async (tenantId: string) =>
  (await handle.db.execute(sql`select model, cost_micros, estimated, prompt_tokens, completion_tokens from spend_ledger where tenant_id = ${tenantId}`)).rows.map(
    (r) => ({ model: r.model as string, cost: Number(r.cost_micros), estimated: r.estimated as boolean, prompt: Number(r.prompt_tokens), completion: Number(r.completion_tokens) }),
  );
async function until<T>(read: () => Promise<T>, done: (v: T) => boolean): Promise<T> {
  const end = Date.now() + 15_000;
  let v = await read();
  while (!done(v) && Date.now() < end) {
    await new Promise((r) => setTimeout(r, 10));
    v = await read();
  }
  expect(done(v)).toBe(true);
  return v;
}
const heldMicros = async (tenantId: string) =>
  Number((await handle.db.execute(sql`select coalesce(sum(amount_micros), 0) as s from budget_reservations where tenant_id = ${tenantId}`)).rows[0]!.s);

describe('retries, fallback and breaker through the chat route', { timeout: 60_000 }, () => {
  it('a 503 then 200 is retried on the same model and settles once', async () => {
    failFirst(A, 1);
    const gw = await gateway();
    const s = await tenant();
    const res = await send(gw, s.key);
    expect(res.status).toBe(200);
    expect(res.headers.get('x-gateway-model')).toBe(MODELS.a);
    expect(res.headers.get('x-gateway-attempts')).toBe('2');
    expect(A.hits).toBe(2);
    expect(B.hits).toBe(0);
    const body = (await res.json()) as { model: string; usage: { prompt_tokens: number; completion_tokens: number } };
    expect(body.model).toBe(MODELS.a);
    // One charge: one ledger row, at the usage the answer reported, and nothing left held.
    const rows = await until(() => ledger(s.tenantId), (r) => r.length === 1);
    expect(rows).toEqual([{ model: MODELS.a, cost: costMicros(priceFor(MODELS.a)!, body.usage.prompt_tokens, body.usage.completion_tokens), estimated: false, prompt: body.usage.prompt_tokens, completion: body.usage.completion_tokens }]);
    await until(() => heldMicros(s.tenantId), (h) => h === 0);
  });

  it('connect refused on A falls back to B; x-gateway-model names B', async () => {
    const gw = await gateway({ MOCK_BASE_URL: await deadUrl() });
    const s = await tenant();
    const res = await send(gw, s.key);
    expect(res.status).toBe(200);
    expect(res.headers.get('x-gateway-model')).toBe(MODELS.b);
    // Three tries on A (refused each time), one on B.
    expect(res.headers.get('x-gateway-attempts')).toBe('4');
    expect(B.hits).toBe(1);
    expect(((await res.json()) as { model: string }).model).toBe(MODELS.b);
    // The charge is B's: the ledger names the serving model.
    const rows = await until(() => ledger(s.tenantId), (r) => r.length === 1);
    expect(rows[0]!.model).toBe(MODELS.b);
  });

  it('headers timeout moves to the next model without a same-model retry', async () => {
    A.settings.outage = 'hang';
    const gw = await gateway({ UPSTREAM_HEADERS_TIMEOUT_MS: '200' });
    const s = await tenant();
    const res = await send(gw, s.key);
    expect(res.status).toBe(200);
    expect(res.headers.get('x-gateway-model')).toBe(MODELS.b);
    expect(res.headers.get('x-gateway-attempts')).toBe('2');
    expect(A.hits).toBe(1); // the provider may still be working on it: never asked twice
    expect(B.hits).toBe(1);
  });

  it('a 400 from A is returned unchanged with one attempt', async () => {
    A.settings.outage = 'error';
    A.settings.errorStatus = 400;
    const gw = await gateway({ BREAKER_MIN_FAILURES: '1' });
    const s = await tenant();
    const direct = await fetch(`${A.url}/v1/chat/completions`, { method: 'POST', body: JSON.stringify({ model: MODELS.a, messages: [] }) });
    const expected = await direct.text();
    A.hits = 0;
    for (let i = 0; i < 3; i++) {
      const res = await send(gw, s.key);
      expect(res.status).toBe(400);
      expect(await res.text()).toBe(expected);
      expect(res.headers.get('x-gateway-attempts')).toBe('1');
      expect(res.headers.get('x-gateway-model')).toBe(MODELS.a);
    }
    // Every call went to A and none to B, and three 400s did not open a breaker that opens at one failure.
    expect([A.hits, B.hits]).toEqual([3, 0]);
    await until(() => heldMicros(s.tenantId), (h) => h === 0);
    expect(await ledger(s.tenantId)).toEqual([]);
  });

  it('stream: failure before headers is retried; failure after the first chunk is not', async () => {
    failFirst(A, 1);
    const gw = await gateway({}, {});
    const s = await tenant();
    const ok = await send(gw, s.key, { stream: true });
    expect(ok.status).toBe(200);
    expect(ok.headers.get('x-gateway-attempts')).toBe('2');
    expect(await ok.text()).toContain('data: [DONE]');

    // An upstream that sends 200, one chunk, and then dies.
    const dying = await stubServer((req, res) => {
      dying.hits++;
      req.resume();
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(`data: ${JSON.stringify({ id: 'x', object: 'chat.completion.chunk', model: MODELS.a, choices: [{ index: 0, delta: { content: 'first' }, finish_reason: null }] })}\n\n`);
      setTimeout(() => res.socket?.destroy(), 20);
    });
    closers.push(() => new Promise((r) => (dying.server.closeAllConnections(), dying.server.close(r))));
    B.hits = 0;
    const gw2 = await gateway({ MOCK_BASE_URL: dying.url });
    const s2 = await tenant();
    const res = await send(gw2, s2.key, { stream: true });
    expect(res.status).toBe(200);
    expect(res.headers.get('x-gateway-attempts')).toBe('1');
    let text = '';
    try {
      const reader = res.body!.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        text += Buffer.from(value).toString('utf8');
      }
    } catch {
      // The connection ended without a clean close; what arrived before is in `text`.
    }
    expect(text).toContain('first');
    expect(dying.hits).toBe(1);
    expect(B.hits).toBe(0);
    // Tokens were partly used: the estimate stays charged, once.
    const rows = await until(() => ledger(s2.tenantId), (r) => r.length === 1);
    expect(rows[0]).toMatchObject({ model: MODELS.a, estimated: true });
    await until(() => heldMicros(s2.tenantId), (h) => h === 0);
  });

  it('retries never exceed UPSTREAM_MAX_DURATION_MS', async () => {
    for (const m of [A, B]) {
      m.settings.outage = 'error';
      m.settings.errorStatus = 503;
    }
    const gw = await gateway({
      UPSTREAM_MAX_DURATION_MS: '800',
      RETRY_MAX_ATTEMPTS_PER_MODEL: '1000',
      RETRY_BASE_MS: '300',
      RETRY_CAP_MS: '300',
      RETRY_MIN_REMAINING_MS: '100',
      BUDGET_RESERVATION_TTL_S: '300',
    });
    const s = await tenant();
    const started = performance.now();
    const res = await send(gw, s.key);
    const elapsed = performance.now() - started;
    expect([503, 504]).toContain(res.status);
    expect(elapsed).toBeLessThan(800 + 500);
    expect(Number(res.headers.get('x-gateway-attempts'))).toBeGreaterThan(1);
    // Nothing is left held, whichever way the request ended.
    await until(() => heldMicros(s.tenantId), (h) => h === 0);
  });

  it('retry-after beyond the cap sends the request to the next model at once', async () => {
    const limited = await stubServer((req, res) => {
      limited.hits++;
      req.resume();
      res.writeHead(503, { 'content-type': 'application/json', 'retry-after': '3600' });
      res.end('{"error":{"message":"busy"}}');
    });
    closers.push(() => new Promise((r) => (limited.server.closeAllConnections(), limited.server.close(r))));
    const gw = await gateway({ MOCK_BASE_URL: limited.url, RETRY_BASE_MS: '2000', RETRY_CAP_MS: '2000' });
    const s = await tenant();
    const started = performance.now();
    const res = await send(gw, s.key);
    expect(res.status).toBe(200);
    expect(performance.now() - started).toBeLessThan(1500);
    expect(res.headers.get('x-gateway-model')).toBe(MODELS.b);
    expect(res.headers.get('x-gateway-attempts')).toBe('2');
    expect(limited.hits).toBe(1);
  });

  it('breaker open on A: request goes to B with no call to A (mock A request count unchanged)', async () => {
    A.settings.outage = 'error';
    A.settings.errorStatus = 503;
    const gw = await gateway({ BREAKER_MIN_FAILURES: '2', RETRY_MAX_ATTEMPTS_PER_MODEL: '1' });
    const s = await tenant();
    for (let i = 0; i < 2; i++) {
      const r = await send(gw, s.key);
      expect(r.status).toBe(200);
      expect(r.headers.get('x-gateway-attempts')).toBe('2'); // A failed, B answered
    }
    expect(A.hits).toBe(2);
    const open = await send(gw, s.key);
    expect(open.status).toBe(200);
    expect(open.headers.get('x-gateway-model')).toBe(MODELS.b);
    expect(open.headers.get('x-gateway-attempts')).toBe('1');
    expect(A.hits).toBe(2); // unchanged: the open breaker skipped A without a call
    expect(B.hits).toBe(3);
  });

  it('all open returns 503 all_providers_unavailable with retry-after', async () => {
    for (const m of [A, B]) {
      m.settings.outage = 'error';
      m.settings.errorStatus = 503;
    }
    const clock = 1_700_000_000_000;
    const gw = await gateway(
      { BREAKER_MIN_FAILURES: '2', RETRY_MAX_ATTEMPTS_PER_MODEL: '1', BREAKER_OPEN_MS: '20000' },
      { breakerClock: () => clock },
    );
    const s = await tenant({ rpm: 100_000, tpm: 100_000_000 }, 1_000_000_000);
    for (let i = 0; i < 2; i++) expect((await send(gw, s.key)).status).toBe(503);
    const hits = [A.hits, B.hits];
    const res = await send(gw, s.key);
    expect(res.status).toBe(503);
    expect(res.headers.get('retry-after')).toBe('20');
    expect(res.headers.get('x-gateway-attempts')).toBe('0');
    expect(res.headers.has('x-gateway-model')).toBe(false);
    expect(await res.json()).toMatchObject({ error: { code: 'all_providers_unavailable', type: 'gateway_error' } });
    expect([A.hits, B.hits]).toEqual(hits); // no call to either
    // A request that never went anywhere holds nothing.
    await until(() => heldMicros(s.tenantId), (h) => h === 0);
  });

  it('50 concurrent requests the moment a breaker goes half-open: exactly one reaches A', async () => {
    A.settings.outage = 'error';
    A.settings.errorStatus = 503;
    let now = 1_700_000_000_000;
    const gw = await gateway({ BREAKER_MIN_FAILURES: '2', RETRY_MAX_ATTEMPTS_PER_MODEL: '1', BREAKER_OPEN_MS: '15000' }, { breakerClock: () => now });
    const s = await tenant();
    for (let i = 0; i < 2; i++) expect((await send(gw, s.key)).status).toBe(200);
    expect(A.hits).toBe(2);
    // A recovers (slowly, so the probe is still in flight while the others arrive); the cooldown ends.
    A.settings.outage = 'off';
    A.settings.latencyMs = 300;
    now += 15_000;
    const results = await Promise.all(Array.from({ length: 50 }, () => send(gw, s.key)));
    expect(results.map((r) => r.status)).toEqual(Array.from({ length: 50 }, () => 200));
    expect(A.hits - 2).toBe(1); // the single probe
    const served = results.map((r) => r.headers.get('x-gateway-model'));
    expect(served.filter((m) => m === MODELS.a)).toHaveLength(1);
    expect(served.filter((m) => m === MODELS.b)).toHaveLength(49);
    // The probe succeeded: the breaker is closed again and A takes the next request.
    const after = await send(gw, s.key);
    expect(after.headers.get('x-gateway-model')).toBe(MODELS.a);
  });

  it('rate limit charged once across three attempts', async () => {
    failFirst(A, 2);
    const gw = await gateway();
    const s = await tenant({ rpm: 100, tpm: 10_000_000 });
    const res = await send(gw, s.key);
    expect(res.status).toBe(200);
    expect(res.headers.get('x-gateway-attempts')).toBe('3');
    expect(A.hits).toBe(3);
    expect(res.headers.get('x-ratelimit-limit-requests')).toBe('100');
    expect(res.headers.get('x-ratelimit-remaining-requests')).toBe('99');
    const second = await send(gw, s.key);
    expect(second.headers.get('x-ratelimit-remaining-requests')).toBe('98');
  });

  it('translated 429 forwards anthropic-ratelimit and request-id headers', async () => {
    const limited = await stubServer((req, res) => {
      limited.hits++;
      req.resume();
      res.writeHead(429, {
        'content-type': 'application/json',
        'retry-after': '2',
        'request-id': 'req_abc123',
        'anthropic-ratelimit-requests-remaining': '0',
        'anthropic-ratelimit-tokens-reset': '2026-11-09T12:00:00Z',
        'server-timing': 'edge;dur=3',
        'set-cookie': 'secret=1',
      });
      res.end(JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: 'slow down' } }));
    });
    closers.push(() => new Promise((r) => (limited.server.closeAllConnections(), limited.server.close(r))));
    const gw = await gateway({ MOCK_ANTHROPIC_BASE_URL: limited.url, MODEL_FALLBACKS: '', RETRY_MAX_ATTEMPTS_PER_MODEL: '1' });
    const s = await tenant();
    const res = await send(gw, s.key, { model: MODELS.b });
    expect(res.status).toBe(429);
    expect(((await res.json()) as { error: { type: string } }).error.type).toBe('rate_limit_error');
    expect(res.headers.get('request-id')).toBe('req_abc123');
    expect(res.headers.get('anthropic-ratelimit-requests-remaining')).toBe('0');
    expect(res.headers.get('anthropic-ratelimit-tokens-reset')).toBe('2026-11-09T12:00:00Z');
    expect(res.headers.get('retry-after')).toBe('2');
    expect(res.headers.get('server-timing')).toMatch(/^edge;dur=3, gw-pre;dur=/);
    expect(res.headers.has('set-cookie')).toBe(false);
  });
});

describe('what counts as a failure, and where a failure leads', { timeout: 60_000 }, () => {
  it('429 is retried and falls over but never opens a breaker', async () => {
    A.settings.outage = 'error';
    A.settings.errorStatus = 429;
    const gw = await gateway({ BREAKER_MIN_FAILURES: '1', RETRY_MAX_ATTEMPTS_PER_MODEL: '1' });
    const s = await tenant();
    for (let i = 1; i <= 3; i++) {
      const res = await send(gw, s.key);
      expect(res.status).toBe(200);
      expect(res.headers.get('x-gateway-model')).toBe(MODELS.b);
      expect(A.hits).toBe(i); // A is asked every time: a breaker that opens at one failure never opened
    }
  });

  it.each([401, 403, 404])('%i from A skips the same-model retry and moves to B', async (status) => {
    A.settings.outage = 'error';
    A.settings.errorStatus = status;
    const gw = await gateway({ BREAKER_MIN_FAILURES: '1', RETRY_MAX_ATTEMPTS_PER_MODEL: '3' });
    const s = await tenant();
    for (let i = 1; i <= 2; i++) {
      const res = await send(gw, s.key);
      expect(res.status).toBe(200);
      expect(res.headers.get('x-gateway-model')).toBe(MODELS.b);
      expect(res.headers.get('x-gateway-attempts')).toBe('2');
      expect(A.hits).toBe(i); // once per request, and never counted against A's breaker
    }
  });

  it('401 from every model in the chain ends as the generic 502 provider_auth_failed', async () => {
    for (const m of [A, B]) {
      m.settings.outage = 'error';
      m.settings.errorStatus = 401;
    }
    const gw = await gateway();
    const s = await tenant();
    const res = await send(gw, s.key);
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ error: { code: 'provider_auth_failed' } });
    expect([A.hits, B.hits]).toEqual([1, 1]);
    await until(() => heldMicros(s.tenantId), (h) => h === 0);
  });

  it('three attempts on A are one breaker outcome', async () => {
    A.settings.outage = 'error';
    A.settings.errorStatus = 503;
    const gw = await gateway({ BREAKER_MIN_FAILURES: '3', RETRY_MAX_ATTEMPTS_PER_MODEL: '3' });
    const s = await tenant();
    expect((await send(gw, s.key)).headers.get('x-gateway-model')).toBe(MODELS.b);
    expect(A.hits).toBe(3);
    // One recorded failure of three needed: the breaker is still closed and the next request tries A again.
    expect((await send(gw, s.key)).headers.get('x-gateway-model')).toBe(MODELS.b);
    expect(A.hits).toBe(6);
  });

  it('a deadline that falls while a 503 body is being read refunds everything', async () => {
    const stuck = await stubServer((req, res) => {
      req.resume();
      res.writeHead(503, { 'content-type': 'application/json' });
      res.write('{"error":'); // the rest never comes
    });
    closers.push(() => new Promise((r) => (stuck.server.closeAllConnections(), stuck.server.close(r))));
    const gw = await gateway({ MOCK_BASE_URL: stuck.url, MODEL_FALLBACKS: '', UPSTREAM_MAX_DURATION_MS: '500' });
    const s = await tenant();
    const res = await send(gw, s.key);
    expect(res.status).toBe(504);
    await until(() => heldMicros(s.tenantId), (h) => h === 0);
    expect(await ledger(s.tenantId)).toEqual([]); // the provider had answered with an error: no spend
  });

  it('a 503 with a hanging body falls over within the error-body timeout', async () => {
    const stuck = await stubServer((req, res) => {
      req.resume();
      res.writeHead(503, { 'content-type': 'application/json' });
      res.write('{"error":'); // the rest never comes
    });
    closers.push(() => new Promise((r) => (stuck.server.closeAllConnections(), stuck.server.close(r))));
    // Control for the clock: the idle timeout alone would hold the request for 30 s.
    const gw = await gateway({ MOCK_BASE_URL: stuck.url, RETRY_MAX_ATTEMPTS_PER_MODEL: '1', UPSTREAM_ERROR_BODY_TIMEOUT_MS: '300', UPSTREAM_IDLE_TIMEOUT_MS: '30000' });
    const s = await tenant();
    const started = performance.now();
    const res = await send(gw, s.key);
    const elapsed = performance.now() - started;
    expect(res.status).toBe(200);
    expect(res.headers.get('x-gateway-model')).toBe(MODELS.b);
    expect(res.headers.get('x-gateway-attempts')).toBe('2');
    expect(elapsed).toBeGreaterThanOrEqual(250); // the dead body was waited for, but only that long
    expect(elapsed).toBeLessThan(2000);
  }, 15_000);

  it('a hanging error body at the end of the chain keeps the provider status', async () => {
    const stuck = await stubServer((req, res) => {
      req.resume();
      res.writeHead(503, { 'content-type': 'application/json' });
      res.write('{"error":');
    });
    closers.push(() => new Promise((r) => (stuck.server.closeAllConnections(), stuck.server.close(r))));
    const gw = await gateway({ MOCK_BASE_URL: stuck.url, MODEL_FALLBACKS: '', RETRY_MAX_ATTEMPTS_PER_MODEL: '1', UPSTREAM_ERROR_BODY_TIMEOUT_MS: '300' });
    const s = await tenant();
    const res = await send(gw, s.key);
    expect(res.status).toBe(503);
    await until(() => heldMicros(s.tenantId), (h) => h === 0);
  }, 15_000);

  it('a 10 MB error body is cut at the cap and the rest is never read', async () => {
    let sent = 0;
    const big = await stubServer((req, res) => {
      req.resume();
      res.writeHead(503, { 'content-type': 'text/plain' });
      const chunk = Buffer.alloc(64 * 1024, 'x');
      const pump = () => {
        while (sent < 10 * 1024 * 1024 && !res.destroyed) {
          sent += chunk.length;
          if (!res.write(chunk)) return void res.once('drain', pump);
        }
        if (!res.destroyed) res.end();
      };
      pump();
    });
    closers.push(() => new Promise((r) => (big.server.closeAllConnections(), big.server.close(r))));
    const gw = await gateway({ MOCK_BASE_URL: big.url, MODEL_FALLBACKS: '', RETRY_MAX_ATTEMPTS_PER_MODEL: '1', UPSTREAM_ERROR_BODY_MAX_BYTES: '65536' });
    const s = await tenant();
    const res = await send(gw, s.key);
    expect(res.status).toBe(503);
    expect((await res.arrayBuffer()).byteLength).toBeLessThanOrEqual(65536);
    expect(sent).toBeLessThan(10 * 1024 * 1024); // the provider was cut off, not drained
  }, 15_000);

  it('402 before dispatch carries x-gateway-model and attempts 0', async () => {
    const gw = await gateway();
    const broke = await tenant(undefined, 1); // a cap of one micro-USD: every hold is refused
    const refused = await send(gw, broke.key);
    expect(refused.status).toBe(402);
    expect(refused.headers.get('x-gateway-model')).toBe(MODELS.a);
    expect(refused.headers.get('x-gateway-attempts')).toBe('0');

    const unknown = await send(gw, (await tenant()).key, { model: 'no-such-model' });
    expect(unknown.status).toBe(400);
    expect(unknown.headers.get('x-gateway-model')).toBe('no-such-model');
    expect(unknown.headers.get('x-gateway-attempts')).toBe('0');

    const limited = await tenant({ rpm: 1, tpm: 100_000_000 });
    expect((await send(gw, limited.key)).status).toBe(200);
    const slowDown = await send(gw, limited.key);
    expect(slowDown.status).toBe(429);
    expect(slowDown.headers.get('x-gateway-model')).toBe(MODELS.a);
    expect(slowDown.headers.get('x-gateway-attempts')).toBe('0');

    // A caller the key check refuses is told nothing about models.
    const noKey = await send(gw, 'sk-nope-nope');
    expect(noKey.status).toBe(401);
    expect(noKey.headers.has('x-gateway-attempts')).toBe(false);
    expect(A.hits).toBe(1); // only the one admitted request went upstream
  });

  it('a deadline that falls with a call in flight keeps the estimate', async () => {
    A.settings.outage = 'hang';
    const gw = await gateway({ MODEL_FALLBACKS: '', UPSTREAM_MAX_DURATION_MS: '400' });
    const s = await tenant();
    const res = await send(gw, s.key);
    expect(res.status).toBe(504);
    const rows = await until(() => ledger(s.tenantId), (r) => r.length === 1);
    expect(rows[0]).toMatchObject({ estimated: true });
    await until(() => heldMicros(s.tenantId), (h) => h === 0);
  });

  it('an exhausted chain with a skipped open breaker carries retry-after for the soonest reopen', async () => {
    for (const m of [A, B]) {
      m.settings.outage = 'error';
      m.settings.errorStatus = 503;
    }
    const clock = 1_700_000_000_000;
    const gw = await gateway(
      { BREAKER_MIN_FAILURES: '2', RETRY_MAX_ATTEMPTS_PER_MODEL: '1', BREAKER_OPEN_MS: '20000' },
      { breakerClock: () => clock },
    );
    const s = await tenant();
    // B alone (it has no chain) fails twice and opens.
    for (let i = 0; i < 2; i++) expect((await send(gw, s.key, { model: MODELS.b })).status).toBe(503);
    const bHits = B.hits;
    const res = await send(gw, s.key); // A fails, B is skipped
    expect(res.status).toBe(503);
    expect(res.headers.get('retry-after')).toBe('20');
    expect(B.hits).toBe(bHits);
  });
});

describe('probe, billing and breaker bookkeeping', { timeout: 60_000 }, () => {
  const openA = async (env: Record<string, string>, now: { v: number }, extra: Parameters<typeof buildApp>[1] = {}) => {
    A.settings.outage = 'error';
    A.settings.errorStatus = 503;
    const gw = await gateway({ BREAKER_MIN_FAILURES: '2', RETRY_MAX_ATTEMPTS_PER_MODEL: '1', BREAKER_OPEN_MS: '15000', ...env }, { breakerClock: () => now.v, ...extra });
    const s = await tenant();
    for (let i = 0; i < 2; i++) expect((await send(gw, s.key)).status).toBe(200);
    expect(A.hits).toBe(2);
    return { gw, s };
  };

  it('a half-open probe is one attempt even when retries are allowed, and falls over', async () => {
    const now = { v: 1_700_000_000_000 };
    const { gw, s } = await openA({}, now);
    // The retries are switched on only now: the two failures above were one attempt each.
    // (A fresh gateway shares the breaker through Redis.)
    const gw3 = await gateway({ BREAKER_MIN_FAILURES: '2', RETRY_MAX_ATTEMPTS_PER_MODEL: '3', BREAKER_OPEN_MS: '15000' }, { breakerClock: () => now.v });
    void gw;
    now.v += 15_000;
    const res = await send(gw3, s.key);
    expect(res.status).toBe(200);
    expect(res.headers.get('x-gateway-model')).toBe(MODELS.b);
    expect(res.headers.get('x-gateway-attempts')).toBe('2');
    expect(A.hits).toBe(3); // exactly one probe call
  });

  it('a probe answered 429 reopens the breaker instead of closing it', async () => {
    const now = { v: 1_700_000_000_000 };
    const { gw, s } = await openA({}, now);
    A.settings.errorStatus = 429;
    now.v += 15_000;
    expect((await send(gw, s.key)).status).toBe(200); // the probe: 429, then B answers
    expect(A.hits).toBe(3);
    expect((await send(gw, s.key)).headers.get('x-gateway-attempts')).toBe('1'); // open again: A skipped
    expect(A.hits).toBe(3);
  });

  it('a retry is not made once the breaker has opened meanwhile', async () => {
    let first = true;
    const stub = await stubServer((req, res) => {
      stub.hits++;
      req.resume();
      const headers: Record<string, string> = { 'content-type': 'application/json' };
      if (first) {
        first = false;
        headers['retry-after'] = '1'; // the first request sits out a second between its attempts
      }
      res.writeHead(503, headers);
      res.end('{"error":{"message":"down"}}');
    });
    closers.push(() => new Promise((r) => (stub.server.closeAllConnections(), stub.server.close(r))));
    const gw = await gateway({ MOCK_BASE_URL: stub.url, BREAKER_MIN_FAILURES: '2', BREAKER_OPEN_MS: '60000' });
    const s = await tenant();
    const slow = send(gw, s.key);
    await until(async () => stub.hits, (h) => h === 1);
    // Two more requests fail on A (3 attempts each) while the first waits, and open the breaker.
    for (let i = 0; i < 2; i++) expect((await send(gw, s.key)).status).toBe(200);
    expect(stub.hits).toBe(7);
    const res = await slow;
    expect(res.status).toBe(200);
    expect(res.headers.get('x-gateway-model')).toBe(MODELS.b);
    expect(stub.hits).toBe(7); // the waiting request did not call A again
  });

  it('reporting to the breaker is never waited for, and a failing report is harmless', async () => {
    let released = 0;
    const slow = (b: Breaker): Breaker => ({
      acquire: (t) => b.acquire(t),
      record: async (p, r) => {
        await b.record(p, r);
        await new Promise((res) => setTimeout(res, 1500));
        released++;
        throw new Error('boom');
      },
    });
    A.settings.outage = 'error';
    A.settings.errorStatus = 503;
    const gw = await gateway({ RETRY_MAX_ATTEMPTS_PER_MODEL: '1' }, { wrapBreaker: slow });
    const s = await tenant();
    const started = performance.now();
    const res = await send(gw, s.key);
    expect(res.status).toBe(200);
    expect(performance.now() - started).toBeLessThan(1000);
    expect(released).toBe(0);
  });

  it('retry-after from an open breaker is added to a 5xx answer but never to a 4xx', async () => {
    const now = { v: 1_700_000_000_000 };
    // B alone opens; A then answers 404 (falls over to the open B) or 503.
    B.settings.outage = 'error';
    B.settings.errorStatus = 503;
    A.settings.outage = 'error';
    const gw = await gateway({ BREAKER_MIN_FAILURES: '2', RETRY_MAX_ATTEMPTS_PER_MODEL: '1', BREAKER_OPEN_MS: '20000' }, { breakerClock: () => now.v });
    const s = await tenant();
    A.settings.errorStatus = 503;
    for (let i = 0; i < 2; i++) expect((await send(gw, s.key, { model: MODELS.b })).status).toBe(503);
    A.settings.errorStatus = 400;
    const four = await send(gw, s.key, { model: MODELS.a });
    expect(four.status).toBe(400);
    expect(four.headers.has('retry-after')).toBe(false);
    A.settings.errorStatus = 404;
    const nf = await send(gw, s.key, { model: MODELS.a });
    expect(nf.status).toBe(404); // falls over to the open B, and the answer is A's 404
    expect(nf.headers.has('retry-after')).toBe(false);
    A.settings.errorStatus = 503;
    const five = await send(gw, s.key, { model: MODELS.a });
    expect(five.status).toBe(503);
    expect(five.headers.get('retry-after')).toBe('20');
  });

  it('a provider-side 404 is logged at warn with the model, provider and status', async () => {
    A.settings.outage = 'error';
    A.settings.errorStatus = 404;
    const lines: string[] = [];
    const logStream = new (await import('node:stream')).Writable({ write: (c, _e, cb) => (lines.push(String(c)), cb()) });
    const gw = await gateway({ LOG_LEVEL: 'warn' }, { logStream });
    const s = await tenant();
    expect((await send(gw, s.key)).status).toBe(200);
    const entry = lines.map((l) => JSON.parse(l) as Record<string, unknown>).find((l) => l.msg === 'provider rejected the request, trying the next model');
    expect(entry).toMatchObject({ level: 40, model: MODELS.a, status: 404 });
    expect(typeof entry?.target).toBe('string');
  });

  it('a headers timeout on A keeps the estimate even when B then refuses the connection', async () => {
    A.settings.outage = 'hang';
    const dead = await deadUrl();
    const gw = await gateway({ UPSTREAM_HEADERS_TIMEOUT_MS: '200', MOCK_ANTHROPIC_BASE_URL: dead, RETRY_MAX_ATTEMPTS_PER_MODEL: '1' });
    const s = await tenant();
    const res = await send(gw, s.key);
    expect(res.status).toBe(502);
    const rows = await until(() => ledger(s.tenantId), (r) => r.length === 1);
    expect(rows[0]).toMatchObject({ estimated: true });
    await until(() => heldMicros(s.tenantId), (h) => h === 0);
  });

  it('a connect refusal on every model bills nothing', async () => {
    const dead = await deadUrl();
    const gw = await gateway({ MOCK_BASE_URL: dead, MOCK_ANTHROPIC_BASE_URL: dead, RETRY_MAX_ATTEMPTS_PER_MODEL: '1' });
    const s = await tenant();
    const res = await send(gw, s.key);
    expect(res.status).toBeGreaterThanOrEqual(500);
    await until(() => heldMicros(s.tenantId), (h) => h === 0);
    expect(await ledger(s.tenantId)).toEqual([]);
  });
});

describe('the breaker with nothing else using Redis', () => {
  it('is shared through Redis when the auth cache, rate limit and budget are all off', async () => {
    A.settings.outage = 'error';
    A.settings.errorStatus = 503;
    const gw = await gateway({ AUTH_CACHE: 'none', RATE_LIMIT_ENABLED: 'false', BUDGET_ENABLED: 'false', BREAKER_MIN_FAILURES: '1', RETRY_MAX_ATTEMPTS_PER_MODEL: '1' });
    const s = await tenant();
    expect((await send(gw, s.key)).status).toBe(200);
    expect((await redis.keys(`${prefix}breaker:*`)).length).toBeGreaterThan(0);
  });
});

describe('budget with a fallback chain', { timeout: 60_000 }, () => {
  // Real prices, served by the mocks: a cheap model first, a dear one as its fallback.
  const CHEAP = 'gpt-5-nano';
  const MID = 'claude-haiku-5-5';
  const DEAR = 'claude-fable-5-1';
  const env = {
    MODEL_ROUTES: `${CHEAP}=mock-openai,${MID}=mock-openai,${DEAR}=mock-anthropic`,
    MODEL_FALLBACKS: `${CHEAP}>${DEAR}`,
  };
  const request = { messages: [{ role: 'user', content: 'hi' }], max_tokens: 20 };
  const hold = (model: string) => {
    const { prompt, output } = estimateWorstCase(request, base.rateLimitDefaultMaxTokens);
    return costMicros(priceFor(model)!, prompt, output);
  };

  it('budget hold priced at the dearest chain model; charge priced at the serving model', async () => {
    expect(hold(CHEAP)).toBeLessThan(hold(MID));
    expect(hold(MID)).toBeLessThan(hold(DEAR));
    const gw = await gateway(env);
    // A cap that fits the cheap and the middle model's worst case but not the dear fallback's.
    const capped = await tenant({ rpm: 100_000, tpm: 100_000_000 }, hold(MID));
    const refused = await send(gw, capped.key, { model: CHEAP });
    expect(refused.status).toBe(402);
    expect(await refused.json()).toMatchObject({ error: { code: 'budget_exhausted' } });
    expect([A.hits, B.hits]).toEqual([0, 0]); // refused up front, nothing was called
    expect(await heldMicros(capped.tenantId)).toBe(0);
    // The same cap serves a model that has no chain: the refusal above is the chain's doing.
    const control = await send(gw, capped.key, { model: MID });
    expect(control.status).toBe(200);

    // With room for the dear model, a request that falls back is charged at the dear model's price.
    A.settings.outage = 'error';
    A.settings.errorStatus = 503;
    const roomy = await tenant({ rpm: 100_000, tpm: 100_000_000 }, 10 * hold(DEAR));
    const res = await send(gw, roomy.key, { model: CHEAP });
    expect(res.status).toBe(200);
    expect(res.headers.get('x-gateway-model')).toBe(DEAR);
    const usage = ((await res.json()) as { usage: { prompt_tokens: number; completion_tokens: number } }).usage;
    const rows = await until(() => ledger(roomy.tenantId), (r) => r.length === 1);
    expect(rows[0]).toEqual({
      model: DEAR,
      cost: costMicros(priceFor(DEAR)!, usage.prompt_tokens, usage.completion_tokens),
      estimated: false,
      prompt: usage.prompt_tokens,
      completion: usage.completion_tokens,
    });
    expect(rows[0]!.cost).toBeGreaterThan(costMicros(priceFor(CHEAP)!, usage.prompt_tokens, usage.completion_tokens));
    await until(() => heldMicros(roomy.tenantId), (h) => h === 0);
  });
});
