import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createMockServer, type Settings } from '../../../mock-provider/src/server.ts';
import { buildApp } from '../app.ts';
import { loadConfig } from '../config.ts';

const settings: Settings = {
  latencyMs: 0,
  tokenDelayMs: 0,
  completionTokens: 5,
  errorRate: 0,
  outage: 'off',
};
const defaults = { ...settings };

let mock: Server;
let mockUrl = '';
let app: FastifyInstance;
let gw = '';
let upstreamRequests = 0;
let closedResponses = 0;

const listen = (server: Server) =>
  new Promise<number>((resolve) =>
    server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port)),
  );

beforeAll(async () => {
  mock = createMockServer(settings);
  mock.on('request', (req, res) => {
    if (req.url === '/v1/chat/completions') {
      upstreamRequests++;
      res.on('close', () => {
        if (!res.writableFinished) closedResponses++;
      });
    }
  });
  mockUrl = `http://127.0.0.1:${await listen(mock)}`;
  app = buildApp(
    loadConfig({ OPENAI_BASE_URL: mockUrl, UPSTREAM_TIMEOUT_MS: '1000', LOG_LEVEL: 'silent' }),
  );
  await app.listen({ port: 0, host: '127.0.0.1' });
  gw = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await app.close();
  mock.closeAllConnections();
  await new Promise((resolve) => mock.close(resolve));
});

beforeEach(() => {
  Object.assign(settings, defaults);
  upstreamRequests = 0;
  closedResponses = 0;
});

const payload = (extra: object = {}) =>
  JSON.stringify({ model: 'm', messages: [{ role: 'user', content: 'hi' }], ...extra });

const post = (body: string, init: RequestInit = {}) =>
  fetch(`${gw}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
    ...init,
  });

const until = async (cond: () => boolean, timeoutMs = 2000) => {
  const end = Date.now() + timeoutMs;
  while (!cond() && Date.now() < end) await new Promise((r) => setTimeout(r, 10));
  return cond();
};

describe('POST /v1/chat/completions', () => {
  it('non-streamed request returns the mock completion and usage', async () => {
    const res = await post(payload());
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/json');
    const json = (await res.json()) as any;
    expect(json.object).toBe('chat.completion');
    expect(json.choices[0].message.content).toBe('tok tok tok tok tok');
    expect(json.usage.completion_tokens).toBe(5);
  });

  it('streamed request relays SSE chunks ending in [DONE]', async () => {
    const res = await post(payload({ stream: true }));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/event-stream');
    const events = (await res.text()).split('\n\n').filter(Boolean);
    expect(events.at(-1)).toBe('data: [DONE]');
    const chunks = events.slice(0, -1).map((e) => JSON.parse(e.slice(6)));
    expect(chunks.filter((c) => c.choices[0].delta.content === 'tok ')).toHaveLength(5);
    expect(chunks.at(-1).usage.completion_tokens).toBe(5);
  });

  it('stream is unbuffered: first chunk arrives before the mock sends its last', async () => {
    Object.assign(settings, { completionTokens: 20, tokenDelayMs: 50 });
    const t0 = performance.now();
    const res = await post(payload({ stream: true }));
    const reader = res.body!.getReader();
    const first = await reader.read();
    const firstAt = performance.now() - t0;
    expect(first.done).toBe(false);
    while (!(await reader.read()).done);
    const total = performance.now() - t0;

    // The mock spaces 20 tokens 50 ms apart (19 gaps, about 950 ms): a buffering gateway would
    // deliver the first byte only at the end.
    expect(firstAt).toBeLessThan(500);
    expect(total).toBeGreaterThan(900);
    expect(total - firstAt).toBeGreaterThan(700);
  });

  it('client abort mid-stream aborts the upstream request', async () => {
    Object.assign(settings, { completionTokens: 100, tokenDelayMs: 50 });
    const ctrl = new AbortController();
    const res = await post(payload({ stream: true }), { signal: ctrl.signal });
    await res.body!.getReader().read();
    expect(upstreamRequests).toBe(1);
    expect(closedResponses).toBe(0);
    ctrl.abort();
    expect(await until(() => closedResponses === 1)).toBe(true);
  });

  it('invalid body returns 400 without calling upstream', async () => {
    for (const body of ['not json', '{}', JSON.stringify({ model: 1, messages: [] }), JSON.stringify({ model: 'm' })]) {
      const res = await post(body);
      expect(res.status).toBe(400);
      expect(((await res.json()) as any).error.type).toBe('invalid_request_error');
    }
    expect(upstreamRequests).toBe(0);
  });

  it('upstream down returns 502 with an OpenAI-shaped error', async () => {
    const down = buildApp(
      loadConfig({ OPENAI_BASE_URL: 'http://127.0.0.1:1', LOG_LEVEL: 'silent' }),
    );
    try {
      const res = await down.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        headers: { 'content-type': 'application/json' },
        payload: payload(),
      });
      expect(res.statusCode).toBe(502);
      const err = res.json().error;
      expect(err.type).toBe('gateway_error');
      expect(typeof err.message).toBe('string');
    } finally {
      await down.close();
    }
  });

  it('upstream hang returns 504 within the timeout', async () => {
    settings.outage = 'hang';
    const t0 = performance.now();
    const res = await post(payload());
    expect(res.status).toBe(504);
    expect(performance.now() - t0).toBeLessThan(3000);
  });

  it('upstream 500 is passed through with its status', async () => {
    settings.outage = 'error';
    const res = await post(payload());
    expect(res.status).toBe(500);
    expect(((await res.json()) as any).error.type).toBe('server_error');
  });

  it('non-streamed response carries server-timing gw and upstream durations', async () => {
    Object.assign(settings, { latencyMs: 100 });
    const res = await post(payload());
    const timing = res.headers.get('server-timing') ?? '';
    const m = /^gw;dur=([\d.]+), upstream;dur=([\d.]+)$/.exec(timing);
    expect(m).not.toBeNull();
    expect(Number(m![2])).toBeGreaterThanOrEqual(100);
    expect(Number(m![1])).toBeGreaterThanOrEqual(0);
  });

  it('streamed response carries server-timing gw-pre', async () => {
    const res = await post(payload({ stream: true }));
    expect(res.headers.get('server-timing')).toMatch(/^gw-pre;dur=[\d.]+$/);
    await res.text();
  });
});
