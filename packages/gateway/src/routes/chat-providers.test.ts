import http, { type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { FastifyInstance } from 'fastify';
import { sql } from 'drizzle-orm';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createMockServer, type Settings } from '../../../mock-provider/src/server.ts';
import { buildApp } from '../app.ts';
import { costMicros, defaultMaxTokensFor, formatUsd, priceFor } from '../pricing/prices.ts';
import { estimateWorstCase } from '../usage/estimate.ts';
import { createDb, type Db } from '../db/client.ts';
import { cleanup, seedKey, testConfig } from '../test-env.ts';

// Two upstreams. The mock provider (three formats, fixed 5 completion tokens) for the happy paths, and
// a stub that records every request it gets and misbehaves on demand (429, 529, held-open streams,
// echoing the prompt back in small pieces).
const settings: Settings = { latencyMs: 0, tokenDelayMs: 0, completionTokens: 5, errorRate: 0, outage: 'off' };

interface Seen {
  url: string;
  headers: IncomingHttpHeaders;
  body: any;
}
const seen: Seen[] = [];
let release: () => void = () => {};
let gate = new Promise<void>((r) => (release = r));

const message = (id: string, text: string) => ({
  id,
  type: 'message',
  role: 'assistant',
  model: 'stub',
  content: [{ type: 'text', text }],
  stop_reason: 'end_turn',
  usage: { input_tokens: 3, output_tokens: 4 },
});
const anthropicEvents = (text: string, tail = true) =>
  `event: message_start\ndata: ${JSON.stringify({ type: 'message_start', message: { id: 'msg_s', model: 'stub', usage: { input_tokens: 3, output_tokens: 1 } } })}\n\n` +
  `event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } })}\n\n` +
  (tail
    ? `event: message_delta\ndata: ${JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 4 } })}\n\n` +
      `event: message_stop\ndata: {"type":"message_stop"}\n\n`
    : '');
const geminiEvent = (text: string, last: boolean) =>
  `data: ${JSON.stringify({ candidates: [{ content: { role: 'model', parts: [{ text }] }, index: 0, ...(last ? { finishReason: 'STOP' } : {}) }], ...(last ? { usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 4 } } : {}) })}\r\n\r\n`;

// Writes `text` a few bytes at a time so multi-byte characters and events land split across TCP packets.
async function trickle(res: http.ServerResponse, text: string) {
  const bytes = Buffer.from(text, 'utf8');
  for (let i = 0; i < bytes.length; i += 3) {
    res.write(bytes.subarray(i, i + 3));
    await new Promise((r) => setTimeout(r, 1));
  }
  res.end();
}

