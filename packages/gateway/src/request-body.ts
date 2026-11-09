import type { FastifyRequest } from 'fastify';
import { z } from 'zod';

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

// Only the shape the gateway needs; every other field is forwarded untouched.
export const chatBody = z.looseObject({
  model: z.string(),
  messages: z.array(z.unknown()),
  stream: z.boolean().optional(),
});

export type ChatBody = z.infer<typeof chatBody>;

export type ChatRequest = { ok: true; value: ChatBody } | { ok: false; reason: 'json' | 'shape' };

const shaped = new WeakMap<FastifyRequest, ChatRequest>();

// The request as the chat route will accept it. The rate limiter asks the same question before it
// charges, so a body the route is going to reject with a 400 costs nothing.
export function chatRequest(request: FastifyRequest): ChatRequest {
  let result = shaped.get(request);
  if (result === undefined) {
    const json = jsonBody(request);
    if (!json.ok) result = { ok: false, reason: 'json' };
    else {
      const checked = chatBody.safeParse(json.value);
      result = checked.success ? { ok: true, value: checked.data } : { ok: false, reason: 'shape' };
    }
    shaped.set(request, result);
  }
  return result;
}
