import { describe, expect, it } from 'vitest';
import { createAnthropicAdapter } from '../providers/anthropic.ts';
import { createGeminiAdapter } from '../providers/gemini.ts';
import { clock, fixture, run } from '../providers/test-support.ts';
import { StreamCollector, completionFromBody } from './collect.ts';

const collect = async (text: string | Buffer, size?: number) => {
  const c = new StreamCollector(1_000_000);
  const passed = await run(c, Buffer.from(text), size);
  return { passed, result: c.complete() };
};

const translated = async (adapter: ReturnType<typeof createAnthropicAdapter> | ReturnType<typeof createGeminiAdapter>, name: string, size?: number) => {
  if (!adapter.translates) throw new Error('not a translating adapter');
  const out = await run(adapter.streamTransform({ includeUsage: true, onUsage: () => {} }), fixture(name));
  return collect(out, size);
};

describe('stream collector', () => {
  it('assembles content from OpenAI, Anthropic and Gemini translated streams', async () => {
    const openai = await collect(fixture('openai-stream.sse'));
    expect(openai.result).toEqual({ content: 'Hello!', finishReason: 'stop', usage: { promptTokens: 9, completionTokens: 2, totalTokens: 11 } });
    // The client gets exactly the bytes the collector was given, however they are cut.
    expect(openai.passed).toBe(fixture('openai-stream.sse').toString());
    expect((await collect(fixture('openai-stream.sse'), 3)).result).toEqual(openai.result);

    const anthropic = await translated(createAnthropicAdapter({ version: '2023-06-01', clock }), 'anthropic-stream.sse');
    expect(anthropic.result).toMatchObject({ finishReason: 'stop' });
    expect(anthropic.result!.content.length).toBeGreaterThan(0);
    const gemini = await translated(createGeminiAdapter({ clock }), 'gemini-stream.sse');
    expect(gemini.result!.content.length).toBeGreaterThan(0);
    expect(gemini.result!.finishReason).toMatch(/^(stop|length)$/);

    const unicode = await translated(createAnthropicAdapter({ version: '2023-06-01', clock }), 'anthropic-stream-unicode.sse', 5);
    expect(unicode.result!.content).toBe('مرحبا 👋🏽 سلام, 你好');
  });

  it('error event or missing [DONE] means nothing is stored', async () => {
    const whole = fixture('openai-stream.sse').toString();
    expect((await collect(whole)).result).toBeDefined(); // the control: the same stream, intact
    expect((await collect(whole.replace('data: [DONE]\n\n', ''))).result).toBeUndefined();
    const errored = whole.replace('data: [DONE]', `data: {"error":{"message":"x","type":"gateway_error"}}\n\ndata: [DONE]`);
    expect((await collect(errored)).result).toBeUndefined();

    const anthropicError = await translated(createAnthropicAdapter({ version: '2023-06-01', clock }), 'anthropic-stream-error.sse');
    expect(anthropicError.result).toBeUndefined();
    const geminiError = await translated(createGeminiAdapter({ clock }), 'gemini-stream-error.sse');
    expect(geminiError.result).toBeUndefined();
  });

  it('a stream that is cut short, filtered, calls a tool, has two choices or is too big is not stored', async () => {
    const chunk = (delta: object, finish: string | null = null, index = 0) =>
      `data: ${JSON.stringify({ choices: [{ index, delta, finish_reason: finish }] })}\n\n`;
    const ok = chunk({ content: 'hi' }) + chunk({}, 'stop') + 'data: [DONE]\n\n';
    expect((await collect(ok)).result).toMatchObject({ content: 'hi', usage: null });
    expect((await collect(chunk({ content: 'hi' }) + chunk({}, 'length') + 'data: [DONE]\n\n')).result).toMatchObject({ finishReason: 'length' });
    expect((await collect(chunk({ content: 'hi' }) + chunk({}, 'content_filter') + 'data: [DONE]\n\n')).result).toBeUndefined();
    expect((await collect(chunk({ content: 'hi' }) + 'data: [DONE]\n\n')).result).toBeUndefined(); // no finish reason
    expect((await collect(chunk({ tool_calls: [{ index: 0 }] }) + chunk({}, 'stop') + 'data: [DONE]\n\n')).result).toBeUndefined();
    expect((await collect(chunk({ content: 'a' }) + chunk({ content: 'b' }, null, 1) + chunk({}, 'stop') + 'data: [DONE]\n\n')).result).toBeUndefined();
    expect((await collect('data: not json\n\n' + ok)).result).toBeUndefined();
    // A refusal, or nothing at all, is not an answer worth keeping.
    expect((await collect(chunk({ refusal: 'I cannot help with that.' }) + chunk({}, 'stop') + 'data: [DONE]\n\n')).result).toBeUndefined();
    expect((await collect(chunk({ content: 'hi', refusal: 'no' }) + chunk({}, 'stop') + 'data: [DONE]\n\n')).result).toBeUndefined();
    expect((await collect(chunk({ role: 'assistant', content: '' }) + chunk({}, 'stop') + 'data: [DONE]\n\n')).result).toBeUndefined();
    expect((await collect(chunk({ content: 'hi', refusal: null }) + chunk({}, 'stop') + 'data: [DONE]\n\n')).result).toMatchObject({ content: 'hi' });
    const small = new StreamCollector(3);
    await run(small, Buffer.from(chunk({ content: 'ab' }) + chunk({ content: 'cd' }) + chunk({}, 'stop') + 'data: [DONE]\n\n'));
    expect(small.complete()).toBeUndefined();
  });
});