async function stubHandler(req: http.IncomingMessage, res: http.ServerResponse) {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  seen.push({ url: req.url ?? '', headers: req.headers, body });
  const path = (req.url ?? '').split('?')[0]!;
  const json = (status: number, obj: unknown, headers: Record<string, string> = {}) => {
    res.writeHead(status, { 'content-type': 'application/json', ...headers });
    res.end(JSON.stringify(obj));
  };
  const sse = () => res.writeHead(200, { 'content-type': 'text/event-stream' });

  // A model named *-401 or *-403 is one the provider refuses because the gateway's own key is bad.
  const authFail = /-(401|403)(?![0-9])/.exec(`${body.model ?? ''} ${path}`);
  if (authFail) {
    const status = Number(authFail[1]);
    return json(
      status,
      { error: { message: 'Incorrect API key provided: sk-live-REDACTED', type: 'invalid_request_error', code: 'invalid_api_key', status: 'UNAUTHENTICATED' } },
      { 'request-id': 'req_auth_1', 'anthropic-ratelimit-requests-remaining': '7', 'set-cookie': 'a=b' },
    );
  }
  if (path.endsWith('/chat/completions')) {
    return json(200, { id: 'x', object: 'chat.completion', choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } });
  }
  if (path.endsWith('/v1/messages')) {
    const model: string = body.model;
    if (model.endsWith('-429')) return json(429, { type: 'error', error: { type: 'rate_limit_error', message: 'slow down' } }, { 'retry-after': '7' });
    if (model.endsWith('-529')) return json(529, { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } });
    const echo: string = body.messages?.[0]?.content ?? 'ok';
    if (!body.stream) return json(200, message('msg_s', model.endsWith('-echo') ? echo : 'ok'));
    sse();
    if (model.endsWith('-gate')) {
      res.write(anthropicEvents('first', false));
      await gate;
      res.end(`event: message_delta\ndata: ${JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 4 } })}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n`);
      return;
    }
    return trickle(res, anthropicEvents(model.endsWith('-echo') ? echo : 'ok'));
  }
  if (/:(stream)?[gG]enerateContent$/.test(path)) {
    const streamed = path.includes(':streamGenerateContent');
    const echo: string = body.contents?.[0]?.parts?.[0]?.text ?? 'ok';
    const text = path.includes('-echo') ? echo : 'ok';
    if (!streamed) {
      return json(200, { candidates: [{ content: { role: 'model', parts: [{ text }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 4 } });
    }
    sse();
    return trickle(res, geminiEvent(text.slice(0, 2), false) + geminiEvent(text.slice(2), true));
  }
  return json(404, { error: { message: 'stub: unknown path' } });
}

const listen = (server: Server) =>
  new Promise<number>((resolve) => server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port)));

const base = testConfig({ BUDGET_ENABLED: 'true' });
const prefix = base.redisKeyPrefix;
let mock: Server;
let stub: Server;
let handle: Db;
let redis: Redis;
let viaMock: FastifyInstance;
let viaStub: FastifyInstance;
let noKeys: FastifyInstance;
let unmetered: FastifyInstance;
let logged: FastifyInstance;
const logLines: string[] = [];
const urls = { mock: '', stub: '', viaMock: '', viaStub: '', noKeys: '', unmetered: '', logged: '' };
const tenantIds: string[] = [];
let key = '';
let tenantId = '';

const KEYS = { OPENAI_API_KEY: 'sk-openai-secret-1', ANTHROPIC_API_KEY: 'sk-ant-secret-2', GEMINI_API_KEY: 'AIza-gemini-secret-3' };

beforeAll(async () => {
  mock = createMockServer(settings);
  stub = http.createServer((req, res) => {
    stubHandler(req, res).catch(() => res.destroy());
  });
  urls.mock = `http://127.0.0.1:${await listen(mock)}`;
  urls.stub = `http://127.0.0.1:${await listen(stub)}`;
  handle = createDb({ databaseUrl: base.databaseUrl, poolSize: 4 });
  redis = new Redis(base.redisUrl!);
  const seeded = await seedKey(handle.db, base, { rpm: 100000, tpm: 100000000 });
  key = seeded.key;
  tenantId = seeded.tenantId;
  tenantIds.push(tenantId);
  const cfg = (env: Record<string, string>) =>
    testConfig({ API_KEY_PEPPER: base.apiKeyPepper, REDIS_KEY_PREFIX: prefix, BUDGET_ENABLED: 'true', RATE_LIMIT_REDIS_TIMEOUT_MS: '5000', BUDGET_REDIS_TIMEOUT_MS: '5000', ...env });
  viaMock = buildApp(cfg({ OPENAI_BASE_URL: `${urls.mock}/v1`, MOCK_BASE_URL: urls.mock }));
  viaStub = buildApp(
    cfg({
      OPENAI_BASE_URL: `${urls.stub}/api/v1`, // a path prefix, as OpenRouter's
      ANTHROPIC_BASE_URL: `${urls.stub}/anthropic`,
      GEMINI_BASE_URL: `${urls.stub}/v1beta`,
      MOCK_BASE_URL: urls.stub,
      ...KEYS,
    }),
  );
  noKeys = buildApp(cfg({ OPENAI_BASE_URL: `${urls.stub}/v1`, MOCK_BASE_URL: urls.stub }));
  unmetered = buildApp(cfg({ OPENAI_BASE_URL: `${urls.stub}/v1`, MOCK_BASE_URL: urls.stub, BUDGET_ENABLED: 'false' }));
  logged = buildApp(
    cfg({ OPENAI_BASE_URL: `${urls.stub}/api/v1`, ANTHROPIC_BASE_URL: `${urls.stub}/anthropic`, GEMINI_BASE_URL: `${urls.stub}/v1beta`, MOCK_BASE_URL: urls.stub, LOG_LEVEL: 'error', ...KEYS }),
    { logStream: { write: (line: string) => void logLines.push(line) } as unknown as NodeJS.WritableStream },
  );
  for (const [name, app] of [['viaMock', viaMock], ['viaStub', viaStub], ['noKeys', noKeys], ['unmetered', unmetered], ['logged', logged]] as const) {
    await app.listen({ port: 0, host: '127.0.0.1' });
    urls[name] = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  }
});

