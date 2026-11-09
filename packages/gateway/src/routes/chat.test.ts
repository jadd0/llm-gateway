import http, { type Server } from 'node:http';
import { Readable } from 'node:stream';
import type { AddressInfo } from 'node:net';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createMockServer, type Settings } from '../../../mock-provider/src/server.ts';
import Fastify from 'fastify';
import { buildApp } from '../app.ts';
import type { Upstream } from '../upstream.ts';
import { chatRoutes } from './chat.ts';
import { Redis } from 'ioredis';
import { createDb, type Db } from '../db/client.ts';
import { cleanup, seedKey, testConfig } from '../test-env.ts';

const settings: Settings = {
  latencyMs: 0,
  tokenDelayMs: 0,
  completionTokens: 5,
  errorRate: 0,
  outage: 'off',
};
const defaults = { ...settings };

// Every app in this file shares one pepper and Redis prefix so the one seeded key works on all of them.
const base = testConfig();
const cfg = (env: Record<string, string>) =>
  testConfig({ API_KEY_PEPPER: base.apiKeyPepper, REDIS_KEY_PREFIX: base.redisKeyPrefix, ...env });
let key = '';
let tenantId = '';
let handle: Db;
let cleanupRedis: Redis;
const auth = () => ({ authorization: `Bearer ${key}` });

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
  handle = createDb({ databaseUrl: base.databaseUrl, poolSize: 2 });
  cleanupRedis = new Redis(base.redisUrl!);
  const seeded = await seedKey(handle.db, base);
  key = seeded.key;
  tenantId = seeded.tenantId;
  app = buildApp(cfg({ OPENAI_BASE_URL: mockUrl, UPSTREAM_TIMEOUT_MS: '1000', LOG_LEVEL: 'silent' }));
  await app.listen({ port: 0, host: '127.0.0.1' });
  gw = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await app.close();
  mock.closeAllConnections();
  await new Promise((resolve) => mock.close(resolve));
  await cleanup(handle.db, cleanupRedis, [tenantId], base.redisKeyPrefix);
  cleanupRedis.disconnect();
  await handle.close();
});

beforeEach(() => {
  Object.assign(settings, defaults);
  upstreamRequests = 0;
  closedResponses = 0;
});

const payload = (extra: object = {}) =>
  JSON.stringify({ model: 'm', messages: [{ role: 'user', content: 'hi' }], ...extra });

const post = (body: string, init: RequestInit = {}) => {
  const { headers, ...rest } = init;
  return fetch(`${gw}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...auth(), ...(headers as Record<string, string>) },
    body,
    ...rest,
  });
};

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

  it('unsupported content-type returns 415 with an OpenAI-shaped error', async () => {
    const res = await post(payload(), { headers: { 'content-type': 'application/x-www-form-urlencoded' } });
    expect(res.status).toBe(415);
    const err = ((await res.json()) as any).error;
    expect(err.type).toBe('invalid_request_error');
    expect(typeof err.message).toBe('string');
    expect(upstreamRequests).toBe(0);
  });

  it('upstream down returns 502 with an OpenAI-shaped error', async () => {
    const down = buildApp(cfg({ OPENAI_BASE_URL: 'http://127.0.0.1:1', LOG_LEVEL: 'silent' }));
    try {
      const res = await down.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        headers: { 'content-type': 'application/json', ...auth() },
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

  it('non-streamed response carries server-timing gw-pre, gw-post and upstream durations', async () => {
    Object.assign(settings, { latencyMs: 100 });
    const res = await post(payload());
    const timing = res.headers.get('server-timing') ?? '';
    const m = /^gw-pre;dur=([\d.]+), gw-post;dur=([\d.]+), upstream;dur=([\d.]+)$/.exec(timing);
    expect(m).not.toBeNull();
    expect(Number(m![3])).toBeGreaterThanOrEqual(100);
    expect(Number(m![1])).toBeGreaterThanOrEqual(0);
    expect(Number(m![2])).toBeGreaterThanOrEqual(0);
  });

  it('streamed response carries server-timing gw-pre', async () => {
    const res = await post(payload({ stream: true }));
    expect(res.headers.get('server-timing')).toMatch(/^gw-pre;dur=[\d.]+$/);
    await res.text();
  });

  it('unknown route returns 404 in the OpenAI error shape', async () => {
    const res = await fetch(`${gw}/v1/nope`, { headers: auth() });
    expect(res.status).toBe(404);
    expect(((await res.json()) as any).error.type).toBe('invalid_request_error');
  });

  it('unknown POST route with an odd content-type returns 404, not 415', async () => {
    const res = await fetch(`${gw}/v1/embeddings`, {
      method: 'POST',
      headers: { 'content-type': 'text/xml', ...auth() },
      body: '<a/>',
    });
    expect(res.status).toBe(404);
    expect(((await res.json()) as any).error.type).toBe('invalid_request_error');
  });

  it('upstream rate-limit headers pass through on a 429, streamed and not', async () => {
    const limited = http.createServer((req, res) => {
      req.resume();
      res.writeHead(429, {
        'content-type': 'application/json',
        'retry-after': '7',
        'x-request-id': 'req_abc',
        'x-ratelimit-remaining-requests': '0',
        'set-cookie': 'secret=1',
      });
      res.end('{"error":{"message":"slow down","type":"rate_limit"}}');
    });
    const port = await listen(limited);
    const app2 = buildApp(cfg({ OPENAI_BASE_URL: `http://127.0.0.1:${port}`, LOG_LEVEL: 'silent' }));
    try {
      for (const stream of [false, true]) {
        const res = await app2.inject({
          method: 'POST',
          url: '/v1/chat/completions',
          headers: { 'content-type': 'application/json', ...auth() },
          payload: payload({ stream }),
        });
        expect(res.statusCode).toBe(429);
        expect(res.headers['retry-after']).toBe('7');
        expect(res.headers['x-request-id']).toBe('req_abc');
        expect(res.headers['x-ratelimit-remaining-requests']).toBe('0');
        expect(res.headers['set-cookie']).toBeUndefined();
      }
    } finally {
      await app2.close();
      limited.closeAllConnections();
      await new Promise((resolve) => limited.close(resolve));
    }
  });
});

