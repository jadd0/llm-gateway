import type { FastifyRequest } from 'fastify';

export type JsonBody = { ok: true; value: unknown } | { ok: false };

const parsed = new WeakMap<FastifyRequest, JsonBody>();

// The route keeps the request body as raw bytes (they are forwarded untouched). The rate limiter and
// the route both need the parsed JSON, so it is parsed once per request and shared.
export function jsonBody(request: FastifyRequest): JsonBody {
  let result = parsed.get(request);
  if (result === undefined) {
    try {
      result = { ok: true, value: JSON.parse((request.body as Buffer).toString('utf8')) };
    } catch {
      result = { ok: false };
    }
    parsed.set(request, result);
  }
  return result;
}
