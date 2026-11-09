import { once } from 'node:events';
import http, { type Server } from 'node:http';
import type { Socket } from 'node:net';
import type { AddressInfo } from 'node:net';
import type { FastifyInstance } from 'fastify';
import { eq, sql } from 'drizzle-orm';
import { Redis } from 'ioredis';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../app.ts';
import { createDb, type Db } from '../db/client.ts';
import { tenants } from '../db/schema.ts';
import { cleanup, seedKey, testConfig } from '../test-env.ts';
import { periodOf } from './period.ts';
import { standInWorker } from '../../test/drain.ts';
import type { CacheHit } from '../cache/plugin.ts';
import { createPgLedger } from './pg-ledger.ts';

// The upstream picks its behaviour from the model name (every mock-* model is priced):
//   mock-ok       answers with usage: 1 prompt + 10 completion tokens (31 micro-USD)
//   mock-nousage  answers 2xx with no usage at all
//   mock-500      answers 500
//   mock-hang     starts a stream and never finishes it (non-streamed: never answers)
//   mock-gated    waits for the test to open the gate before answering
// 'hi' is 1 prompt token. With max_tokens 20 the worst case is 1 in + 20 out = 61 micro-USD.
const WORST = 61;
const ACTUAL = 31;

const base = testConfig({ BUDGET_ENABLED: 'true' });
const prefix = base.redisKeyPrefix;
const T0 = 1_700_000_000_000;
let upstream: Server;
let app: FastifyInstance;
let handle: Db;
let redis: Redis;
const serverSockets: Socket[] = [];
let floodClosed: () => void = () => {};
let hits = 0;
let held = 0;
let gate: { open: () => void; wait: Promise<void> } = newGate();
const tenantIds: string[] = [];

function newGate() {
  let open!: () => void;
  const wait = new Promise<void>((r) => (open = r));
  return { open, wait };
}

