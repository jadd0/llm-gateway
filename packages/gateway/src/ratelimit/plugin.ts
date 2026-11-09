import type { FastifyPluginAsync, FastifyReply } from 'fastify';
import { errorBody } from '../errors.ts';
import { chatRequest } from '../request-body.ts';
import { estimateForLimit } from '../usage/estimate.ts';
import type { Buckets, Limiter } from './limiter.ts';

/** What the route needs to correct the charge once it knows the real usage. */
export interface RateLimitCharge {
  /** Tokens charged up front. */
  readonly estimate: number;
  /**
   * Corrects the token bucket to the real total. Only the first call counts. Not calling it (client
   * left, upstream failed, no usage in the answer) leaves the estimate charged.
   */
  settle(actualTotalTokens: number): Promise<void>;
}

declare module 'fastify' {
  interface FastifyRequest {
    /** Set when this request was charged to a rate-limit bucket; null otherwise (unlimited route, limiter off, Redis down). */
    rateLimit: RateLimitCharge | null;
  }
  interface FastifyContextConfig {
    /** A route opts in to rate limiting with `config: { rateLimited: true }`. */
    rateLimited?: boolean;
  }
}

export interface RateLimitOptions {
  limiter: Limiter;
  defaultRpm: number;
  defaultTpm: number;
  defaultMaxTokens: number;
}

// "6m0s", "1.5s", "20ms": the duration style OpenAI uses in its reset headers.
export function formatReset(ms: number): string {
  if (ms < 1000) return `${Math.max(0, Math.ceil(ms))}ms`;
  const totalS = Math.ceil(ms / 100) / 10;
  if (totalS < 60) return `${totalS}s`;
  const min = Math.floor(totalS / 60);
  return `${min}m${Math.round((totalS - min * 60) * 10) / 10}s`;
}

function setHeaders(reply: FastifyReply, b: Buckets): void {
  reply.header('x-ratelimit-limit-requests', b.requests.limit);
  reply.header('x-ratelimit-remaining-requests', b.requests.remaining);
  reply.header('x-ratelimit-reset-requests', formatReset(b.requests.resetMs));
  reply.header('x-ratelimit-limit-tokens', b.tokens.limit);
  reply.header('x-ratelimit-remaining-tokens', b.tokens.remaining);
  reply.header('x-ratelimit-reset-tokens', formatReset(b.tokens.resetMs));
}

const rateLimitPlugin: FastifyPluginAsync<RateLimitOptions> = async (app, opts) => {
  const { limiter } = opts;
  app.decorateRequest('rateLimit', null);

  // preHandler: after auth (so the caller is known) and after the body is read (so the cost can be
  // estimated), before the route does any upstream work.
  app.addHook('preHandler', async (request, reply) => {
    if (!request.routeOptions.config.rateLimited || request.tenant === null) return;
    // A body the route is going to reject with a 400 costs nothing: no request token, no tokens.
    const body = chatRequest(request);
    if (!body.ok) return;

    const rpm = request.tenant.rpmLimit ?? opts.defaultRpm;
    const tpm = request.tenant.tpmLimit ?? opts.defaultTpm;
    const { cost: estimate, tooLarge } = estimateForLimit(body.value, opts.defaultMaxTokens, tpm);
    // A request bigger than a whole minute's tokens can never be admitted: say so now, charge nothing.
    if (tooLarge) {
      return reply
        .code(400)
        .send(
          errorBody(
            `Request needs about ${estimate} tokens but this key allows ${tpm} per minute. Reduce the prompt or max_tokens.`,
            'invalid_request_error',
            'request_too_large',
          ),
        );
    }

    const keyId = request.tenant.keyId;
    const result = await limiter.take(keyId, rpm, tpm, estimate);
    if (result.status === 'skipped') return; // fail open
    setHeaders(reply, result.buckets);
    if (result.status === 'denied') {
      const seconds = Math.max(1, Math.ceil(result.retryAfterMs / 1000));
      return reply
        .code(429)
        .header('retry-after', seconds)
        .send(
          errorBody(
            `Rate limit reached for ${result.limited} on this API key. Try again in ${seconds}s.`,
            'rate_limit_exceeded',
            'rate_limit_exceeded',
          ),
        );
    }

    let settled = false;
    request.rateLimit = {
      estimate,
      settle: async (actual) => {
        if (settled) return;
        settled = true;
        await limiter.adjust(keyId, tpm, estimate - actual);
      },
    };
  });
};

// Same effect as fastify-plugin: the hook applies to every route in the app, not only to routes
// registered inside this plugin's own scope.
export const rateLimit = Object.assign(rateLimitPlugin, { [Symbol.for('skip-override')]: true });
