import { describe, expect, it } from 'vitest';
import { createAnthropicAdapter } from './anthropic.ts';
import { chatBody, clock, fixture, input, openaiEvents, run } from '../../test/providers-support.ts';
import type { Usage } from '../usage/sse-usage.ts';

const adapter = createAnthropicAdapter({ version: '2023-06-01', clock });
const build = (extra: Record<string, unknown>, over = {}) => {
  const r = adapter.buildRequest(input(chatBody({ model: 'claude-haiku-5-5', ...extra }), over));
  if (!r.ok) throw new Error(`refused: ${r.param}`);
  return { ...r.request, json: JSON.parse(r.request.body.toString('utf8')) };
};
const stream = async (name: string, size?: number, includeUsage = true) => {
  const usages: Usage[] = [];
  const t = adapter.translates ? adapter.streamTransform({ includeUsage, onUsage: (u) => usages.push(u) }) : null!;
  const text = await run(t, fixture(name), size);
  return { text, events: openaiEvents(text), usages };
};
const textOf = (events: any[]) => events.filter((e) => e !== '[DONE]' && e.choices).map((e) => e.choices[0]?.delta?.content ?? '').join('');

describe('anthropic adapter', () => {
  it('request translation: system, merged turns, max_tokens default, stop, sampling params', () => {
    const r = build({
      messages: [
        { role: 'system', content: 'Be brief.' },
        { role: 'developer', content: [{ type: 'text', text: 'Answer in Arabic.' }] },
        { role: 'user', content: 'one' },
        { role: 'user', content: [{ type: 'text', text: 'two' }, { type: 'text', text: ' three' }] },
        { role: 'assistant', content: 'four' },
        { role: 'user', content: 'five' },
      ],
      stop: ['END', 'STOP'],
      temperature: 0.2,
      top_p: 0.9,
      stream: true,
    });
    expect(r.path).toBe('/v1/messages');
    expect(r.headers).toEqual({ 'content-type': 'application/json', 'anthropic-version': '2023-06-01', 'x-api-key': 'test-key' });
    expect(r.json).toEqual({
      model: 'claude-haiku-5-5',
      max_tokens: 1024, // the default: Anthropic requires one
      system: 'Be brief.\n\nAnswer in Arabic.',
      messages: [
        { role: 'user', content: 'one\n\ntwo three' },
        { role: 'assistant', content: 'four' },
        { role: 'user', content: 'five' },
      ],
      stop_sequences: ['END', 'STOP'],
      temperature: 0.2,
      top_p: 0.9,
      stream: true,
    });
    // max_tokens beats max_completion_tokens beats the default; a single stop string becomes a list.
    expect(build({ max_tokens: 7, max_completion_tokens: 9, stop: 'X' }).json).toMatchObject({ max_tokens: 7, stop_sequences: ['X'] });
    expect(build({ max_completion_tokens: 9 }).json.max_tokens).toBe(9);
    expect(build({}, { defaultMaxTokens: 33 }).json.max_tokens).toBe(33);
    expect('stream' in build({}).json).toBe(false);
  });

  it('non-streamed response translates text, finish_reason and usage', () => {
    const { openaiBody, usage } = adapter.translates ? adapter.parseResponse(fixture('anthropic-message.json')) : null!;
    expect(openaiBody).toEqual({
      id: 'chatcmpl-msg_fixture',
      object: 'chat.completion',
      created: 1_700_000_000,
      model: 'claude-haiku-5-5',
      choices: [{ index: 0, message: { role: 'assistant', content: 'Hello! How can I help you today?' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 25, completion_tokens: 11, total_tokens: 36 },
    });
    expect(usage).toEqual({ promptTokens: 25, completionTokens: 11, totalTokens: 36 });
    const cut = JSON.stringify({ ...JSON.parse(fixture('anthropic-message.json').toString()), stop_reason: 'max_tokens' });
    expect((adapter.translates ? adapter.parseResponse(Buffer.from(cut)).openaiBody : null!) as any).toMatchObject({
      choices: [{ finish_reason: 'length' }],
    });
  });

  it('streamed fixture translates to OpenAI chunks ending in [DONE] with usage', async () => {
    const { events, usages } = await stream('anthropic-stream.sse');
    expect(events.at(-1)).toBe('[DONE]');
    const chunks = events.slice(0, -1);
    expect(chunks[0].choices[0].delta).toEqual({ role: 'assistant', content: '' });
    expect(textOf(events)).toBe('Hello! How can I help you today?');
    expect(chunks.every((c) => c.object === 'chat.completion.chunk' && c.id === 'chatcmpl-msg_fixture')).toBe(true);
    const finish = chunks.filter((c) => c.choices[0]?.finish_reason);
    expect(finish).toHaveLength(1);
    expect(finish[0].choices[0].finish_reason).toBe('stop');
    expect(chunks.at(-1)).toMatchObject({ choices: [], usage: { prompt_tokens: 25, completion_tokens: 15, total_tokens: 40 } });
    expect(usages).toEqual([{ promptTokens: 25, completionTokens: 15, totalTokens: 40 }]);
  });

  it('the usage-only chunk is written only when the client asked, but usage is always reported', async () => {
    const { events, usages } = await stream('anthropic-stream.sse', undefined, false);
    expect(events.some((e) => e !== '[DONE]' && 'usage' in e)).toBe(false);
    expect(usages).toHaveLength(1);
  });

  it('a stream fed one byte at a time translates identically, Arabic and emoji intact', async () => {
    for (const name of ['anthropic-stream.sse', 'anthropic-stream-unicode.sse']) {
      const whole = await stream(name);
      for (const size of [1, 2, 7]) expect((await stream(name, size)).text, `${name} ${size}`).toBe(whole.text);
    }
    expect(textOf((await stream('anthropic-stream-unicode.sse', 1)).events)).toBe('مرحبا 👋🏽 سلام, 你好');
  });

  it('provider error event mid-stream ends the stream with an OpenAI-shaped error', async () => {
    const { events, usages } = await stream('anthropic-stream-error.sse');
    expect(textOf(events)).toBe('Hello');
    expect(events.at(-1)).toEqual({ error: { message: 'Overloaded', type: 'server_error', code: 'overloaded_error' } });
    expect(events).not.toContain('[DONE]');
    expect(usages).toEqual([]); // no usage seen: the estimate stays charged
  });

  it('a stream that ends before message_stop ends with an error, not a clean [DONE]', async () => {
    const whole = fixture('anthropic-stream.sse').toString();
    const truncated = Buffer.from(whole.slice(0, whole.indexOf('event: message_delta')));
    const t = adapter.translates ? adapter.streamTransform({ includeUsage: true, onUsage: () => {} }) : null!;
    const events = openaiEvents(await run(t, truncated, 5));
    expect(events).not.toContain('[DONE]');
    expect(events.at(-1).error.code).toBe('upstream_stream_incomplete');
  });

  it('unsupported parameters return 400 unsupported_parameter', () => {
    const cases: Array<[string, Record<string, unknown>]> = [
      ['tools', { tools: [{ type: 'function', function: { name: 'f' } }] }],
      ['tool_choice', { tool_choice: 'auto' }],
      ['functions', { functions: [] }],
      ['presence_penalty', { presence_penalty: 0.1 }],
      ['frequency_penalty', { frequency_penalty: 2 }],
      ['seed', { seed: 0 }],
      ['reasoning_effort', { reasoning_effort: 'low' }],
      ['temperature', { temperature: 1.5 }],
      ['logprobs', { logprobs: true }],
      ['n', { n: 2 }],
      ['response_format', { response_format: { type: 'json_object' } }],
      ['audio', { audio: { voice: 'x' } }],
      ['messages[0].content[1].type', { messages: [{ role: 'user', content: [{ type: 'text', text: 'a' }, { type: 'image_url', image_url: { url: 'x' } }] }] }],
      ['messages[0].role', { messages: [{ role: 'tool', content: 'x' }] }],
      ['messages[0].tool_calls', { messages: [{ role: 'assistant', content: 'x', tool_calls: [] }] }],
    ];
    for (const [param, extra] of cases) {
      const r = adapter.buildRequest(input(chatBody(extra)));
      expect(r.ok, param).toBe(false);
      if (!r.ok) expect(r.param, param).toBe(param);
    }
    expect(adapter.buildRequest(input(chatBody({ n: 1 }))).ok).toBe(true);
  });

  it('neutral values pass and the dropped fields are dropped; temperature 1 is the top of the range', () => {
    const neutral = { presence_penalty: 0, frequency_penalty: 0, logprobs: false, n: null, seed: null, top_logprobs: 0, reasoning_effort: null, tools: null };
    expect(adapter.buildRequest(input(chatBody(neutral))).ok).toBe(true);
    const r = build({ user: 'u', metadata: { a: 'b' }, service_tier: 'auto', temperature: 1 });
    expect(r.json).toEqual({ model: 'claude-haiku-5-5', max_tokens: 1024, messages: [{ role: 'user', content: 'hi' }], temperature: 1 });
  });

  it('a mid-stream error maps by meaning: rate limit, invalid request, auth, server', async () => {
    const kinds = [
      ['rate_limit_error', 'rate_limit_error', 'rate_limit_exceeded'],
      ['invalid_request_error', 'invalid_request_error', 'invalid_request_error'],
      ['overloaded_error', 'server_error', 'overloaded_error'],
      ['api_error', 'server_error', 'api_error'],
      ['timeout_error', 'server_error', 'timeout_error'],
      ['authentication_error', 'gateway_error', 'provider_auth_failed'],
      ['not_found_error', 'invalid_request_error', 'not_found_error'],
      ['request_too_large', 'invalid_request_error', 'request_too_large'],
    ] as const;
    for (const [from, type, code] of kinds) {
      const sse = `event: error\ndata: ${JSON.stringify({ type: 'error', error: { type: from, message: 'provider words' } })}\n\n`;
      const events = openaiEvents(await run(adapter.translates ? adapter.streamTransform({ includeUsage: false, onUsage: () => {} }) : null!, Buffer.from(sse)));
      expect(events.at(-1).error, from).toMatchObject({ type, code });
      if (code === 'provider_auth_failed') expect(events.at(-1).error.message).not.toContain('provider words');
    }
  });

  it('a mid-stream auth error is logged like the non-streamed one: provider and code, never the message', async () => {
    const lines: Array<[object, string]> = [];
    const log = { error: (o: object, m: string) => void lines.push([o, m]) };
    const sse = `event: error\ndata: ${JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'sk-live-SECRET' } })}\n\n`;
    await run(adapter.translates ? adapter.streamTransform({ includeUsage: false, onUsage: () => {}, log }) : null!, Buffer.from(sse));
    expect(lines).toEqual([[{ provider: 'anthropic', providerCode: 'authentication_error' }, 'provider rejected the gateway credentials']]);
    expect(JSON.stringify(lines)).not.toContain('SECRET');
  });

  it('error statuses map (429 keeps retry-after; 529 → 503 for Anthropic)', () => {
    if (!adapter.translates) throw new Error('translating adapter');
    expect(adapter.mapError(429, fixture('anthropic-error-429.json'))).toEqual({
      status: 429,
      body: { error: { message: 'Number of request tokens has exceeded your per-minute rate limit.', type: 'rate_limit_error', code: 'rate_limit_error' } },
    });
    expect(adapter.mapError(529, fixture('anthropic-error-529.json'))).toEqual({
      status: 503,
      body: { error: { message: 'Overloaded', type: 'server_error', code: 'overloaded_error' } },
    });
    expect(adapter.mapError(400, Buffer.from('not json')).status).toBe(400);
    expect(adapter.mapError(500, Buffer.from('<html>')).body.error.type).toBe('server_error');
  });
});
