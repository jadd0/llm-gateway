import { describe, expect, it } from 'vitest';
import { createGeminiAdapter } from './gemini.ts';
import { chatBody, clock, fixture, input, openaiEvents, run } from './test-support.ts';
import type { Usage } from '../usage/sse-usage.ts';

const adapter = createGeminiAdapter({ clock });
if (!adapter.translates) throw new Error('translating adapter');
const a = adapter;
const build = (extra: Record<string, unknown>, over = {}) => {
  const r = a.buildRequest(input(chatBody({ model: 'gemini-3.1-flash-lite', ...extra }), over));
  if (!r.ok) throw new Error(`refused: ${r.param}`);
  return { ...r.request, json: JSON.parse(r.request.body.toString('utf8')) };
};
const stream = async (name: string, size?: number, includeUsage = true) => {
  const usages: Usage[] = [];
  const text = await run(a.streamTransform({ includeUsage, onUsage: (u) => usages.push(u) }), fixture(name), size);
  return { text, events: openaiEvents(text), usages };
};
const textOf = (events: any[]) => events.filter((e) => e !== '[DONE]' && e.choices).map((e) => e.choices[0]?.delta?.content ?? '').join('');

describe('gemini adapter', () => {
  it('request translation: system, merged turns, max_tokens default, stop, sampling params', () => {
    const r = build({
      messages: [
        { role: 'system', content: 'Be brief.' },
        { role: 'user', content: 'one' },
        { role: 'user', content: 'two' },
        { role: 'assistant', content: 'three' },
        { role: 'user', content: [{ type: 'text', text: 'four' }] },
      ],
      max_tokens: 50,
      stop: 'END',
      temperature: 0.3,
      top_p: 0.8,
    });
    expect(r.path).toBe('/models/gemini-3.1-flash-lite:generateContent');
    expect(r.headers).toEqual({ 'content-type': 'application/json', 'x-goog-api-key': 'test-key' });
    expect(r.json).toEqual({
      contents: [
        { role: 'user', parts: [{ text: 'one\n\ntwo' }] },
        { role: 'model', parts: [{ text: 'three' }] },
        { role: 'user', parts: [{ text: 'four' }] },
      ],
      systemInstruction: { parts: [{ text: 'Be brief.' }] },
      generationConfig: { maxOutputTokens: 50, temperature: 0.3, topP: 0.8, stopSequences: ['END'] },
    });
    // Gemini needs no max_tokens: none is invented. Streaming picks the SSE method; the model is path-encoded.
    const plain = build({});
    expect(plain.json).toEqual({ contents: [{ role: 'user', parts: [{ text: 'hi' }] }] });
    expect(build({ max_completion_tokens: 9, stream: true }).path).toBe('/models/gemini-3.1-flash-lite:streamGenerateContent?alt=sse');
    expect(build({ max_completion_tokens: 9 }).json.generationConfig).toEqual({ maxOutputTokens: 9 });
    expect(build({ model: 'gemini-x/../y?z' }).path).toBe('/models/gemini-x%2F..%2Fy%3Fz:generateContent');
  });

  it('non-streamed response translates text, finish_reason and usage', () => {
    const { openaiBody, usage } = a.parseResponse(fixture('gemini-generate.json'));
    expect(openaiBody).toMatchObject({
      object: 'chat.completion',
      created: 1_700_000_000,
      model: 'gemini-3.1-flash-lite',
      choices: [{ index: 0, message: { role: 'assistant', content: 'Hello! How can I help you today?' }, finish_reason: 'stop' }],
      // thinking tokens are billed as output: 11 + 7
      usage: { prompt_tokens: 9, completion_tokens: 18, total_tokens: 27 },
    });
    expect(usage).toEqual({ promptTokens: 9, completionTokens: 18, totalTokens: 27 });
    const finish = (reason: string, extra: object = {}) =>
      (a.parseResponse(Buffer.from(JSON.stringify({ candidates: [{ content: { parts: [{ text: 'x' }] }, finishReason: reason }], ...extra }))).openaiBody as any).choices[0].finish_reason;
    expect([finish('STOP'), finish('MAX_TOKENS'), finish('SAFETY'), finish('RECITATION')]).toEqual(['stop', 'length', 'content_filter', 'content_filter']);
    // A prompt the model refused has no candidates, only promptFeedback.
    const blocked = a.parseResponse(Buffer.from(JSON.stringify({ promptFeedback: { blockReason: 'SAFETY' } }))).openaiBody as any;
    expect(blocked.choices[0]).toMatchObject({ message: { content: '' }, finish_reason: 'content_filter' });
    // Thought summaries are not part of the answer.
    const thought = a.parseResponse(Buffer.from(JSON.stringify({ candidates: [{ content: { parts: [{ text: 'hmm', thought: true }, { text: 'ok' }] }, finishReason: 'STOP' }] }))).openaiBody as any;
    expect(thought.choices[0].message.content).toBe('ok');
  });

  it('streamed fixture translates to OpenAI chunks ending in [DONE] with usage', async () => {
    const { events, usages } = await stream('gemini-stream.sse');
    expect(events.at(-1)).toBe('[DONE]');
    const chunks = events.slice(0, -1);
    expect(chunks[0].choices[0].delta).toEqual({ role: 'assistant', content: '' });
    expect(textOf(events)).toBe('Hello! How can I help you today?');
    expect(chunks.every((c) => c.object === 'chat.completion.chunk' && c.model === 'gemini-3.1-flash-lite')).toBe(true);
    expect(chunks.filter((c) => c.choices[0]?.finish_reason).map((c) => c.choices[0].finish_reason)).toEqual(['stop']);
    expect(chunks.at(-1)).toMatchObject({ choices: [], usage: { prompt_tokens: 9, completion_tokens: 15, total_tokens: 24 } });
    expect(usages).toEqual([{ promptTokens: 9, completionTokens: 15, totalTokens: 24 }]);
    const without = await stream('gemini-stream.sse', undefined, false);
    expect(without.events.some((e) => e !== '[DONE]' && 'usage' in e)).toBe(false);
    expect(without.usages).toHaveLength(1);
  });

  it('a stream fed one byte at a time translates identically, Arabic and emoji intact', async () => {
    for (const name of ['gemini-stream.sse', 'gemini-stream-unicode.sse']) {
      const whole = await stream(name);
      for (const size of [1, 2, 7]) expect((await stream(name, size)).text, `${name} ${size}`).toBe(whole.text);
    }
    expect(textOf((await stream('gemini-stream-unicode.sse', 1)).events)).toBe('مرحبا 👋🏽 سلام, 你好');
  });

  it('provider error event mid-stream ends the stream with an OpenAI-shaped error', async () => {
    const { events, usages } = await stream('gemini-stream-error.sse');
    expect(textOf(events)).toBe('Hello');
    expect(events.at(-1)).toEqual({ error: { message: 'The model is overloaded. Please try again later.', type: 'server_error', code: 'unavailable' } });
    expect(events).not.toContain('[DONE]');
    expect(usages).toEqual([]);
  });

  it('a stream with no finishReason ends with an error, not a clean [DONE]', async () => {
    const whole = fixture('gemini-stream.sse').toString();
    const truncated = Buffer.from(whole.slice(0, whole.lastIndexOf('data: ')));
    const events = openaiEvents(await run(a.streamTransform({ includeUsage: true, onUsage: () => {} }), truncated, 9));
    expect(events).not.toContain('[DONE]');
    expect(events.at(-1).error.code).toBe('upstream_stream_incomplete');
  });

  it('unsupported parameters return 400 unsupported_parameter', () => {
    const cases: Array<[string, Record<string, unknown>]> = [
      ['tools', { tools: [{ type: 'function', function: { name: 'f' } }] }],
      ['tool_choice', { tool_choice: 'none' }],
      ['logprobs', { logprobs: true }],
      ['top_logprobs', { top_logprobs: 2 }],
      ['n', { n: 3 }],
      ['response_format', { response_format: { type: 'json_object' } }],
      ['modalities', { modalities: ['audio'] }],
      ['seed', { seed: 1 }],
      ['messages[1].content[0].type', { messages: [{ role: 'user', content: 'a' }, { role: 'user', content: [{ type: 'input_audio', input_audio: {} }] }] }],
    ];
    for (const [param, extra] of cases) {
      const r = a.buildRequest(input(chatBody(extra)));
      expect(r.ok, param).toBe(false);
      if (!r.ok) expect(r.param, param).toBe(param);
    }
  });

  it('error statuses map (429 keeps its status and the body is OpenAI-shaped)', () => {
    expect(a.mapError(429, fixture('gemini-error-429.json'))).toEqual({
      status: 429,
      body: { error: { message: 'Resource has been exhausted (e.g. check quota).', type: 'rate_limit_error', code: 'resource_exhausted' } },
    });
    expect(a.mapError(503, Buffer.from('{}')).status).toBe(503); // Gemini 503 stays 503
    expect(a.mapError(400, Buffer.from('nope')).body.error.type).toBe('invalid_request_error');
  });
});
