import type { FastifyPluginAsync } from 'fastify';
import { errorBody } from '../errors.ts';
import { bearerToken, hashKey, looksLikeKey } from './keys.ts';
import type { IpLimiter } from './ip-limit.ts';
import { LookupRefused, type KeyStore, type Tenant } from './key-store.ts';

declare module 'fastify' {
  interface FastifyRequest {
    /** The tenant the request's API key belongs to. Set by the auth hook on every request that reaches a handler. */
    tenant: Tenant | null;
  }
}

export interface AuthOptions {
  keyStore: KeyStore;
  pepper: string;
  /** Charges requests that fail before any key lookup (no or malformed key). Absent: no such limit. */
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
  // With an address limiter, every failed authentication takes a token from its address's bucket. The
  // check sits on the key-cache-miss path only (inside the key store, ahead of Postgres): a valid cached
  // key never touches the bucket and cannot be refused. request.ip honours X-Forwarded-For only from
  // trusted proxies.
  app.addHook('onRequest', async (request, reply) => {
    const refuse = (retryAfterMs: number) => {
      const seconds = Math.max(1, Math.ceil(retryAfterMs / 1000));
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
    };
    const token = bearerToken(request.headers.authorization);
    if (token === undefined || !looksLikeKey(token)) {
      // Never reaches the key store, so the failure is charged here.
      const g = opts.ipLimiter ? await opts.ipLimiter.take(request.ip) : undefined;
      if (g?.refused) return refuse(g.retryAfterMs);
      return reply.code(401).send(unauthorized());
    }
    let tenant: Tenant | null;
    try {
      tenant = await opts.keyStore.lookup(hashKey(opts.pepper, token), request.ip);
    } catch (err) {
      if (err instanceof LookupRefused) return refuse(err.retryAfterMs);
      throw err;
    }
    if (tenant === null) return reply.code(401).send(unauthorized());
    request.tenant = tenant;
  });
};

// Same effect as fastify-plugin: the hook applies to every route in the app, not only to routes
// registered inside this plugin's own scope.
export const auth = Object.assign(authPlugin, { [Symbol.for('skip-override')]: true });
