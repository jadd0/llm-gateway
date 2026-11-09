import { describe, expect, it } from 'vitest';
import { loadConfig } from '../config.ts';
import { chainFor, parseFallbacks } from './fallback.ts';

const env = (extra: Record<string, string>) => ({
  DATABASE_URL: 'postgres://u:p@127.0.0.1:1/db',
  REDIS_URL: 'redis://127.0.0.1:1',
  API_KEY_PEPPER: 'x'.repeat(40),
  ...extra,
});

describe('fallback chains', () => {
  it('chain parsed in order', () => {
    const chains = parseFallbacks('claude-fable-5-1>gpt-6-astra>gemini-3.1-pro-preview ; mock-openai-1>mock-anthropic-1');
    expect(chains).toEqual([
      ['claude-fable-5-1', 'gpt-6-astra', 'gemini-3.1-pro-preview'],
      ['mock-openai-1', 'mock-anthropic-1'],
    ]);
    expect(parseFallbacks('')).toEqual([]);
    expect(parseFallbacks('a')).toMatch(/at least two/);
    expect(parseFallbacks('a>')).toMatch(/empty/);
    expect(parseFallbacks('a>b>a')).toMatch(/twice/);
    expect(parseFallbacks('a>b;a>c')).toMatch(/starts two chains/);
  });

  it('model without a chain is a chain of one', () => {
    const chains = parseFallbacks('mock-openai-1>mock-anthropic-1');
    if (typeof chains === 'string') throw new Error(chains);
    expect(chainFor(chains, 'mock-openai-1')).toEqual(['mock-openai-1', 'mock-anthropic-1']);
    expect(chainFor(chains, 'mock-anthropic-1')).toEqual(['mock-anthropic-1']);
    expect(chainFor([], 'gpt-6-astra')).toEqual(['gpt-6-astra']);
  });

  it('unpriced chain model fails config load when budgets are on', () => {
    const unpriced = { MODEL_FALLBACKS: 'gpt-6-astra>gpt-unpriced-9' };
    expect(() => loadConfig(env({ ...unpriced, BUDGET_ENABLED: 'true' }))).toThrow(/gpt-unpriced-9.*no price/s);
    // Budgets off: nothing is priced, so nothing is required to be.
    expect(loadConfig(env({ ...unpriced, BUDGET_ENABLED: 'false' })).modelFallbacks).toEqual([['gpt-6-astra', 'gpt-unpriced-9']]);
    expect(loadConfig(env({ MODEL_FALLBACKS: 'gpt-6-astra>claude-haiku-5-5', BUDGET_ENABLED: 'true' })).modelFallbacks).toEqual([['gpt-6-astra', 'claude-haiku-5-5']]);
    // A model no route serves is refused whatever the budget setting.
    expect(() => loadConfig(env({ MODEL_FALLBACKS: 'gpt-6-astra>nonsense-model', BUDGET_ENABLED: 'false' }))).toThrow(/nonsense-model/);
    expect(loadConfig(env({})).modelFallbacks).toEqual([]);
  });
});