describe('mid-stream failure logging', () => {
  const lines: string[] = [];
  const terminated = () => lines.filter((l) => l.includes('stream terminated'));
  const logStream = { write: (l: string) => void lines.push(l) } as unknown as NodeJS.WritableStream;
  beforeEach(() => {
    lines.length = 0;
  });

  // Starts a streaming SSE upstream that emits a chunk every 20 ms until its socket is destroyed.
  const slowUpstream = async () => {
    const sockets = new Set<import('node:net').Socket>();
    const server = http.createServer((req, res) => {
      req.resume();
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const t = setInterval(() => res.write('data: {"x":1}\n\n'), 20);
      res.on('close', () => clearInterval(t));
    });
    server.on('connection', (s) => sockets.add(s));
    const port = await listen(server);
    return {
      port,
      resetSockets: () => sockets.forEach((s) => s.destroy()),
      close: async () => {
        sockets.forEach((s) => s.destroy());
        await new Promise((resolve) => server.close(resolve));
      },
    };
  };

  const gatewayFor = async (port: number) => {
    const g = buildApp(
      cfg({ OPENAI_BASE_URL: `http://127.0.0.1:${port}`, UPSTREAM_TIMEOUT_MS: '1000', LOG_LEVEL: 'warn' }),
      { logStream },
    );
    await g.listen({ port: 0, host: '127.0.0.1' });
    return { g, url: `http://127.0.0.1:${(g.server.address() as AddressInfo).port}` };
  };

  const openStream = async (url: string, signal?: AbortSignal) => {
    const res = await fetch(`${url}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...auth() },
      body: payload({ stream: true }),
      ...(signal ? { signal } : {}),
    });
    const reader = res.body!.getReader();
    await reader.read();
    return reader;
  };

  it('an upstream reset mid-stream logs one warn', async () => {
    const up = await slowUpstream();
    const { g, url } = await gatewayFor(up.port);
    try {
      const reader = await openStream(url);
      up.resetSockets();
      await reader.read().catch(() => undefined);
      expect(await until(() => terminated().length === 1)).toBe(true);
      await new Promise((r) => setTimeout(r, 100));
      expect(terminated()).toHaveLength(1);
    } finally {
      await g.close();
      await up.close();
    }
  });

  it('a client abort mid-stream logs no warn', async () => {
    const up = await slowUpstream();
    const { g, url } = await gatewayFor(up.port);
    try {
      const ctrl = new AbortController();
      await openStream(url, ctrl.signal);
      ctrl.abort();
      await new Promise((r) => setTimeout(r, 300));
      expect(terminated()).toHaveLength(0);
    } finally {
      await g.close();
      await up.close();
    }
  });

  it('an upstream body destroyed without an error event still logs one warn', async () => {
    // A fake pool hands the route a body that is later destroyed with no error, which a real
    // socket never produces on demand.
    const body = new Readable({ read() {} });
    body.push('data: {"x":1}\n\n');
    const upstream = {
      chatPath: '/v1/chat/completions',
      headers: {},
      pool: {
        request: async () => ({
          statusCode: 200,
          headers: { 'content-type': 'text/event-stream' },
          body,
        }),
      },
    } as unknown as Upstream;
    const app3 = Fastify({ logger: { level: 'warn', stream: logStream } });
    app3.register(chatRoutes, { upstream });
    await app3.listen({ port: 0, host: '127.0.0.1' });
    try {
      const url = `http://127.0.0.1:${(app3.server.address() as AddressInfo).port}`;
      const reader = await openStream(url);
      body.destroy();
      await reader.read().catch(() => undefined);
      expect(await until(() => terminated().length === 1)).toBe(true);
    } finally {
      await app3.close();
    }
  });
});
