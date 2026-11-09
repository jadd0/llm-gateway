import { connect, type AddressInfo } from 'node:net';
import type { FastifyInstance } from 'fastify';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../app.ts';
import { createDb, type Db } from '../db/client.ts';
import { cleanup, seedKey, testConfig } from '../test-env.ts';
import { generateKey } from './keys.ts';
import { ipBucketId } from './ip-limit.ts';

const LIMIT = 30;
const NOW = 1_700_000_000_000; // one injected clock: no bucket refills during a test
let handle: Db;
let redis: Redis;
const tenantIds: string[] = [];
const prefixes: string[] = [];
const apps: FastifyInstance[] = [];

interface Gw {
  url: string;
  prefix: string;
  config: ReturnType<typeof testConfig>;
  /** A valid key the warm-up has cached. */
  key: string;
}

async function start(overrides: Record<string, string> = {}): Promise<Gw> {
  const config = testConfig({ AUTH_FAIL_LIMIT_PER_MIN: String(LIMIT), ...overrides });
  const app = buildApp(config, { rateLimitClock: () => NOW });
  app.register(async (a) => {
    a.get('/__whoami', async (request) => request.tenant);
  });
  await app.listen({ port: 0, host: '127.0.0.1' });
  apps.push(app);
  prefixes.push(config.redisKeyPrefix);
  const gw: Gw = { key: '', url: `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`, prefix: config.redisKeyPrefix, config };
  // Redis commands fail until the app's client has connected (and the limiter then fails open): send one
  // valid request at a time until the key cache holds the key (the same client serves the limiter, a full bucket expires at once).
  const seeded = await seedKey(handle.db, config);
  tenantIds.push(seeded.tenantId);
  gw.key = seeded.key;
  for (let i = 0; i < 100 && (await redis.keys(`${gw.prefix}apikey:*`)).length === 0; i++) {
    await get(gw, { authorization: `Bearer ${seeded.key}` });
    await new Promise((r) => setTimeout(r, 50));
  }
  expect((await redis.keys(`${gw.prefix}apikey:*`)).length).toBeGreaterThan(0);
  return gw;
}

const get = (gw: Gw, headers: Record<string, string>) => fetch(`${gw.url}/__whoami`, { headers });
const bad = () => ({ authorization: `Bearer ${generateKey()}` });
// Each unknown key that reaches Postgres leaves one negative-cache entry in Redis (minus the one valid
// key the warm-up cached).
const lookups = async (gw: Gw) => (await redis.keys(`${gw.prefix}apikey:*`)).length - 1;

beforeAll(() => {
  const config = testConfig();
  handle = createDb({ databaseUrl: config.databaseUrl, poolSize: 2 });
  redis = new Redis(config.redisUrl!);
});

afterAll(async () => {
  await Promise.all(apps.map((a) => a.close()));
  for (const p of prefixes) await cleanup(handle.db, redis, [], p);
  await cleanup(handle.db, redis, tenantIds, 'none-');
  redis.disconnect();
  await handle.close();
});

