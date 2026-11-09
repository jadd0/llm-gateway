import { describe, expect, it } from 'vitest';
import { createOpenAiAdapter } from './openai.ts';
import { chatBody, fixture, input } from './test-support.ts';

const adapter = createOpenAiAdapter();

describe('openai adapter', () => {
  it('request and response pass through byte-identical', () => {
    // Odd spacing, a big integer and non-ASCII text: nothing may be re-serialised.
    const raw = Buffer.from('{ "model":"gpt-5-nano","seed":12345678901234567890,\n"messages":[{"role":"user","content":"مرحبا 👋"}] }');
    const body = JSON.parse(raw.toString());
    const r = adapter.buildRequest({ ...input(body, { raw }), metered: false });
    expect(r.ok && r.request.body.equals(raw)).toBe(true);
    expect(r.ok && r.request.path).toBe('/chat/completions');
    expect(r.ok && r.request.headers).toEqual({ 'content-type': 'application/json', authorization: 'Bearer test-key' });
    expect(adapter.translates).toBe(false);
    // Responses are never touched by the adapter: there is nothing to translate, the fixtures are what it forwards.
    expect(JSON.parse(fixture('openai-chat.json').toString()).object).toBe('chat.completion');
  });

  it('no key means no authorization header; tools and other fields are not refused', () => {
    const r = adapter.buildRequest(input(chatBody({ tools: [{}], n: 3, logprobs: true }), { apiKey: undefined }));
    expect(r.ok && r.request.headers.authorization).toBeUndefined();
    expect(r.ok).toBe(true);
  });

  it('a streamed metered request asks for usage and strips the chunk the client did not ask for', () => {
    const raw = Buffer.from('{"model":"gpt-5-nano","stream":true,"messages":[]}');
    const r = adapter.buildRequest(input(JSON.parse(raw.toString()), { raw }));
    expect(r.ok && r.request.tap).toBe('strip');
    expect(r.ok && r.request.body.toString()).toBe('{"stream_options":{"include_usage":true},"model":"gpt-5-nano","stream":true,"messages":[]}');
  });
});