afterAll(async () => {
  release();
  for (const app of [viaMock, viaStub, noKeys, unmetered, logged]) await app.close();
  mock.closeAllConnections();
  stub.closeAllConnections();
  await new Promise((resolve) => mock.close(resolve));
  await new Promise((resolve) => stub.close(resolve));
  await cleanup(handle.db, redis, tenantIds, prefix);
  redis.disconnect();
  await handle.close();
});

const post = (gw: string, payload: object, k = key) =>
  fetch(`${gw}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${k}` },
    body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }], max_tokens: 20, ...payload }),
  });
const sseEvents = (text: string) => text.split('\n\n').filter(Boolean).map((e) => (e.slice(6) === '[DONE]' ? '[DONE]' : JSON.parse(e.slice(6))));
const spend = async (id: string) => {
  const spent = await handle.db.execute(sql`select coalesce(sum(spent_micros), 0) as s from tenant_spend where tenant_id = ${id}`);
  const held = await handle.db.execute(sql`select coalesce(sum(amount_micros), 0) as s from budget_reservations where tenant_id = ${id}`);
  return { spent: Number(spent.rows[0]!.s), reserved: Number(held.rows[0]!.s) };
};
async function settledTo(id: string, spent: number) {
  const end = Date.now() + 15_000;
  let b = await spend(id);
  while ((b.spent !== spent || b.reserved !== 0) && Date.now() < end) {
    await new Promise((r) => setTimeout(r, 10));
    b = await spend(id);
  }
  return b;
}
const fresh = async () => {
  const s = await seedKey(handle.db, base, { rpm: 100000, tpm: 100000000 });
  tenantIds.push(s.tenantId);
  return s;
};

