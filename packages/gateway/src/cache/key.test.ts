import { describe, expect, it } from 'vitest';
import { KEY_VERSION, cacheKey, isCacheable, normalise, scopeOf } from './key.ts';

const MAX = 1024;
const base = { model: 'mock-1', temperature: 0, messages: [{ role: 'user', content: 'hello' }] };
// MAX stands for a provider that injects its default limit (Anthropic, Gemini); null for OpenAI-format pass-through.
const keyOf = (body: Record<string, unknown>, scope = 'tenant-a', injected: number | null = MAX) => cacheKey('p:', scope, normalise(body, injected));

describe('cache key', () => {
  it('string and single text part give the same key', () => {
    const asParts = { ...base, messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }] };
    expect(keyOf(asParts)).toBe(keyOf(base));
    // Two parts are not one string: the provider may treat them differently.
    const two = { ...base, messages: [{ role: 'user', content: [{ type: 'text', text: 'hel' }, { type: 'text', text: 'lo' }] }] };
    expect(keyOf(two)).not.toBe(keyOf(base));
  });

  it('the key carries the version of the rules that made it', () => {
    expect(KEY_VERSION).toBe('v2');
    expect(keyOf(base)).toContain(':cache:v2:');
  });

  it('field order does not change the key', () => {
    const reordered = { messages: [{ content: 'hello', role: 'user' }], temperature: 0, model: 'mock-1' };
    expect(keyOf(reordered)).toBe(keyOf(base));
    expect(keyOf({ ...base, response_format: { type: 'json_schema', json_schema: { a: 1, b: 2 } } })).toBe(
      keyOf({ ...base, response_format: { json_schema: { b: 2, a: 1 }, type: 'json_schema' } }),
    );
  });

  it('stream flag does not change the key', () => {
    expect(keyOf({ ...base, stream: true, stream_options: { include_usage: true } })).toBe(keyOf({ ...base, stream: false }));
    expect(keyOf({ ...base, stream: true })).toBe(keyOf(base));
  });

  it('user and metadata do not change the key', () => {
    expect(keyOf({ ...base, user: 'u1', metadata: { a: 1 }, service_tier: 'flex', store: true })).toBe(keyOf(base));
  });

  it('differences that change the answer change the key', () => {
    const k = keyOf(base);
    const variants: Record<string, unknown>[] = [
      { ...base, model: 'mock-2' },
      { ...base, messages: [{ role: 'user', content: 'hellp' }] },
      { ...base, messages: [{ role: 'user', name: 'bob', content: 'hello' }] },
      { ...base, messages: [{ role: 'system', content: 'hello' }] },
      { ...base, top_p: 0.5 },
      { ...base, seed: 7 },
      { ...base, stop: 'x' },
      { ...base, max_tokens: 10 },
      { ...base, presence_penalty: 0.5 },
      { ...base, logit_bias: { 5: 1 } },
      { ...base, response_format: { type: 'json_object' } },
    ];
    const keys = variants.map((v) => keyOf(v));
    expect(new Set([k, ...keys]).size).toBe(variants.length + 1);
  });

  it('values that mean the default are the same key as leaving them out', () => {
    expect(keyOf({ ...base, stop: 'x' })).toBe(keyOf({ ...base, stop: ['x'] }));
    expect(keyOf({ ...base, max_completion_tokens: 50 })).toBe(keyOf({ ...base, max_tokens: 50 }));
    expect(keyOf({ ...base, max_tokens: MAX })).toBe(keyOf(base));
    expect(keyOf({ ...base, presence_penalty: 0, frequency_penalty: 0, n: 1, top_p: null })).toBe(keyOf(base));
    // The same number whichever way it was written in the request.
    expect(keyOf(JSON.parse('{"model":"mock-1","temperature":0.0,"messages":[{"role":"user","content":"hello"}]}'))).toBe(keyOf(base));
  });

  it('the output limit in the key is the one sent upstream', () => {
    const passthrough = (body: Record<string, unknown>) => keyOf(body, 'tenant-a', null);
    // OpenAI-format: no limit is no limit, never the gateway default; a capped request is a different request.
    expect(passthrough({ ...base, max_tokens: MAX })).not.toBe(passthrough(base));
    expect(passthrough({ ...base, max_tokens: 10 })).not.toBe(passthrough(base));
    expect(passthrough({ ...base, max_tokens: 10 })).not.toBe(passthrough({ ...base, max_tokens: 20 }));
    expect(passthrough({ ...base, max_tokens: 10 })).toBe(passthrough({ ...base, max_tokens: 10 }));
    // A translating provider is given the default when there is none, so the two are the same request there.
    expect(keyOf({ ...base, max_tokens: MAX })).toBe(keyOf(base));
    // max_tokens wins over max_completion_tokens, as the adapters read them.
    expect(keyOf({ ...base, max_tokens: 5, max_completion_tokens: 9 })).toBe(keyOf({ ...base, max_tokens: 5, max_completion_tokens: 7 }));
    expect(keyOf({ ...base, max_tokens: 5, max_completion_tokens: 9 })).not.toBe(keyOf({ ...base, max_tokens: 6, max_completion_tokens: 9 }));
  });

  it('different tenants get different keys; shared tenants share one', () => {
    const a = { tenantId: 'aaaa', cacheShared: false };
    const b = { tenantId: 'bbbb', cacheShared: false };
    expect(keyOf(base, scopeOf(a))).not.toBe(keyOf(base, scopeOf(b)));
    expect(keyOf(base, scopeOf(a))).toBe(keyOf(base, scopeOf(a)));
    expect(keyOf(base, scopeOf({ ...a, cacheShared: true }))).toBe(keyOf(base, scopeOf({ ...b, cacheShared: true })));
    // A shared tenant never lands on a private tenant's key.
    expect(keyOf(base, scopeOf({ ...a, cacheShared: true }))).not.toBe(keyOf(base, scopeOf(a)));
    expect(keyOf(base, scopeOf(a))).toMatch(/^p:cache:v2:aaaa:[0-9a-f]{64}$/);
  });
});

describe('cacheable', () => {
  const strict = { allowNondeterministic: false };
  it('temperature absent is uncacheable; 0 is cacheable; config can allow others', () => {
    expect(isCacheable(base, strict)).toEqual({ ok: true });
    const { temperature: _t, ...absent } = base;
    expect(isCacheable(absent, strict)).toMatchObject({ ok: false });
    expect(isCacheable({ ...base, temperature: 0.2 }, strict)).toMatchObject({ ok: false });
    expect(isCacheable({ ...base, temperature: '0' }, strict)).toMatchObject({ ok: false });
    expect(isCacheable(absent, { allowNondeterministic: true })).toEqual({ ok: true });
    expect(isCacheable({ ...base, temperature: 1 }, { allowNondeterministic: true })).toEqual({ ok: true });
  });

  it('tools and n>1 are uncacheable', () => {
    for (const extra of [
      { n: 2 },
      { tools: [] },
      { tool_choice: 'auto' },
      { functions: [{ name: 'f' }] },
      { function_call: 'auto' },
      { logprobs: true },
      { audio: { voice: 'x' } },
      { modalities: ['text', 'audio'] },
    ]) {
      expect(isCacheable({ ...base, ...extra }, { allowNondeterministic: true }), JSON.stringify(extra)).toMatchObject({ ok: false });
    }
    expect(isCacheable({ ...base, n: 1, tools: null, logprobs: false }, strict)).toEqual({ ok: true });
  });
});
