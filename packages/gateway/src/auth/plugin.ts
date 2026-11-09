import type { FastifyPluginAsync } from 'fastify';
import { errorBody } from '../errors.ts';
import { bearerToken, hashKey, looksLikeKey } from './keys.ts';
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
  app.addHook('onRequest', async (request, reply) => {
    const token = bearerToken(request.headers.authorization);
    if (token === undefined || !looksLikeKey(token)) return reply.code(401).send(unauthorized());
    const tenant = await opts.keyStore.lookup(hashKey(opts.pepper, token));
    if (tenant === null) return reply.code(401).send(unauthorized());
    request.tenant = tenant;
  });
};

// Same effect as fastify-plugin: the hook applies to every route in the app, not only to routes
// registered inside this plugin's own scope.
export const auth = Object.assign(authPlugin, { [Symbol.for('skip-override')]: true });
