import type { FastifyPluginAsync } from 'fastify';
import { errorBody } from '../errors.ts';
import { bearerToken, hashKey, looksLikeKey } from './keys.ts';
import type { IpLimiter } from './ip-limit.ts';
import type { KeyStore, Tenant } from './key-store.ts';

declare module 'fastify' {
  interface FastifyRequest {
    /** The tenant the request's API key belongs to. Set by the auth hook on every request that reaches a handler. */
    tenant: Tenant | null;
  }
}

export interface AuthOptions {
  keyStore: KeyStore;
  pepper: string;
  /** Pre-auth limit on failed authentications per client address. Absent: no such limit. */
  ipLimiter?: IpLimiter;
}

// One message for every failure (missing, malformed, unknown, revoked) so the response says nothing
// about which keys exist.
const unauthorized = () =>
  errorBody(
    'Incorrect API key provided. Pass a valid key as "Authorization: Bearer <key>".',
    'invalid_request_error',
    'invalid_api_key',
  );

const authPlugin: FastifyPluginAsync<AuthOptions> = async (app, opts) => {
  app.decorateRequest('tenant', null);
  // onRequest runs before the body is read or parsed, so an unauthenticated caller costs one lookup
  // and nothing else. It also covers unknown routes, which therefore answer 401 rather than 404.
  // With an address limiter, an address whose bucket is empty is refused before any lookup, and each failed
  // authentication takes a token from it: only failures count, so a valid key is never charged.
  // request.ip honours X-Forwarded-For only from trusted proxies.
  app.addHook('onRequest', async (request, reply) => {
    const limiter = opts.ipLimiter;
    if (limiter) {
      const admit = await limiter.admit(request.ip);
      if (admit.status === 'denied') {
        const seconds = Math.max(1, Math.ceil(admit.retryAfterMs / 1000));
        return reply
          .code(429)
          .header('retry-after', seconds)
          .send(
            errorBody(
              `Too many failed authentication attempts from this address. Try again in ${seconds}s.`,
              'rate_limit_exceeded',
              'auth_rate_limit_exceeded',
            ),
          );
      }
    }
    const token = bearerToken(request.headers.authorization);
    const reject = async () => {
      if (limiter) await limiter.failed(request.ip);
      return reply.code(401).send(unauthorized());
    };
    if (token === undefined || !looksLikeKey(token)) return reject();
    const tenant = await opts.keyStore.lookup(hashKey(opts.pepper, token));
    if (tenant === null) return reject();
    request.tenant = tenant;
  });
};

// Same effect as fastify-plugin: the hook applies to every route in the app, not only to routes
// registered inside this plugin's own scope.
export const auth = Object.assign(authPlugin, { [Symbol.for('skip-override')]: true });
