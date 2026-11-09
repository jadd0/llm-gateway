import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createMockServer, type Settings } from './server.ts';

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
    body: JSON.stringify({ model: 'mock-m', stream, messages: [{ role: 'user', content: 'hi' }] }),
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

  const anthropic = (stream: boolean) =>
    fetch(`${base}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'mock-anthropic-1', stream, max_tokens: 5, system: 'be brief', messages: [{ role: 'user', content: 'hi there' }] }),
    });
  const gemini = (stream: boolean) =>
    fetch(`${base}/v1beta/models/mock-gemini-1:${stream ? 'streamGenerateContent?alt=sse' : 'generateContent'}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: 'hi there' }] }] }),
    });

  it('anthropic format: JSON message with usage, and a named-event stream from message_start to message_stop', async () => {
    const json = (await (await anthropic(false)).json()) as any;
    expect(json).toMatchObject({ type: 'message', model: 'mock-anthropic-1', stop_reason: 'end_turn' });
    expect(json.content[0].text).toBe('tok tok tok tok tok');
    expect(json.usage).toEqual({ input_tokens: 4, output_tokens: 5 });

    const text = await (await anthropic(true)).text();
    const types = [...text.matchAll(/^event: (\w+)$/gm)].map((m) => m[1]);
    expect(types[0]).toBe('message_start');
    expect(types.at(-1)).toBe('message_stop');
    expect(types.filter((t) => t === 'content_block_delta')).toHaveLength(5);
    expect(text).toContain('"usage":{"output_tokens":5}');
  });

  it('gemini format: JSON with usageMetadata, and CRLF-separated data events, the last with finishReason', async () => {
    const json = (await (await gemini(false)).json()) as any;
    expect(json.candidates[0]).toMatchObject({ finishReason: 'STOP', content: { role: 'model' } });
    expect(json.usageMetadata).toMatchObject({ promptTokenCount: 2, candidatesTokenCount: 5 });
    expect(json.modelVersion).toBe('mock-gemini-1');

    const text = await (await gemini(true)).text();
    const events = text.split('\r\n\r\n').filter(Boolean).map((e) => JSON.parse(e.slice(6)));
    expect(events).toHaveLength(5);
    expect(events.slice(0, -1).every((e) => e.candidates[0].finishReason === undefined)).toBe(true);
    expect(events.at(-1).candidates[0].finishReason).toBe('STOP');
    expect(events.at(-1).usageMetadata.candidatesTokenCount).toBe(5);
  });

  it('outage and unknown paths answer in each format', async () => {
    await fetch(`${base}/__control`, { method: 'POST', body: JSON.stringify({ outage: 'error' }) });
    try {
      expect(((await (await anthropic(false)).json()) as any).type).toBe('error');
      expect(((await (await gemini(false)).json()) as any).error.status).toBe('INTERNAL');
    } finally {
      await fetch(`${base}/__control`, { method: 'POST', body: JSON.stringify({ outage: 'off' }) });
    }
    const missing = await fetch(`${base}/v1beta/models/x:embedContent`, { method: 'POST', body: '{}' });
    expect(missing.status).toBe(404);
  });
});