beforeAll(async () => {
  upstream = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', async () => {
      hits++;
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { model: string; stream?: boolean };
      if (body.model === 'mock-flood') {
        // Writes without end for as long as the reader takes it; stops when the gateway closes the connection.
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.on('close', () => floodClosed());
        const chunk = `data: ${'x'.repeat(60_000)}\n\n`;
        while (!res.destroyed) {
          if (!res.write(chunk)) await new Promise<void>((r) => res.once('drain', r).once('close', r));
        }
        return;
      }
      if (body.model === 'mock-json-hang' || body.model === 'mock-500-hang') {
        // A stream request answered with something that is not an event stream, then silence.
        res.writeHead(body.model === 'mock-500-hang' ? 500 : 200, { 'content-type': body.model === 'mock-500-hang' ? 'text/plain' : 'application/json' });
        res.write('partial-body');
        return;
      }
      if (body.model === 'mock-500') {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end('{"error":{"message":"boom"}}');
        return;
      }
      if (body.model === 'mock-gated') {
        held++;
        await gate.wait;
      }
      if (body.model === 'mock-hang' && !body.stream) return; // never answers
      const usage = body.model === 'mock-nousage' ? undefined : { prompt_tokens: 1, completion_tokens: 10, total_tokens: 11 };
      if (body.stream) {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'x' } }] })}\n\n`);
        if (body.model === 'mock-hang') return; // never ends
        if (usage) res.write(`data: ${JSON.stringify({ choices: [], usage })}\n\n`);
        res.end('data: [DONE]\n\n');
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: 'x', choices: [], ...(usage ? { usage } : {}) }));
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
      BUDGET_ENABLED: 'true',
      OPENAI_API_KEY: 'sk-test',
      BUDGET_REDIS_TIMEOUT_MS: '5000',
      BUDGET_EPOCH_REFRESH_MS: '3600000',
      RATE_LIMIT_REDIS_TIMEOUT_MS: '5000',
    }),
    { rateLimitClock: () => T0 },
  );
  await app.listen({ port: 0, host: '127.0.0.1' });
  stopWorker = standInWorker(handle.db, redis, prefix);
  app.server.on('connection', (sk: Socket) => serverSockets.push(sk));
});

// Stands in for the log worker: applies what the gateway queued to Postgres a few times a second.
let stopWorker: () => void = () => {};

afterEach(() => {
  gate.open();
  gate = newGate();
  held = 0;
});

afterAll(async () => {
  stopWorker();
  upstream.closeAllConnections();
  await app.close();
  await new Promise((resolve) => upstream.close(resolve));
  await cleanup(handle.db, redis, tenantIds, prefix);
  redis.disconnect();
  await handle.close();
});

// A small tokens-per-minute makes a bucket take a long real time to expire back to full, so the
// limiter's state can be read after a request without racing the expiry.
const TPM = 60;
const fresh = async (capMicros: number | null, tpm = TPM) => {
  const s = await seedKey(handle.db, base, { rpm: 1000, tpm });
  tenantIds.push(s.tenantId);
  if (capMicros !== null) await handle.db.update(tenants).set({ monthlyBudgetMicros: capMicros }).where(eq(tenants.id, s.tenantId));
  return s;
};
const chat = (key: string, model = 'mock-ok', extra: object = {}) =>
  app.inject({
    method: 'POST',
    url: '/v1/chat/completions',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    payload: JSON.stringify({ model, messages: [{ role: 'user', content: 'hi' }], max_tokens: 20, ...extra }),
  });

const period = periodOf(Date.now());
// Any Redis balance key of the tenant (none means nothing was ever reserved for it).
const balanceKey = async (tenantId: string) => (await redis.keys(`${prefix}bud:{${tenantId}}:${period}:*`))[0];
// What the tenant has spent and holds, from Postgres: the record. Another test file can move the shared
// epoch while this one runs, which sends the gateway to a new Redis key, so the record is what is read.
const balance = async (tenantId: string) => {
  const spent = await handle.db.execute(sql`select coalesce(sum(spent_micros), 0) as s from tenant_spend where tenant_id = ${tenantId}`);
  const held = await handle.db.execute(sql`select coalesce(sum(amount_micros), 0) as s from budget_reservations where tenant_id = ${tenantId}`);
  return { spent: Number(spent.rows[0]!.s), reserved: Number(held.rows[0]!.s) };
};
// A full bucket has no key (it expires the moment it is full).
const tokensLeft = async (keyId: string) => {
  const v = await redis.hget(`${prefix}rl:{${keyId}}:tok`, 'tokens');
  return v === null ? TPM : Number(v);
};
const ledgerRows = async (tenantId: string) =>
  (await handle.db.execute(sql`select cost_micros, estimated, prompt_tokens, completion_tokens from spend_ledger where tenant_id = ${tenantId} order by created_at`))
    .rows.map((r) => ({ cost: Number(r.cost_micros), estimated: r.estimated as boolean, prompt: Number(r.prompt_tokens), completion: Number(r.completion_tokens) }));

// Settles run after the response, so a test waits for the state it expects instead of assuming a time.
async function until<T>(read: () => Promise<T>, done: (v: T) => boolean): Promise<T> {
  const end = Date.now() + 20_000;
  let v = await read();
  while (!done(v) && Date.now() < end) {
    await new Promise((r) => setTimeout(r, 10));
    v = await read();
  }
  expect(done(v)).toBe(true);
  return v;
}
const settledAt = (tenantId: string, spent: number) =>
  until(() => balance(tenantId), (b) => b !== null && b.spent === spent && b.reserved === 0);

describe('budget plugin', { timeout: 60_000 }, () => {
  it('exhausted budget returns 402 with the insufficient_quota body and does not call upstream', async () => {
    const s = await fresh(100);
    expect((await chat(s.key, 'mock-nousage')).statusCode).toBe(200); // keeps its estimate: 61 spent
    await settledAt(s.tenantId, WORST);
    const tokensBefore = await tokensLeft(s.keyId);
    const before = hits;
    const res = await chat(s.key);
    expect(res.statusCode).toBe(402);
    expect(res.json()).toEqual({
      error: {
        message: expect.stringContaining('budget exhausted'),
        type: 'insufficient_quota',
        code: 'budget_exhausted',
      },
    });
    expect(res.headers['x-budget-remaining-usd']).toBe('0.000039'); // 100 - 61
    expect(hits).toBe(before);
    // The refused request held nothing and gave back the tokens the rate limiter had taken for it.
    expect(await balance(s.tenantId)).toEqual({ spent: WORST, reserved: 0 });
    expect(await tokensLeft(s.keyId)).toBe(tokensBefore);
  });

  it('an uncapped OpenAI-format request holds the model\'s documented maximum output; a capped one is unchanged', async () => {
    // gpt-6-astra: $10 in / $50 out per million, 128,000 max output tokens. 'hi' is 1 prompt token.
    const uncapped = { model: 'gpt-6-astra', messages: [{ role: 'user', content: 'hi' }] };
    const post = (key: string, payload: object) =>
      app.inject({ method: 'POST', url: '/v1/chat/completions', headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` }, payload: JSON.stringify(payload) });

    const rich = await fresh(10_000_000); // $10.00
    const res = await post(rich.key, uncapped);
    expect(res.statusCode).toBe(200);
    expect(res.headers['x-budget-remaining-usd']).toBe('3.599990'); // 10,000,000 - (10 + 128,000 * 50)

    const capped = await fresh(10_000_000);
    const res2 = await post(capped.key, { ...uncapped, max_completion_tokens: 20 });
    expect(res2.headers['x-budget-remaining-usd']).toBe('9.998990'); // 10,000,000 - (10 + 20 * 50)

    const poor = await fresh(6_000_000, 100_000); // $6.00 cannot cover the $6.40 hold
    const before = hits;
    const refused = await post(poor.key, uncapped);
    expect(refused.statusCode).toBe(402);
    expect(refused.json().error.message).toContain('max_tokens');
    expect(hits).toBe(before);
    // The same tenant is served once it names a limit that fits.
    expect((await post(poor.key, { ...uncapped, max_tokens: 100 })).statusCode).toBe(200);
  });

  it('unknown model returns 400 model_not_priced', async () => {
    const s = await fresh(1_000_000);
    const before = hits;
    const res = await chat(s.key, 'gpt-not-priced');
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatchObject({ type: 'invalid_request_error', code: 'model_not_priced' });
    expect(hits).toBe(before);
    expect(await balanceKey(s.tenantId)).toBeUndefined(); // nothing was reserved
    expect(await redis.exists(`${prefix}rl:{${s.keyId}}:req`)).toBe(1); // the request itself was counted...
    await vi.waitFor(async () => expect(await tokensLeft(s.keyId)).toBe(TPM)); // ...but its tokens went back
  });

  it('a body the route rejects reserves nothing', async () => {
    const s = await fresh(1_000_000);
    for (const body of ['not json', '[1,2]', '{}', '{"model":1,"messages":[]}', '{"model":"mock-ok","messages":"x"}']) {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${s.key}` },
        payload: body,
      });
      expect(res.statusCode).toBe(400);
      expect(res.headers['x-budget-remaining-usd']).toBeUndefined();
    }
    expect(await balanceKey(s.tenantId)).toBeUndefined();
    expect(await ledgerRows(s.tenantId)).toEqual([]);
  });

  it('x-budget-remaining-usd reflects the reservation', async () => {
    const s = await fresh(1_000_000); // $1.00
    const res = await chat(s.key);
    expect(res.statusCode).toBe(200);
    expect(res.headers['x-budget-remaining-usd']).toBe('0.999939'); // 1,000,000 - 61
  });

  it('with no max_tokens the worst case is the default allowance, not what the key rate limit would clamp it to', async () => {
    // The key allows 60 tokens a minute, so the limiter trims its estimate to 60. The budget holds the
    // whole output a mock-* model may generate unlimited (MOCK_MAX_OUTPUT_TOKENS, 4096, at 3 micro-USD each)
    // plus 1 prompt token.
    const s = await fresh(1_000_000);
    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${s.key}` },
      payload: JSON.stringify({ model: 'mock-ok', messages: [{ role: 'user', content: 'hi' }] }),
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['x-ratelimit-remaining-tokens']).toBe('0');
    expect(res.headers['x-budget-remaining-usd']).toBe('0.987711'); // 1,000,000 - (1 + 4096 * 3)
  });

  it('503 budget_unavailable when the Postgres copy of a hold cannot be written, and nothing stays held', async () => {
    const failing = buildApp(
      testConfig({
        API_KEY_PEPPER: base.apiKeyPepper,
        REDIS_KEY_PREFIX: prefix,
        OPENAI_BASE_URL: `http://127.0.0.1:${(upstream.address() as AddressInfo).port}/v1`,
        BUDGET_ENABLED: 'true',
        BUDGET_REDIS_TIMEOUT_MS: '5000',
        BUDGET_EPOCH_REFRESH_MS: '3600000',
        RATE_LIMIT_REDIS_TIMEOUT_MS: '5000',
      }),
      {
        rateLimitClock: () => T0,
        budgetPgLedger: { ...createPgLedger(handle.db), hold: () => Promise.reject(new Error('connection reset')) },
      },
    );
    try {
      const s = await fresh(1_000_000);
      const before = hits;
      const res = await failing.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${s.key}` },
        payload: JSON.stringify({ model: 'mock-ok', messages: [{ role: 'user', content: 'hi' }], max_tokens: 20 }),
      });
      expect(res.statusCode).toBe(503);
      expect(res.json().error).toMatchObject({ type: 'gateway_error', code: 'budget_unavailable' });
      expect(hits).toBe(before);
      // the limiter's tokens go back by a fire-and-forget correction: wait for it rather than race it
      await vi.waitFor(async () => expect(await tokensLeft(s.keyId)).toBe(TPM));
      await failing.close(); // waits for the Redis hold to be released
      expect(await balance(s.tenantId)).toEqual({ spent: 0, reserved: 0 });
    } finally {
      await failing.close();
    }
  });

  it('a tenant with no cap of its own gets the gateway default', async () => {
    const s = await fresh(null);
    const res = await chat(s.key);
    expect(res.headers['x-budget-remaining-usd']).toBe('9.999939'); // BUDGET_DEFAULT_MONTHLY_USD=10, less 61 micro-USD
  });

  it('used usage is charged at actual cost and recorded as not estimated', async () => {
    const s = await fresh(1_000_000);
    expect((await chat(s.key)).statusCode).toBe(200);
    await settledAt(s.tenantId, ACTUAL);
    expect(await ledgerRows(s.tenantId)).toEqual([{ cost: ACTUAL, estimated: false, prompt: 1, completion: 10 }]);
    // The limiter reconciled to the same actual: the provider reported 11 tokens in total.
    expect(await tokensLeft(s.keyId)).toBe(TPM - 11);
  });

  it('a streamed answer is charged from its usage chunk, which the client never sees', async () => {
    const s = await fresh(1_000_000);
    const res = await chat(s.key, 'mock-ok', { stream: true });
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain('"usage"');
    await settledAt(s.tenantId, ACTUAL);
    expect(await ledgerRows(s.tenantId)).toEqual([{ cost: ACTUAL, estimated: false, prompt: 1, completion: 10 }]);
  });

  it('upstream non-2xx refunds the whole hold, like the rate limiter', async () => {
    const s = await fresh(1_000_000);
    const res = await chat(s.key, 'mock-500');
    expect(res.statusCode).toBe(500);
    await settledAt(s.tenantId, 0);
    expect(await ledgerRows(s.tenantId)).toEqual([]);
    await vi.waitFor(async () => expect(await tokensLeft(s.keyId)).toBe(TPM));
  });

  it('a 2xx with no usage keeps the estimate, like the rate limiter', async () => {
    const s = await fresh(1_000_000);
    expect((await chat(s.key, 'mock-nousage')).statusCode).toBe(200);
    await settledAt(s.tenantId, WORST);
    expect(await ledgerRows(s.tenantId)).toEqual([{ cost: WORST, estimated: true, prompt: 1, completion: 20 }]);
    expect(await tokensLeft(s.keyId)).toBe(TPM - 21); // 1 prompt + 20 max_tokens stay charged
  });

  it('aborted stream is charged its full reservation and marked estimated', async () => {
    const s = await fresh(1_000_000);
    const { port } = app.server.address() as AddressInfo;
    await new Promise<void>((resolve, reject) => {
      const req = http.request(
        { port, host: '127.0.0.1', method: 'POST', path: '/v1/chat/completions', headers: { 'content-type': 'application/json', authorization: `Bearer ${s.key}` } },
        (res) => {
          res.once('data', () => {
            req.destroy(); // the client leaves after the first bytes
            resolve();
          });
        },
      );
      req.on('error', () => {}); // the destroy is the point
      req.on('close', () => resolve());
      req.setTimeout(20_000, () => reject(new Error('no response')));
      req.end(JSON.stringify({ model: 'mock-hang', stream: true, messages: [{ role: 'user', content: 'hi' }], max_tokens: 20 }));
    });
    await settledAt(s.tenantId, WORST);
    expect(await ledgerRows(s.tenantId)).toEqual([{ cost: WORST, estimated: true, prompt: 1, completion: 20 }]);
  });

  it('concurrent requests against a small cap: exactly the requests that fit are admitted and settled spend never exceeds the cap', async () => {
    // Worst case 61 each; a cap of 190 fits three (183), the fourth would reach 244.
    const cap = 190;
    const s = await fresh(cap, 100_000);
    let refused = 0;
    const all = Array.from({ length: 30 }, () =>
      chat(s.key, 'mock-gated').then((r) => {
        if (r.statusCode === 402) refused++;
        return r;
      }),
    );
    // The admitted ones are parked at the upstream, still holding their money, while every other
    // request is decided against them.
    await until(async () => [held, refused], ([h, r]) => h === 3 && r === 27);
    gate.open();
    const results = await Promise.all(all);
    expect(results.filter((r) => r.statusCode === 200)).toHaveLength(3);
    expect(results.filter((r) => r.statusCode === 402)).toHaveLength(27);
    const b = await settledAt(s.tenantId, 3 * ACTUAL);
    expect(b!.spent).toBeLessThanOrEqual(cap);
    expect((await ledgerRows(s.tenantId)).reduce((sum, r) => sum + r.cost, 0)).toBe(3 * ACTUAL);
  });

  // A raw client that can leave at a chosen moment, and the gateway-side socket it was served on.
  const sendRaw = (target: FastifyInstance, key: string, body: object, onData?: (chunk: Buffer) => void) => {
    const { port } = target.server.address() as AddressInfo;
    const chunks: Buffer[] = [];
    const req = http.request(
      { port, host: '127.0.0.1', method: 'POST', path: '/v1/chat/completions', headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` } },
      (res) => {
        res.on('data', (c: Buffer) => {
          chunks.push(c);
          onData?.(c);
        });
        res.on('error', () => {});
      },
    );
    req.on('error', () => {});
    const ended = new Promise<void>((resolve) => req.on('close', () => resolve()));
    req.end(JSON.stringify(body));
    return { req, ended, text: () => Buffer.concat(chunks).toString('utf8') };
  };
  const body = (model: string, extra: object = {}) => ({ model, messages: [{ role: 'user', content: 'hi' }], max_tokens: 20, ...extra });
  const newestServerSocket = async (target: FastifyInstance, sockets: Socket[]) => {
    const end = Date.now() + 10_000;
    while (sockets.length === 0 && Date.now() < end) await new Promise((r) => setTimeout(r, 5));
    void target;
    return sockets.at(-1)!;
  };

  const capped = (extraConfig: Record<string, string>, extra: object = {}) =>
    buildApp(
      testConfig({
        API_KEY_PEPPER: base.apiKeyPepper,
        REDIS_KEY_PREFIX: prefix,
        OPENAI_BASE_URL: `http://127.0.0.1:${(upstream.address() as AddressInfo).port}/v1`,
        BUDGET_ENABLED: 'true',
        BUDGET_REDIS_TIMEOUT_MS: '5000',
        BUDGET_EPOCH_REFRESH_MS: '3600000',
        RATE_LIMIT_REDIS_TIMEOUT_MS: '5000',
        ...extraConfig,
      }),
      { rateLimitClock: () => T0, ...extra },
    );

  it('a streamed call past the maximum duration is cut with an error event and its hold is settled at the estimate', async () => {
    const short = capped({ UPSTREAM_MAX_DURATION_MS: '300' });
    await short.listen({ port: 0, host: '127.0.0.1' });
    try {
      const s = await fresh(1_000_000);
      const r = sendRaw(short, s.key, body('mock-hang', { stream: true }));
      await r.ended; // the gateway ended the stream itself: nothing here ever closes it
      expect(r.text()).toContain('data: {"choices":[{"delta":{"content":"x"}}]}');
      expect(r.text()).toContain('"code":"upstream_max_duration"');
      expect(r.text()).toContain('"type":"gateway_error"');
      await settledAt(s.tenantId, WORST); // settled long before the hold's own expiry (300 s)
      expect(await ledgerRows(s.tenantId)).toEqual([{ cost: WORST, estimated: true, prompt: 1, completion: 20 }]);
    } finally {
      await short.close();
    }
  });

  it('a non-streamed call past the maximum duration answers 504 and keeps the estimate', async () => {
    const short = capped({ UPSTREAM_MAX_DURATION_MS: '300' });
    await short.ready();
    try {
      const s = await fresh(1_000_000);
      const res = await short.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${s.key}` },
        payload: JSON.stringify(body('mock-hang')),
      });
      expect(res.statusCode).toBe(504);
      expect(res.json().error).toMatchObject({ type: 'gateway_error', code: 'upstream_max_duration' });
      await settledAt(s.tenantId, WORST);
      expect(await ledgerRows(s.tenantId)).toEqual([{ cost: WORST, estimated: true, prompt: 1, completion: 20 }]);
    } finally {
      await short.close();
    }
  });

  it('a cache hit on a model with no price leaves the log row to the token counts the cache plugin noted, and records its saving only when priced', async () => {
    const s = await fresh(1_000_000);
    const usage = { promptTokens: 9, completionTokens: 2, totalTokens: 11 };
    const hitOn = async (model: string) => {
      const noted: Array<Record<string, unknown>> = [];
      const request = { reqlog: { note: (n: Record<string, unknown>) => void noted.push(n) } } as unknown as NonNullable<CacheHit['request']>;
      await app.recordCacheHit!({ request, tenantId: s.tenantId, model, usage });
      return noted;
    };
    // Unpriced: nothing to say about tokens (the cache plugin already noted the real ones) and no saving.
    expect(await hitOn('unpriced-model')).toEqual([{ savedMicros: 0 }]);
    // Priced: the saving, and still no token counts of its own.
    const priced = await hitOn('mock-ok');
    expect(priced).toHaveLength(1);
    expect(Object.keys(priced[0]!)).toEqual(['savedMicros']);
    expect(priced[0]!.savedMicros).toBeGreaterThan(0);
  });

  it('a client that leaves before the request is dispatched upstream gets everything back', async () => {
    const real = createPgLedger(handle.db);
    let holdEntered!: () => void;
    const entered = new Promise<void>((r) => (holdEntered = r));
    let openHold!: () => void;
    const holdGate = new Promise<void>((r) => (openHold = r));
    let holdWritten!: () => void;
    const written = new Promise<void>((r) => (holdWritten = r));
    const sockets: Socket[] = [];
    const gated = capped({}, {
      budgetPgLedger: {
        ...real,
        hold: async (a: Parameters<typeof real.hold>[0]) => {
          holdEntered();
          await holdGate;
          await real.hold(a);
          holdWritten();
        },
      },
    });
    await gated.listen({ port: 0, host: '127.0.0.1' });
    gated.server.on('connection', (sk: Socket) => sockets.push(sk));
    try {
      const s = await fresh(1_000_000);
      const before = hits;
      const r = sendRaw(gated, s.key, body('mock-ok'));
      await entered; // the request is in the budget step, nothing has gone upstream
      const sk = await newestServerSocket(gated, sockets);
      r.req.destroy();
      if (!sk.destroyed) await once(sk, 'close');
      openHold();
      await written; // the hold exists now, so a balance of zero held means the refund has been applied to it
      await settledAt(s.tenantId, 0); // the route ran and ended the request: its refund reached Postgres and dropped the hold
      expect(hits).toBe(before);
      expect(await ledgerRows(s.tenantId)).toEqual([]);
      expect(await balance(s.tenantId)).toEqual({ spent: 0, reserved: 0 });
      await vi.waitFor(async () => expect(await tokensLeft(s.keyId)).toBe(TPM)); // the limiter's tokens are back too
    } finally {
      openHold();
      await gated.close();
    }
  });

  it('a client that leaves after the request was dispatched is charged the estimate', async () => {
    const s = await fresh(1_000_000);
    const before = serverSockets.length;
    const r = sendRaw(app, s.key, body('mock-gated'));
    await until(async () => held, (h) => h === 1); // the upstream has the request
    const sk = serverSockets[before]!;
    r.req.destroy();
    if (!sk.destroyed) await once(sk, 'close');
    gate.open();
    await settledAt(s.tenantId, WORST);
    expect(await ledgerRows(s.tenantId)).toEqual([{ cost: WORST, estimated: true, prompt: 1, completion: 20 }]);
    expect(await tokensLeft(s.keyId)).toBe(TPM - 21); // the limiter keeps its estimate as well
  });

  // A client that takes the headers and never reads, against a stream that never stops writing.
  const stuckReader = async (cutDrainMs: number) => {
    const closed = new Promise<void>((r) => (floodClosed = r));
    const short = capped({ UPSTREAM_MAX_DURATION_MS: '1000' }, { cutDrainMs });
    await short.listen({ port: 0, host: '127.0.0.1' });
    const sockets: Socket[] = [];
    short.server.on('connection', (sk: Socket) => sockets.push(sk));
    const s = await fresh(1_000_000);
    const { port } = short.server.address() as AddressInfo;
    const req = http.request(
      { port, host: '127.0.0.1', method: 'POST', path: '/v1/chat/completions', headers: { 'content-type': 'application/json', authorization: `Bearer ${s.key}` } },
      (res) => {
        res.pause();
        res.on('error', () => {});
      },
    );
    req.on('error', () => {});
    req.end(JSON.stringify(body('mock-flood', { stream: true })));
    return { short, sockets, s, closed, req };
  };

  it('at the deadline the upstream is aborted at once and the estimate settled, however slowly the client reads', async () => {
    // The client never reads and is not dropped for a minute: whatever happens at the deadline happens on its own.
    const { short, s, closed, req } = await stuckReader(60_000);
    try {
      await closed; // the gateway closed its connection to the upstream at the deadline
      await settledAt(s.tenantId, WORST); // and charged the estimate then, with the response still stuck
      expect(await ledgerRows(s.tenantId)).toEqual([{ cost: WORST, estimated: true, prompt: 1, completion: 20 }]);
    } finally {
      req.destroy();
      short.server.closeAllConnections();
      await short.close();
    }
  });

  it('a client that does not take what is left after the cut is dropped', async () => {
    const { short, sockets } = await stuckReader(300);
    try {
      await until(async () => sockets.length > 0 && sockets.every((sk) => sk.destroyed), (d) => d);
    } finally {
      await short.close();
    }
  });

  it('a stream that is not an event stream is ended at the deadline without an error event added', async () => {
    const short = capped({ UPSTREAM_MAX_DURATION_MS: '300' });
    await short.listen({ port: 0, host: '127.0.0.1' });
    try {
      const s = await fresh(1_000_000);
      const r = sendRaw(short, s.key, body('mock-json-hang', { stream: true }));
      await r.ended;
      expect(r.text()).not.toContain('upstream_max_duration'); // nothing appended
      expect(r.text()).not.toContain('data:');
      // (The usage tap holds an incomplete event back, so a 200 body shows nothing.)
    } finally {
      await short.close();
    }
  });

  it('an error answer whose body never ends is cut at the deadline with a 504, streamed or not', async () => {
    // An error answer is read in full before the client is told anything (it may be retried or rewritten), so a
    // body that hangs is the deadline's to end.
    const short = capped({ UPSTREAM_MAX_DURATION_MS: '300' });
    await short.listen({ port: 0, host: '127.0.0.1' });
    try {
      const s = await fresh(1_000_000);
      const r = sendRaw(short, s.key, body('mock-500-hang', { stream: true }));
      await r.ended;
      expect(r.text()).toContain('upstream_max_duration');
    } finally {
      await short.close();
    }
  });

  it('a reading client of a stream that is still flooding gets the cut event and a clean end', async () => {
    // Data from the upstream is still arriving when the deadline hits; none of it may be written after the
    // response side has been ended, or the client sees a reset instead of the event.
    const short = capped({ UPSTREAM_MAX_DURATION_MS: '500' });
    await short.listen({ port: 0, host: '127.0.0.1' });
    try {
      const s = await fresh(1_000_000);
      const { port } = short.server.address() as AddressInfo;
      let tail = '';
      let complete = false;
      let failed = false;
      await new Promise<void>((resolve) => {
        const req = http.request(
          { port, host: '127.0.0.1', method: 'POST', path: '/v1/chat/completions', headers: { 'content-type': 'application/json', authorization: `Bearer ${s.key}` } },
          (res) => {
            res.on('data', (c: Buffer) => (tail = (tail + c.toString('utf8')).slice(-400)));
            res.on('end', () => (complete = true));
            res.on('error', () => (failed = true));
            res.on('aborted', () => (failed = true));
          },
        );
        req.on('error', () => (failed = true));
        req.on('close', () => resolve());
        req.end(JSON.stringify(body('mock-flood', { stream: true })));
      });
      expect(failed).toBe(false);
      expect(complete).toBe(true);
      expect(tail).toContain('"code":"upstream_max_duration"');
    } finally {
      await short.close();
    }
  });
});
