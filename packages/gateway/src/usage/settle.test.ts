import type { FastifyRequest } from 'fastify';
import { describe, expect, it } from 'vitest';
import { usageSettler } from './settle.ts';

// Fake request carrying recording stand-ins for the two consumers.
function fake() {
  const limiter: number[] = [];
  const budget: unknown[] = [];
  const request = {
    rateLimit: { estimate: 100, settle: async (n: number) => void limiter.push(n) },
    budget: { estimate: 5, settle: async (o: unknown) => void budget.push(o) },
    reqlog: { note() {} },
  } as unknown as FastifyRequest;
  return { request, limiter, budget };
}
const usage = { promptTokens: 7, completionTokens: 5, totalTokens: 12 };

describe('usageSettler', () => {
  it('used: both consumers get the reported usage', () => {
    const f = fake();
    usageSettler(f.request).used(usage);
    expect(f.limiter).toEqual([12]);
    expect(f.budget).toEqual([{ kind: 'used', usage }]);
  });

  it('refund: both give everything back', () => {
    const f = fake();
    usageSettler(f.request).refund();
    expect(f.limiter).toEqual([0]);
    expect(f.budget).toEqual([{ kind: 'refund' }]);
  });

  it('keep: the limiter keeps its estimate untouched and the budget charges its hold', () => {
    const f = fake();
    usageSettler(f.request).keep();
    expect(f.limiter).toEqual([]);
    expect(f.budget).toEqual([{ kind: 'keep' }]);
  });

  it('works when neither consumer is registered', () => {
    const request = { rateLimit: null, budget: null, reqlog: { note() {} } } as unknown as FastifyRequest;
    const s = usageSettler(request);
    expect(() => {
      s.used(usage);
      s.refund();
      s.keep();
    }).not.toThrow();
  });
});
