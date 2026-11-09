import { type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { FastifyInstance } from 'fastify';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createMockServer, type Settings } from '../../../mock-provider/src/server.ts';
import { buildApp } from '../app.ts';
import { createDb, type Db } from '../db/client.ts';
import { cleanup, seedKey, testConfig } from '../test-env.ts';
import { keyStoreFromConfig } from './key-store.ts';
import { generateKey, hashKey } from './keys.ts';

const settings: Settings = { latencyMs: 0, tokenDelayMs: 0, completionTokens: 5, errorRate: 0, outage: 'off' };
let mock: Server;
let app: FastifyInstance;
let gw = '';
let handle: Db;
let redis: Redis;
const upstreamAuth: Array<string | undefined> = [];
const tenantIds: string[] = [];
let config: ReturnType<typeof testConfig>;

const listen = (server: Server) =>
  new Promise<number>((resolve) =>
    server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port)),
  );

const chat = (headers: Record<string, string>) =>
  fetch(`${gw}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify({ model: 'gpt-m', messages: [{ role: 'user', content: 'hi' }] }),
  });

beforeAll(async () => {
  mock = createMockServer(settings);
  mock.on('request', (req) => {
    if (req.url === '/v1/chat/completions') upstreamAuth.push(req.headers.authorization);
  });
  const mockUrl = `http://127.0.0.1:${await listen(mock)}`;
  config = testConfig({ OPENAI_BASE_URL: `${mockUrl}/v1`, OPENAI_API_KEY: 'upstream-secret' });
  app = buildApp(config);
  // Registered after the auth plugin, so it sits behind the same hook as the real routes.
  app.register(async (a) => {
    a.get('/__whoami', async (request) => request.tenant);
  });
  await app.listen({ port: 0, host: '127.0.0.1' });
  gw = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  handle = createDb({ databaseUrl: config.databaseUrl, poolSize: 2 });
  redis = new Redis(config.redisUrl!);
});

afterAll(async () => {
  await app.close();
  mock.closeAllConnections();
  await new Promise((resolve) => mock.close(resolve));
  await cleanup(handle.db, redis, tenantIds, config.redisKeyPrefix);
  redis.disconnect();
  await handle.close();
});

describe('auth hook', () => {
  it('missing, malformed, unknown and revoked keys all get the same 401 body', async () => {
    const valid = await seedKey(handle.db, config);
    tenantIds.push(valid.tenantId);
    const revoked = await seedKey(handle.db, config);
    tenantIds.push(revoked.tenantId);
    const store = keyStoreFromConfig(config, handle.db, redis);
    await store.revoke(revoked.hash);

    // Control: the valid key is accepted, so the 401s below are not a broken fixture.
    expect((await chat({ authorization: `Bearer ${valid.key}` })).status).toBe(200);

    const attempts: Record<string, string>[] = [
      {},
      { authorization: 'Bearer' },
      { authorization: 'Basic abc' },
      { authorization: 'Bearer not-a-gateway-key' },
      { authorization: `Bearer ${generateKey()}` },
      { authorization: `Bearer ${revoked.key}` },
      { authorization: `Bearer ${valid.key.slice(0, -1)}x` },
    ];
    const bodies = new Set<string>();
    for (const headers of attempts) {
      const res = await chat(headers);
      expect(res.status).toBe(401);
      bodies.add(await res.text());
    }
    expect(bodies.size).toBe(1);
    expect(JSON.parse([...bodies][0]!).error).toEqual({
      message: 'Incorrect API key provided. Pass a valid key as "Authorization: Bearer <key>".',
      type: 'invalid_request_error',
      code: 'invalid_api_key',
    });
    // Unknown routes are behind the hook too: no key, no route-existence oracle.
    expect((await fetch(`${gw}/v1/nope`)).status).toBe(401);
  });

  it('valid key reaches the route with request.tenant set', async () => {
    const s = await seedKey(handle.db, config);
    tenantIds.push(s.tenantId);
    const res = await fetch(`${gw}/__whoami`, { headers: { authorization: `Bearer ${s.key}` } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      tenantId: s.tenantId,
      tenantName: s.tenant,
      keyId: s.keyId,
      rpmLimit: null,
      tpmLimit: null,
      monthlyBudgetMicros: null,
    });
    expect(hashKey(config.apiKeyPepper, s.key)).toBe(s.hash);
    expect((await fetch(`${gw}/__whoami`)).status).toBe(401);
  });

  it('client authorization header is not sent upstream', async () => {
    const s = await seedKey(handle.db, config);
    tenantIds.push(s.tenantId);
    upstreamAuth.length = 0;
    expect((await chat({ authorization: `Bearer ${s.key}` })).status).toBe(200);
    expect(upstreamAuth).toEqual(['Bearer upstream-secret']);
    expect(upstreamAuth.join()).not.toContain(s.key);
  });
});
