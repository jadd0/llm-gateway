import { describe, expect, it } from 'vitest';
import { estimateTokens } from './estimate.ts';

const msg = (content: unknown) => ({ role: 'user', content });

describe('estimateTokens', () => {
  it('estimate = prompt chars/4 + max_tokens, falling back to the default', () => {
    const body = { messages: [msg('a'.repeat(400)), msg('b'.repeat(2))] };
    expect(estimateTokens({ ...body, max_tokens: 50 }, 1024)).toBe(101 + 50); // ceil(402 / 4) + 50
    expect(estimateTokens({ ...body, max_completion_tokens: 70 }, 1024)).toBe(101 + 70);
    expect(estimateTokens({ ...body, max_tokens: 50, max_completion_tokens: 70 }, 1024)).toBe(101 + 50);
    expect(estimateTokens(body, 1024)).toBe(101 + 1024);
  });

  it('counts the text parts of content arrays and ignores anything that is not text', () => {
    const body = {
      messages: [msg([{ type: 'text', text: 'x'.repeat(40) }, { type: 'image_url', image_url: { url: 'u'.repeat(9999) } }])],
    };
    expect(estimateTokens(body, 10)).toBe(10 + 10);
  });

  it('a max_tokens that is not a positive whole number falls back to the default', () => {
    for (const bad of [0, -5, 1.5, '20', null]) {
      expect(estimateTokens({ messages: [], max_tokens: bad }, 33)).toBe(33);
    }
  });

  it('survives bodies that are not chat-shaped', () => {
    for (const odd of [null, undefined, {}, { messages: 'x' }, { messages: [null, 5, {}] }]) {
      expect(estimateTokens(odd, 7)).toBe(7);
    }
  });
});
