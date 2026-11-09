import type { FastifyRequest } from 'fastify';
import type { Usage } from './sse-usage.ts';

/**
 * How a request's up-front charges are ended. The rate limiter (tokens) and the budget (money) both
 * hold something taken before the call and correct it afterwards; this is the one place that says
 * which way, so the two can never disagree about a request:
 *
 * - used: the provider reported usage. Both charge what was really used.
 * - refund: the provider did no work (the gateway rejected the body, or upstream answered non-2xx or
 *   failed before any answer). Both give everything back.
 * - keep: the provider may have worked but no usage was seen (2xx body that broke, stream cut or
 *   client gone, no usage in the answer). Both keep the estimate. The limiter does that by doing
 *   nothing; the budget has to say so, because it records the charge.
 *
 * Each consumer ignores every call after its first, so the route may end a request with `keep()` on
 * every path and an earlier `used` or `refund` stands.
 */
export interface UsageSettler {
  used(usage: Usage): void;
  refund(): void;
  keep(): void;
}

export function usageSettler(request: FastifyRequest): UsageSettler {
  return {
    used(usage) {
      void request.rateLimit?.settle(usage.totalTokens);
      void request.budget?.settle({ kind: 'used', usage });
    },
    refund() {
      void request.rateLimit?.settle(0);
      void request.budget?.settle({ kind: 'refund' });
    },
    keep() {
      void request.budget?.settle({ kind: 'keep' });
    },
  };
}