describe('providers through the gateway', { timeout: 60_000 }, () => {
  const formats = [
    ['mock-openai-1', '/v1/chat/completions'],
    ['mock-anthropic-1', '/v1/messages'],
    ['mock-gemini-1', '/v1beta/models/mock-gemini-1:generateContent'],
  ] as const;

  it('each provider format via the mock returns an OpenAI-shaped response', async () => {
    for (const [model] of formats) {
      const res = await post(urls.viaMock, { model });
      expect(res.status, model).toBe(200);
      expect(res.headers.get('content-type'), model).toContain('application/json');
      const json = (await res.json()) as any;
      expect(json.object, model).toBe('chat.completion');
      expect(json.choices[0], model).toMatchObject({ index: 0, message: { role: 'assistant', content: 'tok tok tok tok tok' }, finish_reason: 'stop' });
      expect(json.usage, model).toMatchObject({ completion_tokens: 5, total_tokens: json.usage.prompt_tokens + 5 });

      const streamed = await post(urls.viaMock, { model, stream: true, stream_options: { include_usage: true } });
      expect(streamed.headers.get('content-type'), model).toBe('text/event-stream');
      const events = sseEvents(await streamed.text());
      expect(events.at(-1), model).toBe('[DONE]');
      const chunks = events.slice(0, -1);
      expect(chunks.every((c: any) => c.object === 'chat.completion.chunk'), model).toBe(true);
      expect(chunks.filter((c: any) => c.choices[0]?.delta?.content === 'tok ' || (model !== 'mock-openai-1' && c.choices[0]?.delta?.content)).length, model).toBe(5);
      expect(chunks.at(-1).usage.completion_tokens, model).toBe(5);
    }
  });

  it('usage from each format reaches reconcile', async () => {
    // 'hi' is 1 prompt token and every mock answer 5 completion tokens: 1 + 5*3 = 16 micro-USD, where the
    // up-front hold was 1 + 20*3 = 61. Streamed or not, every format settles to the real figure.
    for (const [model] of formats) {
      for (const stream of [false, true]) {
        const s = await fresh();
        const res = await post(urls.viaMock, { model, stream }, s.key);
        expect(res.status).toBe(200);
        await res.text();
        expect(await settledTo(s.tenantId, 16), `${model} stream=${stream}`).toEqual({ spent: 16, reserved: 0 });
      }
    }
  });

  it('the request goes to the path each provider uses, and the model name is forwarded as given', async () => {
    seen.length = 0;
    const s = await fresh();
    await (await post(urls.viaStub, { model: 'mock-anthropic-x' }, s.key)).text();
    await (await post(urls.viaStub, { model: 'mock-gemini-x', stream: true }, s.key)).text();
    await (await post(urls.viaStub, { model: 'mock-openai-x' }, s.key)).text();
    expect(seen.map((r) => r.url)).toEqual([
      '/v1/messages',
      '/v1beta/models/mock-gemini-x:streamGenerateContent?alt=sse',
      '/v1/chat/completions',
    ]);
    expect(seen[0]!.body.model).toBe('mock-anthropic-x');
  });

  it('base URL with a path prefix is joined, not discarded', async () => {
    seen.length = 0;
    const s = await fresh();
    expect((await post(urls.viaStub, { model: 'gpt-5-nano' }, s.key)).status).toBe(200);
    expect((await post(urls.viaStub, { model: 'claude-haiku-5-5' }, s.key)).status).toBe(200);
    expect((await post(urls.viaStub, { model: 'gemini-3.1-flash-lite' }, s.key)).status).toBe(200);
    expect(seen.map((r) => r.url)).toEqual([
      '/api/v1/chat/completions',
      '/anthropic/v1/messages',
      '/v1beta/models/gemini-3.1-flash-lite:generateContent',
    ]);
  });

  it('each provider gets only its own key', async () => {
    seen.length = 0;
    const s = await fresh();
    for (const model of ['gpt-5-nano', 'claude-haiku-5-5', 'gemini-3.1-flash-lite']) {
      expect((await post(urls.viaStub, { model }, s.key)).status, model).toBe(200);
    }
    expect(seen).toHaveLength(3);
    const [openai, anthropic, gemini] = seen.map((r) => r.headers);
    expect(openai!.authorization).toBe(`Bearer ${KEYS.OPENAI_API_KEY}`);
    expect(anthropic!['x-api-key']).toBe(KEYS.ANTHROPIC_API_KEY);
    expect(gemini!['x-goog-api-key']).toBe(KEYS.GEMINI_API_KEY);
    // Each request's headers, whole: no other provider's key, and never the client's own gateway key.
    const own = [KEYS.OPENAI_API_KEY, KEYS.ANTHROPIC_API_KEY, KEYS.GEMINI_API_KEY];
    for (const [i, headers] of [openai!, anthropic!, gemini!].entries()) {
      const all = JSON.stringify(headers);
      expect(all, `request ${i}`).not.toContain(s.key);
      own.forEach((k, j) => expect(all.includes(k), `request ${i} has key ${j}`).toBe(i === j));
    }
    expect(anthropic!.authorization).toBeUndefined();
    expect(gemini!.authorization).toBeUndefined();
  });

  it('a provider with no key returns 503 provider_not_configured and nothing is sent or charged', async () => {
    seen.length = 0;
    const s = await fresh();
    for (const model of ['claude-haiku-5-5', 'gemini-3.1-flash-lite']) {
      const res = await post(urls.noKeys, { model }, s.key);
      expect(res.status, model).toBe(503);
      expect(((await res.json()) as any).error).toMatchObject({ code: 'provider_not_configured', type: 'gateway_error' });
    }
    expect(seen).toHaveLength(0);
    expect(await settledTo(s.tenantId, 0)).toEqual({ spent: 0, reserved: 0 });
  });

  it('a model name that is not header-safe gets the normal 400 and no x-gateway-model header', async () => {
    const s = await fresh();
    const names = ['gpt\u0001x', 'mod\u00e8le-\u6a21\u578b', 'a'.repeat(70_000), 'x'.repeat(129)];
    for (const model of names) {
      for (const url of [urls.unmetered, urls.viaMock]) {
        const res = await post(url, { model }, s.key);
        expect(res.status, `${model.length} chars`).toBe(400);
        expect(((await res.json()) as any).error.code).toBe('model_not_found');
        expect(res.headers.get('x-gateway-model')).toBeNull();
      }
    }
    // Control: a plain name is still echoed.
    const plain = await post(urls.unmetered, { model: 'llama-3-70b' }, s.key);
    expect(plain.headers.get('x-gateway-model')).toBe('llama-3-70b');
  });

  it('unknown model returns 400 model_not_found; unsupported parameters 400 unsupported_parameter; both give the hold back', async () => {
    seen.length = 0;
    const s = await fresh();
    // With budgets off nothing prices the name first, so the router answers.
    const notFound = await post(urls.unmetered, { model: 'llama-3-70b' }, s.key);
    expect(notFound.status).toBe(400);
    expect(((await notFound.json()) as any).error).toMatchObject({ type: 'invalid_request_error', code: 'model_not_found', param: 'model' });
    // Also with budgets on: a name no route serves is the router's to refuse, not the budget's.
    const unrouted = await post(urls.viaMock, { model: 'llama-3-70b' }, s.key);
    expect(unrouted.status).toBe(400);
    expect(((await unrouted.json()) as any).error).toMatchObject({ type: 'invalid_request_error', code: 'model_not_found', param: 'model' });
    // A name that is routed but has no price is still refused for the price.
    const unpriced = await post(urls.viaMock, { model: 'gpt-unpriced-9' }, s.key);
    expect(((await unpriced.json()) as any).error.code).toBe('model_not_priced');
    expect(await settledTo(s.tenantId, 0)).toEqual({ spent: 0, reserved: 0 });

    seen.length = 0;
    for (const [model, extra, param] of [
      ['claude-haiku-5-5', { tools: [{ type: 'function', function: { name: 'f' } }] }, 'tools'],
      ['gemini-3.1-flash-lite', { n: 2 }, 'n'],
      ['mock-anthropic-1', { logprobs: true }, 'logprobs'],
      ['mock-gemini-1', { response_format: { type: 'json_object' } }, 'response_format'],
    ] as const) {
      const r = await post(urls.viaStub, { model, ...extra }, s.key);
      expect(r.status, model).toBe(400);
      expect(((await r.json()) as any).error, model).toMatchObject({ type: 'invalid_request_error', code: 'unsupported_parameter', param });
    }
    expect(seen).toHaveLength(0);
    // OpenAI requests are passed through untouched, tools and all.
    const passthrough = await post(urls.viaStub, { model: 'gpt-5-nano', tools: [{ type: 'function', function: { name: 'f' } }] }, s.key);
    expect(passthrough.status).toBe(200);
    expect(seen[0]!.body.tools).toHaveLength(1);
  });
});

