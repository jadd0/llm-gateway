import { describe, expect, it } from 'vitest';
import { normalise } from '../cache/key.ts';
import { splitForSemantic } from './context.ts';

const req = (over: Record<string, unknown> = {}, messages?: unknown[]) =>
  normalise(
    {
      model: 'm',
      temperature: 0,
      messages: messages ?? [
        { role: 'system', content: 'You are terse.' },
        { role: 'user', content: 'Hi' },
        { role: 'assistant', content: 'Hello' },
        { role: 'user', content: 'What is the capital of France?' },
      ],
      ...over,
    },
    null,
  );
const hash = (n: Record<string, unknown>) => splitForSemantic(n)!.contextHash;

describe('semantic context', () => {
  it('only the last user message is excluded from the context hash', () => {
    const a = splitForSemantic(req())!;
    const b = splitForSemantic(
      req({}, [
        { role: 'system', content: 'You are terse.' },
        { role: 'user', content: 'Hi' },
        { role: 'assistant', content: 'Hello' },
        { role: 'user', content: "What's France's capital?" },
      ]),
    )!;
    expect(a.text).toBe('What is the capital of France?');
    expect(b.text).toBe("What's France's capital?");
    expect(a.contextHash).toMatch(/^[0-9a-f]{64}$/);
    expect(a.contextHash).toBe(b.contextHash);
    // A single text part is the same prompt as a string (normalise folds it).
    const parts = splitForSemantic(req({}, [{ role: 'user', content: [{ type: 'text', text: 'ping' }] }]))!;
    expect(parts.text).toBe('ping');
    // The only message is the last: an empty rest, still a valid context.
    expect(splitForSemantic(req({}, [{ role: 'user', content: 'x' }]))!.contextHash).toBe(splitForSemantic(req({}, [{ role: 'user', content: 'y' }]))!.contextHash);
  });

  it('changing the system prompt, an earlier turn or a parameter changes the hash', () => {
    const base = hash(req());
    const withMessages = (...m: Array<[string, string]>) => req({}, m.map(([role, content]) => ({ role, content })));
    const variants: Array<[string, Record<string, unknown>]> = [
      ['system prompt', withMessages(['system', 'You are verbose.'], ['user', 'Hi'], ['assistant', 'Hello'], ['user', 'q'])],
      ['earlier user turn', withMessages(['system', 'You are terse.'], ['user', 'Yo'], ['assistant', 'Hello'], ['user', 'q'])],
      ['earlier assistant turn', withMessages(['system', 'You are terse.'], ['user', 'Hi'], ['assistant', 'Hey'], ['user', 'q'])],
      ['fewer turns', withMessages(['system', 'You are terse.'], ['user', 'q'])],
      ['model', req({ model: 'other' })],
      ['temperature', req({ temperature: 0.1 })],
      ['max_tokens', req({ max_tokens: 50 })],
      ['top_p', req({ top_p: 0.5 })],
      ['seed', req({ seed: 7 })],
      ['stop', req({ stop: ['x'] })],
      ['response_format', req({ response_format: { type: 'json_object' } })],
    ];
    const hashes = variants.map(([, n]) => hash(n));
    expect(hashes).toHaveLength(11);
    for (const [i, h] of hashes.entries()) expect(h, variants[i]![0]).not.toBe(base);
    expect(new Set(hashes).size).toBe(hashes.length);
    // Role and extra fields on the last message are context too.
    expect(hash(req({}, [{ role: 'user', content: 'q', name: 'alice' }]))).not.toBe(hash(req({}, [{ role: 'user', content: 'q' }])));
    // Streaming does not change the answer, so it does not change the context (normalise drops it).
    expect(hash(req({ stream: true }))).toBe(base);
  });

  it('a request with no plain-text last user message has nothing to compare', () => {
    expect(splitForSemantic(req({}, [{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }]))).toBeUndefined();
    expect(splitForSemantic(req({}, [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'x' } }] }]))).toBeUndefined();
    expect(splitForSemantic(req({}, [{ role: 'user', content: '   ' }]))).toBeUndefined();
    expect(splitForSemantic({ model: 'm' })).toBeUndefined();
    expect(splitForSemantic(req({}, []))).toBeUndefined();
  });
});
