import { describe, expect, it } from 'vitest';
import { openaiEvents } from '../providers/test-support.ts';
import { pieces, replayBody, replayStream, type CachedCompletion } from './replay.ts';

const who = { id: 'chatcmpl-cache-fixed', created: 1_700_000_000 };
const entry: CachedCompletion = {
  content: 'Hello there, this is a stored answer.',
  finishReason: 'stop',
  usage: { promptTokens: 9, completionTokens: 7, totalTokens: 16 },
  model: 'mock-1',
};

describe('replay', () => {
  it('stored completion replays as a non-streamed body', () => {
    expect(replayBody(entry, who)).toEqual({
      id: 'chatcmpl-cache-fixed',
      object: 'chat.completion',
      created: 1_700_000_000,
      model: 'mock-1',
      choices: [{ index: 0, message: { role: 'assistant', content: entry.content }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 9, completion_tokens: 7, total_tokens: 16 },
    });
    expect('usage' in replayBody({ ...entry, usage: null }, who)).toBe(false);
  });

  it('replays as SSE chunks ending in [DONE] with usage only when asked', () => {
    const withUsage = openaiEvents(replayStream(entry, who, { chunkChars: 10, includeUsage: true }));
    expect(withUsage.at(-1)).toBe('[DONE]');
    const chunks = withUsage.slice(0, -1);
    expect(chunks[0].choices[0].delta).toEqual({ role: 'assistant', content: '' });
    const content = chunks.slice(1, -2).map((c) => c.choices[0].delta.content);
    expect(content).toEqual(['Hello ther', 'e, this is', ' a stored ', 'answer.']);
    expect(chunks.at(-2).choices[0]).toEqual({ index: 0, delta: {}, finish_reason: 'stop' });
    expect(chunks.at(-1)).toMatchObject({ choices: [], usage: { prompt_tokens: 9, completion_tokens: 7, total_tokens: 16 } });
    for (const c of chunks) expect(c).toMatchObject({ id: who.id, object: 'chat.completion.chunk', created: who.created, model: 'mock-1' });

    const without = openaiEvents(replayStream(entry, who, { chunkChars: 10, includeUsage: false }));
    expect(without).toHaveLength(withUsage.length - 1);
    expect(without.some((e) => e !== '[DONE]' && 'usage' in e)).toBe(false);
    // Asked for, but the first answer carried none: nothing to send.
    expect(openaiEvents(replayStream({ ...entry, usage: null }, who, { chunkChars: 10, includeUsage: true }))).toHaveLength(without.length);
  });

  it('an empty answer is a role chunk, a finish chunk and [DONE]', () => {
    const events = openaiEvents(replayStream({ ...entry, content: '', finishReason: 'length' }, who, { chunkChars: 4, includeUsage: false }));
    expect(events).toHaveLength(3);
    expect(events[1].choices[0].finish_reason).toBe('length');
  });

  it('Arabic and emoji survive replay chunking', () => {
    const text = 'مرحبا 👋🏽 سلام, 你好 👨‍👩‍👧 end';
    for (const size of [1, 2, 3, 5, 64]) {
      const events = openaiEvents(replayStream({ ...entry, content: text }, who, { chunkChars: size, includeUsage: false }));
      const parts = events.slice(1, -2).map((c) => c.choices[0].delta.content as string);
      expect(parts.join(''), `size ${size}`).toBe(text);
      // No piece holds half of a surrogate pair.
      for (const p of parts) expect(p.isWellFormed(), `size ${size}`).toBe(true);
    }
    expect(pieces('', 4)).toEqual([]);
  });
});
