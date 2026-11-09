import http, { type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { phaseOf } from './resilience/timeouts.ts';
import { testConfig } from './test-env.ts';
import { createUpstream } from './upstream.ts';

const servers: Server[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) {
    s.closeAllConnections();
    await new Promise((r) => s.close(r));
  }
});
const serve = async (handler: http.RequestListener) => {
  const s = http.createServer(handler);
  servers.push(s);
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  return `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
};

// What one call to the mock-openai target did: how long it took and how it failed.
async function attempt(url: string, timeouts: Record<string, string>) {
  const upstream = createUpstream(testConfig({ MOCK_BASE_URL: url, ...timeouts }));
  const target = upstream.resolve('mock-openai-1')!;
  const started = performance.now();
  try {
    const res = await target.pool.request({ path: `${target.basePath}/chat/completions`, method: 'POST', headers: {}, body: '{}' });
    await res.body.arrayBuffer();
    return { phase: 'none' as const, ms: performance.now() - started };
  } catch (err) {
    return { phase: phaseOf(err), ms: performance.now() - started };
  } finally {
    await upstream.close();
  }
}

describe('upstream pools', () => {
  it('connect, headers and idle timeouts are separate', async () => {
    const LONG = '5000';
    const SHORT = '150';

    // Never answers: only the headers timeout is short, and it is the one that fires.
    const silent = await serve(() => {});
    const headers = await attempt(silent, { UPSTREAM_CONNECT_TIMEOUT_MS: LONG, UPSTREAM_HEADERS_TIMEOUT_MS: SHORT, UPSTREAM_IDLE_TIMEOUT_MS: LONG });
    expect(headers.phase).toBe('headers');
    expect(headers.ms).toBeGreaterThanOrEqual(140);
    expect(headers.ms).toBeLessThan(2000);

    // Sends headers and then goes quiet: only the idle timeout is short, and a long headers timeout does not hide it.
    const stalls = await serve((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.write('{');
    });
    const idle = await attempt(stalls, { UPSTREAM_CONNECT_TIMEOUT_MS: LONG, UPSTREAM_HEADERS_TIMEOUT_MS: LONG, UPSTREAM_IDLE_TIMEOUT_MS: SHORT });
    expect(idle.phase).toBe('body');
    expect(idle.ms).toBeGreaterThanOrEqual(140);
    expect(idle.ms).toBeLessThan(2000);

    // The same silent server with a short idle timeout and a long headers timeout is NOT cut early: the
    // limits are not one number.
    const patient = await attempt(silent, { UPSTREAM_CONNECT_TIMEOUT_MS: LONG, UPSTREAM_HEADERS_TIMEOUT_MS: '600', UPSTREAM_IDLE_TIMEOUT_MS: SHORT });
    expect(patient.phase).toBe('headers');
    expect(patient.ms).toBeGreaterThanOrEqual(550);

    // Nothing listens: the call fails as a connect error at once, whatever the long headers timeout says.
    const closed = await serve(() => {});
    const dead = closed;
    await new Promise((r) => servers.pop()!.close(r));
    const connect = await attempt(dead, { UPSTREAM_CONNECT_TIMEOUT_MS: SHORT, UPSTREAM_HEADERS_TIMEOUT_MS: LONG, UPSTREAM_IDLE_TIMEOUT_MS: LONG });
    expect(connect.phase).toBe('connect');
    expect(connect.ms).toBeLessThan(2000);
  });
});