describe('completion from a non-streamed body', () => {
  const body = (over: Record<string, unknown> = {}) =>
    Buffer.from(
      JSON.stringify({
        choices: [{ index: 0, message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
        ...over,
      }),
    );

  it('keeps text, finish reason and usage', () => {
    expect(completionFromBody(body())).toEqual({ content: 'hi', finishReason: 'stop', usage: { promptTokens: 3, completionTokens: 1, totalTokens: 4 } });
    expect(completionFromBody(body({ usage: undefined }))).toMatchObject({ usage: null });
    expect(completionFromBody(fixture('openai-chat.json'))).toMatchObject({ finishReason: 'stop' });
  });

  it('refuses what is not a plain finished answer', () => {
    const choice = (message: object, finish_reason: unknown = 'stop') => ({ choices: [{ index: 0, message, finish_reason }] });
    expect(completionFromBody(body(choice({ role: 'assistant', content: null, tool_calls: [{}] })))).toBeUndefined();
    expect(completionFromBody(body(choice({ role: 'assistant', content: 'x', tool_calls: [{}] })))).toBeUndefined();
    expect(completionFromBody(body(choice({ role: 'assistant', content: 'x' }, 'content_filter')))).toBeUndefined();
    expect(completionFromBody(body(choice({ role: 'assistant', content: 'x' }, null)))).toBeUndefined();
    expect(completionFromBody(body(choice({ role: 'assistant', content: null, refusal: 'I cannot help with that.' })))).toBeUndefined();
    expect(completionFromBody(body(choice({ role: 'assistant', content: 'x', refusal: 'no' })))).toBeUndefined();
    expect(completionFromBody(body(choice({ role: 'assistant', content: '' })))).toBeUndefined();
    expect(completionFromBody(body(choice({ role: 'assistant', content: 'x', refusal: null })))).toMatchObject({ content: 'x' });
    expect(completionFromBody(body({ choices: [] }))).toBeUndefined();
    const two = { index: 0, message: { role: 'assistant', content: 'x' }, finish_reason: 'stop' };
    expect(completionFromBody(body({ choices: [two, two] }))).toBeUndefined();
    expect(completionFromBody(Buffer.from('{"error":{"message":"x"}}'))).toBeUndefined();
    expect(completionFromBody(Buffer.from('not json'))).toBeUndefined();
  });
});
