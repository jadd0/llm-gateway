import http, { type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { FastifyInstance } from 'fastify';
import { eq, sql } from 'drizzle-orm';
import { Redis } from 'ioredis';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../app.ts';
import { createDb, type Db } from '../db/client.ts';
import { tenants } from '../db/schema.ts';
import { cleanup, seedKey, testConfig } from '../test-env.ts';
import { periodOf } from './period.ts';

// The upstream picks its behaviour from the model name (every mock-* model is priced):
//   mock-ok       answers with usage: 1 prompt + 10 completion tokens (31 micro-USD)
//   mock-nousage  answers 2xx with no usage at all
//   mock-500      answers 500
//   mock-hang     starts a stream and never finishes it
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
      if (body.model === 'mock-500') {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end('{"error":{"message":"boom"}}');
        return;
      }
      if (body.model === 'mock-gated') {
        held++;
        await gate.wait;
      }
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
      OPENAI_BASE_URL: `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`,
      BUDGET_ENABLED: 'true',
      BUDGET_REDIS_TIMEOUT_MS: '5000',
      BUDGET_EPOCH_REFRESH_S: '3600',
      RATE_LIMIT_REDIS_TIMEOUT_MS: '5000',
    }),
    { rateLimitClock: () => T0 },
  );
  await app.listen({ port: 0, host: '127.0.0.1' });
});

afterEach(() => {
  gate.open();
  gate = newGate();
  held = 0;
});

afterAll(async () => {
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
const balanceKey = async (tenantId: string) =>
  (await redis.keys(`${prefix}bud:{${tenantId}}:${period}:*`)).find((k) => /:\d+$/.test(k));
const balance = async (tenantId: string) => {
  const k = await balanceKey(tenantId);
  if (!k) return null;
  const h = await redis.hgetall(k);
  return { spent: Number(h.spent), reserved: Number(h.reserved) };
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

  it('unknown model returns 400 model_not_priced', async () => {
    const s = await fresh(1_000_000);
    const before = hits;
    const res = await chat(s.key, 'gpt-not-priced');
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatchObject({ type: 'invalid_request_error', code: 'model_not_priced' });
    expect(hits).toBe(before);
    expect(await balanceKey(s.tenantId)).toBeUndefined(); // nothing was reserved
    expect(await redis.exists(`${prefix}rl:{${s.keyId}}:req`)).toBe(1); // the request itself was counted...
    expect(await tokensLeft(s.keyId)).toBe(TPM); // ...but its tokens went back
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
    expect(await tokensLeft(s.keyId)).toBe(TPM);
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
});
