import { describe, expect, it } from 'vitest';
import { costMicros, formatUsd, parseUsd, priceFor } from './prices.ts';

describe('prices', () => {
  const mock = priceFor('mock-model')!;

  it('prices every mock-* model and no other', () => {
    expect(mock).toEqual({ inPerMillion: 1_000_000, outPerMillion: 3_000_000 });
    expect(priceFor('mock-anything')).toEqual(mock);
    expect(priceFor('gpt-4o')).toBeUndefined();
    expect(priceFor('')).toBeUndefined();
    expect(priceFor('toString')).toBeUndefined();
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