describe('failed-auth limit per address', () => {
  it('an exhausted address: cached valid key 200, unknown keys 429, Postgres untouched', async () => {
    // A late Redis answer fails open by design; on a loaded machine 500 takes in flight can exceed the
    // 50 ms default, so this test (about atomicity, not latency) gives Redis room.
    const gw = await start({ RATE_LIMIT_REDIS_TIMEOUT_MS: '5000' });
    // Control: before the limit a bad key is a plain 401 that reached Postgres.
    const first = bad();
    expect((await get(gw, first)).status).toBe(401);
    expect(await lookups(gw)).toBe(1);

    // The first LIMIT failures, one at a time, are the limit's worth: each reaches Postgres.
    for (let i = 1; i < LIMIT; i++) expect((await get(gw, bad())).status).toBe(401);
    expect(await lookups(gw)).toBe(LIMIT);

    // Then 10 000 random well-formed keys, 500 in flight at a time: all refused ahead of Postgres.
    const statuses = new Map<number, number>();
    for (let i = 0; i < 20; i++) {
      const batch = await Promise.all(Array.from({ length: 500 }, () => get(gw, bad()).then((r) => r.status)));
      for (const s of batch) statuses.set(s, (statuses.get(s) ?? 0) + 1);
    }
    expect(statuses.get(429)).toBe(10_000);
    expect(statuses.get(401)).toBeUndefined();
    // The take is one atomic script, so the bound is the limit itself: no concurrent overshoot.
    expect(await lookups(gw)).toBeLessThanOrEqual(LIMIT);

    const refused = await get(gw, bad());
    expect(refused.status).toBe(429);
    expect(refused.headers.get('retry-after')).not.toBeNull();
    expect(((await refused.json()) as { error: { code: string } }).error.code).toBe('auth_rate_limit_exceeded');

    // A cached "unknown key" answers without Postgres but is still a failed authentication: charged, so 429 now.
    expect((await get(gw, first)).status).toBe(429);
    // A key already in the cache is never refused, whatever state the address's bucket is in.
    for (let i = 0; i < 5; i++) expect((await get(gw, { authorization: `Bearer ${gw.key}` })).status).toBe(200);
    expect(await lookups(gw)).toBeLessThanOrEqual(LIMIT);
  }, 120_000);

  it('a negative-cached unknown key is charged to the address without a Postgres query', async () => {
    const gw = await start();
    const unknown = bad();
    expect((await get(gw, unknown)).status).toBe(401); // reaches Postgres, caches "unknown"
    expect(await lookups(gw)).toBe(1);
    // LIMIT-1 more hits on the cache drain what is left of the bucket (one token went to the first request).
    for (let i = 0; i < LIMIT - 1; i++) expect((await get(gw, unknown)).status).toBe(401);
    expect(await lookups(gw)).toBe(1);
    expect((await get(gw, unknown)).status).toBe(429);
  }, 30_000);

  it('a cached valid key makes no call on the address bucket', async () => {
    const gw = await start();
    // MONITOR on a raw socket: ioredis's own monitor() races other files' traffic on the shared Redis.
    const { hostname, port } = new URL(gw.config.redisUrl!);
    const sock = connect(Number(port || 6379), hostname);
    let feed = '';
    sock.on('data', (d) => (feed += d.toString('utf8')));
    sock.write('MONITOR\r\n');
    await vi.waitFor(() => expect(feed).toContain('+OK'));
    const seen = () => feed.split('\r\n').filter((l) => l.includes(`${gw.prefix}ipfail`));
    for (let i = 0; i < 20; i++) expect((await get(gw, { authorization: `Bearer ${gw.key}` })).status).toBe(200);
    await new Promise((r) => setTimeout(r, 100));
    expect(seen()).toEqual([]);
    // Control: a failed authentication does reach it, so the monitor sees what it should.
    expect((await get(gw, bad())).status).toBe(401);
    await vi.waitFor(() => expect(seen().length).toBeGreaterThan(0));
    sock.destroy();
  }, 30_000);

  it('successful auths never count', async () => {
    const gw = await start();
    const seeded = await seedKey(handle.db, gw.config);
    tenantIds.push(seeded.tenantId);
    // Several times the limit, in parallel and in series: a busy legitimate client is never limited.
    const codes: number[] = [];
    for (let i = 0; i < 5; i++) {
      const batch = await Promise.all(
        Array.from({ length: LIMIT }, () => get(gw, { authorization: `Bearer ${seeded.key}` }).then((r) => r.status)),
      );
      codes.push(...batch);
    }
    expect(codes).toHaveLength(5 * LIMIT);
    expect(codes.every((c) => c === 200)).toBe(true);
    // And the bucket is still whole: the full limit of failures is still available afterwards.
    let unauthorized = 0;
    for (let i = 0; i < LIMIT; i++) if ((await get(gw, bad())).status === 401) unauthorized++;
    expect(unauthorized).toBe(LIMIT);
    expect((await get(gw, bad())).status).toBe(429);
  }, 30_000);

  it('X-Forwarded-For ignored unless the peer is trusted', async () => {
    // The test client connects from 127.0.0.1, which is not a trusted proxy here.
    const untrusted = await start({ TRUSTED_PROXIES: '10.9.9.9' });
    const codes: number[] = [];
    for (let i = 0; i < LIMIT + 5; i++) codes.push((await get(untrusted, { ...bad(), 'x-forwarded-for': `203.0.113.${i + 1}` })).status);
    expect(codes.filter((c) => c === 401)).toHaveLength(LIMIT);
    expect(codes.filter((c) => c === 429)).toHaveLength(5);

    // Control: the same spread of addresses from a trusted peer gets a bucket each, so nothing is limited.
    const trusted = await start({ TRUSTED_PROXIES: '127.0.0.1' });
    const trustedCodes: number[] = [];
    for (let i = 0; i < LIMIT + 5; i++) trustedCodes.push((await get(trusted, { ...bad(), 'x-forwarded-for': `203.0.113.${i + 1}` })).status);
    expect(trustedCodes).toHaveLength(LIMIT + 5);
    expect(trustedCodes.every((c) => c === 401)).toBe(true);
  }, 30_000);

  it('AUTH_FAIL_LIMIT_PER_MIN=0 turns the limit off', async () => {
    const gw = await start({ AUTH_FAIL_LIMIT_PER_MIN: '0' });
    const codes: number[] = [];
    for (let i = 0; i < LIMIT + 5; i++) codes.push((await get(gw, bad())).status);
    expect(codes.every((c) => c === 401)).toBe(true);
  }, 30_000);
});

describe('ipBucketId', () => {
  it('keeps IPv4 as is, unwraps mapped IPv4 and folds IPv6 to its /64', () => {
    expect(ipBucketId('203.0.113.7')).toBe('203.0.113.7');
    expect(ipBucketId('::ffff:203.0.113.7')).toBe('203.0.113.7');
    expect(ipBucketId('2001:db8:1:2:aaaa:bbbb:cccc:dddd')).toBe('2001:db8:1:2::/64');
    expect(ipBucketId('2001:DB8:1:2::1')).toBe('2001:db8:1:2::/64');
    expect(ipBucketId('2001:db8:1:2:0:0:0:99')).toBe(ipBucketId('2001:db8:1:2::5'));
    expect(ipBucketId('::1')).toBe('0:0:0:0::/64');
  });
});
