import { describe, expect, it } from 'vitest';
import { DEFAULT_MODEL_ROUTES, parseModelRoutes, routeModel } from './router.ts';

const routes = (raw = DEFAULT_MODEL_ROUTES) => {
  const r = parseModelRoutes(raw);
  if (typeof r === 'string') throw new Error(r);
  return r;
};

describe('model router', () => {
  it('longest prefix wins', () => {
    const r = routes();
    expect(routeModel(r, 'mock-anthropic-1')).toBe('mock-anthropic');
    expect(routeModel(r, 'mock-gemini-1')).toBe('mock-gemini');
    expect(routeModel(r, 'mock-openai-1')).toBe('mock-openai');
    expect(routeModel(r, 'mock-x')).toBe('mock-openai');
    expect(routeModel(r, 'claude-haiku-5-5')).toBe('anthropic');
    expect(routeModel(r, 'gpt-5-nano')).toBe('openai');
    expect(routeModel(r, 'o3-mini')).toBe('openai');
    expect(routeModel(r, 'gemini-3.1-pro-preview')).toBe('gemini');
    // Entry order does not matter, only length.
    expect(routeModel(routes('a=openai,ab=gemini,abc=anthropic'), 'abcd')).toBe('anthropic');
    expect(routeModel(routes('abc=anthropic,a=openai'), 'abx')).toBe('openai');
  });

  it('unknown model returns no route (the gateway answers 400 model_not_found)', () => {
    expect(routeModel(routes(), 'llama-3')).toBeUndefined();
    expect(routeModel(routes(), '')).toBeUndefined();
    expect(routeModel(routes(), 'Claude-x')).toBeUndefined(); // prefixes are case-sensitive
  });

  it('a malformed route list is described, not accepted', () => {
    expect(parseModelRoutes('=openai')).toMatch(/model prefix/);
    expect(parseModelRoutes('gpt-')).toMatch(/model prefix/);
    expect(parseModelRoutes('gpt-=nope')).toMatch(/unknown provider "nope"/);
    expect(parseModelRoutes(' , ')).toMatch(/at least one/);
  });
});
