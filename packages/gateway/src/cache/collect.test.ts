import { describe, expect, it } from 'vitest';
import { createAnthropicAdapter } from '../providers/anthropic.ts';
import { createGeminiAdapter } from '../providers/gemini.ts';
import { clock, fixture, run } from '../providers/test-support.ts';
import { StreamCollector } from './collect.ts';

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
    const small = new StreamCollector(3);
    await run(small, Buffer.from(chunk({ content: 'ab' }) + chunk({ content: 'cd' }) + chunk({}, 'stop') + 'data: [DONE]\n\n'));
    expect(small.complete()).toBeUndefined();
  });
});
