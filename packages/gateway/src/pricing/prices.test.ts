import { describe, expect, it } from 'vitest';
import { costMicros, defaultMaxTokensFor, formatUsd, parseUsd, priceFor, REAL_PRICES } from './prices.ts';

describe('prices', () => {
  const mock = priceFor('mock-model')!;

  it('prices every mock-* model and no other', () => {
    expect(mock).toEqual({ inPerMillion: 1_000_000, outPerMillion: 3_000_000 });
    expect(priceFor('mock-anything')).toEqual(mock);
    expect(priceFor('gpt-4o')).toBeUndefined();
    expect(priceFor('')).toBeUndefined();
    expect(priceFor('toString')).toBeUndefined();
  });

  it('every real model has a price in micro-USD, a read date and a source page', () => {
    const names = Object.keys(REAL_PRICES).sort();
    expect(names).toEqual(
      ['claude-fable-5-1', 'claude-haiku-5-5', 'gemini-3.1-flash-lite', 'gemini-3.1-pro-preview', 'gpt-5-nano', 'gpt-6-astra'],
    );
    for (const name of names) {
      const r = REAL_PRICES[name]!;
      expect(Number.isInteger(r.inPerMillion) && r.inPerMillion > 0, name).toBe(true);
      expect(Number.isInteger(r.outPerMillion) && r.outPerMillion > 0, name).toBe(true);
      expect(r.asOf, name).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(r.source, name).toMatch(/^https:\/\//);
      expect(priceFor(name), name).toBe(r);
    }
    expect(priceFor('claude-haiku-5-5')).toMatchObject({ inPerMillion: 100_000, outPerMillion: 500_000 });
  });

  it('long prompt priced at the long-context tier', () => {
    const haiku = priceFor('claude-haiku-5-5')!;
    // At the threshold the short rates apply; one token over, both sides pay the long-context rates.
    expect(costMicros(haiku, 100_000, 1_000_000)).toBe(10_000 + 500_000);
    expect(costMicros(haiku, 100_001, 1_000_000)).toBe(Math.ceil((100_001 * 500_000) / 1_000_000) + 2_500_000);
    const astra = priceFor('gpt-6-astra')!;
    expect(costMicros(astra, 272_000, 0)).toBe(2_720_000);
    expect(costMicros(astra, 272_001, 1_000_000)).toBe(Math.ceil((272_001 * 20_000_000) / 1_000_000) + 75_000_000);
    const gemini = priceFor('gemini-3.1-pro-preview')!;
    expect(costMicros(gemini, 200_001, 1_000_000)).toBe(Math.ceil((200_001 * 4_000_000) / 1_000_000) + 18_000_000);
    // A model with no tier on its pricing page is priced flat at any length.
    const nano = priceFor('gpt-5-nano')!;
    expect(nano.longContext).toBeUndefined();
    expect(costMicros(nano, 1_000_000, 0)).toBe(50_000);
  });

  it('every tier row has a source URL and date', () => {
    const tiered = Object.entries(REAL_PRICES).filter(([, r]) => r.longContext !== undefined);
    expect(tiered.map(([n]) => n).sort()).toEqual(['claude-haiku-5-5', 'gemini-3.1-pro-preview', 'gpt-6-astra']);
    for (const [name, r] of tiered) {
      const t = r.longContext!;
      expect(Number.isInteger(t.threshold) && t.threshold > 0, name).toBe(true);
      expect(Number.isInteger(t.inPerMillion) && t.inPerMillion > r.inPerMillion, name).toBe(true);
      expect(Number.isInteger(t.outPerMillion) && t.outPerMillion > r.outPerMillion, name).toBe(true);
      expect(r.source, name).toMatch(/^https:\/\//);
      expect(r.asOf, name).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });

  it('default output cap comes from the model row, else the fallback', () => {
    expect(defaultMaxTokensFor('claude-fable-5-1', 1024)).toBe(4096);
    expect(defaultMaxTokensFor('gemini-3.1-flash-lite', 1024)).toBe(1024);
    expect(defaultMaxTokensFor('mock-x', 77)).toBe(77);
    expect(defaultMaxTokensFor('unknown-model', 77)).toBe(77);
  });

  it('cost rounds up in micro-USD', () => {
    expect(costMicros(mock, 0, 0)).toBe(0);
    // 1 prompt token = 1 micro-USD exactly; 1 completion token = 3.
    expect(costMicros(mock, 1, 0)).toBe(1);
    expect(costMicros(mock, 0, 1)).toBe(3);
    // A price that does not divide evenly rounds each side up, never down.
    const odd = { inPerMillion: 1, outPerMillion: 1 };
    expect(costMicros(odd, 1, 0)).toBe(1);
    expect(costMicros(odd, 1, 1)).toBe(2);
    expect(costMicros(odd, 1_000_001, 0)).toBe(2);
    expect(costMicros(mock, 1024, 1024)).toBe(1024 + 3072);
  });

  it('formats and parses USD without floats', () => {
    expect(formatUsd(10_000)).toBe('0.010000');
    expect(formatUsd(12_345_678)).toBe('12.345678');
    expect(formatUsd(-5)).toBe('0.000000');
    expect(parseUsd('0.01')).toBe(10_000);
    expect(parseUsd('10')).toBe(10_000_000);
    expect(parseUsd('0.000001')).toBe(1);
    expect(parseUsd('1.5')).toBe(1_500_000);
    for (const bad of ['', '-1', '1e3', '0.0000001', '1,5', ' 1', '.5', 'abc']) {
      expect(parseUsd(bad), bad).toBeUndefined();
    }
  });
});