describe('translated streams and errors', { timeout: 60_000 }, () => {
  it('translated stream is unbuffered (first chunk before the provider finishes)', async () => {
    gate = new Promise<void>((r) => (release = r));
    const res = await post(urls.viaStub, { model: 'mock-anthropic-gate', stream: true });
    expect(res.status).toBe(200);
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    let text = '';
    // The stub holds the rest of its answer until released: content must arrive while it is held.
    const end = Date.now() + 5000;
    while (!text.includes('"content":"first"') && Date.now() < end) {
      const { value, done } = await reader.read();
      if (done) break;
      text += dec.decode(value, { stream: true });
    }
    expect(text).toContain('"content":"first"');
    expect(text).not.toContain('[DONE]');
    release();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      text += dec.decode(value, { stream: true });
    }
    expect(text.trimEnd().endsWith('data: [DONE]')).toBe(true);
  });

  it('a prompt in Arabic and emoji comes back intact through Anthropic and Gemini formats, streamed in small pieces', async () => {
    const prompt = 'مرحبا بالعالم 👋🏽 你好';
    for (const model of ['mock-anthropic-echo', 'mock-gemini-echo']) {
      const plain = (await (await post(urls.viaStub, { model, messages: [{ role: 'user', content: prompt }] })).json()) as any;
      expect(plain.choices[0].message.content, model).toBe(prompt);
      const res = await post(urls.viaStub, { model, stream: true, messages: [{ role: 'user', content: prompt }] });
      const events = sseEvents(await res.text());
      const text = events.filter((e: any) => e !== '[DONE]').map((e: any) => e.choices?.[0]?.delta?.content ?? '').join('');
      expect(text, model).toBe(prompt);
      expect(events.at(-1)).toBe('[DONE]');
    }
  });

  it('provider 429 keeps 429 with retry-after, 529 becomes 503, bodies are OpenAI-shaped and the hold is given back', async () => {
    const s = await fresh();
    const limited = await post(urls.viaStub, { model: 'mock-anthropic-429' }, s.key);
    expect(limited.status).toBe(429);
    expect(limited.headers.get('retry-after')).toBe('7');
    expect(((await limited.json()) as any).error).toEqual({ message: 'slow down', type: 'rate_limit_error', code: 'rate_limit_error' });
    const overloaded = await post(urls.viaStub, { model: 'mock-anthropic-529', stream: true }, s.key);
    expect(overloaded.status).toBe(503);
    expect(overloaded.headers.get('content-type')).toContain('application/json');
    expect(((await overloaded.json()) as any).error).toMatchObject({ type: 'server_error', code: 'overloaded_error' });
    // Nothing was generated, so nothing is charged and nothing stays held (once, not twice).
    expect(await settledTo(s.tenantId, 0)).toEqual({ spent: 0, reserved: 0 });
  });

  it('a provider rejecting the gateway key is a generic 502 provider_auth_failed in every format; the real reply is only logged', async () => {
    const s = await fresh();
    logLines.length = 0;
    for (const [model, provider] of [
      ['mock-openai-401', 'mock-openai'],
      ['mock-anthropic-401', 'mock-anthropic'],
      ['mock-gemini-401', 'mock-gemini'],
    ] as const) {
      for (const stream of [false, true]) {
        const res = await post(urls.logged, { model, stream }, s.key);
        const text = await res.text();
        expect(res.status, `${model} stream=${stream}`).toBe(502);
        expect(JSON.parse(text).error, model).toEqual({
          message: `the gateway's credentials for ${provider} were rejected`,
          type: 'gateway_error',
          code: 'provider_auth_failed',
        });
        expect(text).not.toContain('sk-live');
        // The provider's correlation and rate-limit headers still reach the caller; its cookies do not.
        expect(res.headers.get('request-id'), model).toBe('req_auth_1');
        expect(res.headers.get('anthropic-ratelimit-requests-remaining'), model).toBe('7');
        expect(res.headers.has('set-cookie'), model).toBe(false);
      }
    }
    // The status and the provider's error code are in the server log; its words (which can echo the key) are nowhere.
    const entries = logLines.map((l) => JSON.parse(l)).filter((e) => e.msg === 'provider rejected the gateway credentials');
    expect(entries.map((e) => [e.provider, e.upstreamStatus])).toEqual([
      ['mock-openai', 401], ['mock-openai', 401],
      ['mock-anthropic', 401], ['mock-anthropic', 401],
      ['mock-gemini', 401], ['mock-gemini', 401],
    ]);
    expect(entries.every((e) => e.providerCode === 'invalid_api_key')).toBe(true);
    expect(logLines.join('\n')).not.toContain('sk-live');
    // The provider did no work: nothing is charged and nothing stays held.
    expect(await settledTo(s.tenantId, 0)).toEqual({ spent: 0, reserved: 0 });
  });

  it('a 403 is not read as a bad gateway key: the provider reply goes through', async () => {
    const s = await fresh();
    logLines.length = 0;
    for (const [model, stream] of [['mock-openai-403', false], ['mock-openai-403', true], ['mock-anthropic-403', false], ['mock-gemini-403', false]] as const) {
      const res = await post(urls.logged, { model, stream }, s.key);
      const body = (await res.json()) as any;
      expect(res.status, model).toBe(403);
      expect(body.error.code, model).not.toBe('provider_auth_failed');
      expect(body.error.type, model).not.toBe('gateway_error');
    }
    expect(logLines.map((l) => JSON.parse(l)).filter((e) => e.msg === 'provider rejected the gateway credentials')).toEqual([]);
  });

  it('Gemini is sent the same output cap the budget hold was sized on when the client names none', async () => {
    seen.length = 0;
    const s = await fresh();
    const body = { messages: [{ role: 'user', content: 'hi' }] };
    const res = await fetch(`${urls.viaStub}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${s.key}` },
      body: JSON.stringify({ model: 'gemini-3.1-flash-lite', ...body }),
    });
    expect(res.status).toBe(200);
    expect(seen).toHaveLength(1);
    const sent = seen[0]!.body.generationConfig.maxOutputTokens;
    expect(sent).toBe(estimateWorstCase({ model: 'gemini-3.1-flash-lite', ...body }, base.rateLimitDefaultMaxTokens).output);
    expect(sent).toBe(base.rateLimitDefaultMaxTokens);
  });

  it('default cap per model is sent and equals the hold\'s output estimate', async () => {
    const body = { messages: [{ role: 'user', content: 'hi' }] };
    const sentCap = (b: any) => b.max_tokens ?? b.generationConfig?.maxOutputTokens;
    for (const model of ['claude-fable-5-1', 'claude-haiku-5-5', 'gemini-3.1-pro-preview']) {
      seen.length = 0;
      const s = await fresh();
      const res = await fetch(`${urls.viaStub}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${s.key}` },
        body: JSON.stringify({ model, ...body }),
      });
      expect(res.status, model).toBe(200);
      expect(seen, model).toHaveLength(1);
      const sent = sentCap(seen[0]!.body);
      const { prompt, output } = estimateWorstCase({ model, ...body }, defaultMaxTokensFor(model, base.rateLimitDefaultMaxTokens));
      expect(sent, model).toBe(output);
      expect(sent, model).toBe(4096);
      // The hold is the price of exactly that cap: the balance header shows the cap less the hold.
      const hold = costMicros(priceFor(model)!, prompt, sent);
      expect(res.headers.get('x-budget-remaining-usd'), model).toBe(formatUsd(base.budgetDefaultMonthlyMicros - hold));
    }
    // Control: a model with no per-model default keeps the gateway-wide one.
    seen.length = 0;
    const s = await fresh();
    await fetch(`${urls.viaStub}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${s.key}` },
      body: JSON.stringify({ model: 'gemini-3.1-flash-lite', ...body }),
    });
    expect(sentCap(seen[0]!.body)).toBe(base.rateLimitDefaultMaxTokens);
  });
});
