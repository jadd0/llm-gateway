import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createMockServer, type Settings } from '../src/server.ts';

const settings: Settings = {
  latencyMs: 0,
  tokenDelayMs: 0,
  completionTokens: 5,
  errorRate: 0,
  outage: 'off',
};
const server = createMockServer(settings);
let base = '';

beforeAll(async () => {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
});

const chat = (stream: boolean) =>
  fetch(`${base}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'm', stream, messages: [{ role: 'user', content: 'hi' }] }),
  });

describe('mock provider', () => {
  it('control endpoint switches outage to error and back', async () => {
    expect((await chat(false)).status).toBe(200);

    const set = await fetch(`${base}/__control`, {
      method: 'POST',
      body: JSON.stringify({ outage: 'error' }),
    });
    expect(((await set.json()) as Settings).outage).toBe('error');
    expect((await chat(false)).status).toBe(500);

    await fetch(`${base}/__control`, { method: 'POST', body: JSON.stringify({ outage: 'off' }) });
    expect((await chat(false)).status).toBe(200);
  });

  it('streamed response emits completionTokens chunks then usage then [DONE]', async () => {
    const res = await chat(true);
    expect(res.headers.get('content-type')).toBe('text/event-stream');
    const events = (await res.text())
      .split('\n\n')
      .filter((e) => e.startsWith('data: '))
      .map((e) => e.slice(6));

    expect(events.at(-1)).toBe('[DONE]');
    const parsed = events.slice(0, -1).map((e) => JSON.parse(e));
    const contentChunks = parsed.filter((c) => c.choices[0].delta.content === 'tok ');
    expect(contentChunks).toHaveLength(5);
    const last = parsed.at(-1);
    expect(last.choices[0].finish_reason).toBe('stop');
    expect(last.usage.completion_tokens).toBe(5);
  });
});
