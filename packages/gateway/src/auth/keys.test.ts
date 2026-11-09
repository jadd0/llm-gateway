import { describe, expect, it } from 'vitest';
import { bearerToken, generateKey, hashKey, keyPrefix, looksLikeKey } from './keys.ts';

describe('api keys', () => {
  it('generated keys are gw_-prefixed, 43+ chars and unique across 10k draws', () => {
    const keys = Array.from({ length: 10_000 }, generateKey);
    expect(keys).toHaveLength(10_000);
    expect(keys.every((k) => k.startsWith('gw_') && k.length >= 46 && looksLikeKey(k))).toBe(true);
    expect(new Set(keys).size).toBe(10_000);
    expect(keyPrefix(keys[0]!)).toBe(keys[0]!.slice(0, 12));
  });

  it('hash is deterministic per pepper and differs across peppers', () => {
    const key = generateKey();
    const pepperA = 'a'.repeat(32);
    const pepperB = 'b'.repeat(32);
    expect(hashKey(pepperA, key)).toBe(hashKey(pepperA, key));
    expect(hashKey(pepperA, key)).not.toBe(hashKey(pepperB, key));
    expect(hashKey(pepperA, key)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashKey(pepperA, key)).not.toContain(key);
    expect(hashKey(pepperA, key)).not.toBe(hashKey(pepperA, generateKey()));
  });

  it('only a well-formed Bearer header yields a token', () => {
    expect(bearerToken('Bearer abc')).toBe('abc');
    expect(bearerToken('bearer abc')).toBe('abc');
    for (const bad of [undefined, '', 'Bearer', 'Bearer ', 'Basic abc', 'abc', 'Bearer a b']) {
      expect(bearerToken(bad)).toBeUndefined();
    }
  });
});
