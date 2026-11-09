import type { FastifyPluginAsync, FastifyReply } from 'fastify';
import { pipeline } from 'node:stream/promises';
import { z } from 'zod';
import type { Upstream } from '../upstream.ts';

// Only the shape the gateway needs; every other field is forwarded untouched.
const chatBody = z.looseObject({
  model: z.string(),
  messages: z.array(z.unknown()),
  stream: z.boolean().optional(),
});

const TIMEOUT_CODES = new Set([
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
  'UND_ERR_CONNECT_TIMEOUT',
]);

const errorBody = (message: string, type: string) => ({ error: { message, type } });

const ms = (n: number) => n.toFixed(3);

// Upstream headers a client needs to react to (back-off, correlation, rate-limit state).
const PASSTHROUGH = /^(retry-after|x-request-id|openai-processing-ms|x-ratelimit-.+)$/;

function passthroughHeaders(upstream: Record<string, string | string[] | undefined>) {
  const out: Record<string, string | string[]> = {};
  for (const [name, value] of Object.entries(upstream)) {
    if (value !== undefined && PASSTHROUGH.test(name)) out[name] = value;
  }
  return out;
}

function upstreamFailure(reply: FastifyReply, err: unknown): FastifyReply {
  const code = (err as { code?: string }).code ?? '';
  // Log the error class and code only; messages can carry request data.
  reply.log.warn({ errClass: (err as Error).name, code }, 'upstream request failed');
  if (TIMEOUT_CODES.has(code)) {
    return reply.code(504).send(errorBody('upstream timed out', 'gateway_error'));
  }
  return reply.code(502).send(errorBody('upstream unreachable', 'gateway_error'));
}

export const chatRoutes: FastifyPluginAsync<{ upstream: Upstream }> = async (app, opts) => {
  const { upstream } = opts;

  // Keep the original bytes so the upstream receives exactly what the client sent.
  app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (_req, body, done) =>
    done(null, body),
  );

  app.post('/v1/chat/completions', async (request, reply) => {
    const started = performance.now();

    let parsed: z.infer<typeof chatBody>;
    try {
      const result = chatBody.safeParse(JSON.parse((request.body as Buffer).toString('utf8')));
      if (!result.success) {
        return reply
          .code(400)
          .send(errorBody('body needs a string "model" and an array "messages"', 'invalid_request_error'));
      }
      parsed = result.data;
    } catch {
      return reply.code(400).send(errorBody('body is not valid JSON', 'invalid_request_error'));
    }

    const abort = new AbortController();
    // 'close' on the response fires on client disconnect, on normal completion, and when a failed
    // upstream makes pipeline() destroy the response. `upstreamError` is set first in that last
    // case, so only a close with no upstream error counts as the client leaving.
    let clientGone = false;
    let upstreamError: Error | undefined;
    reply.raw.on('close', () => {
      if (reply.raw.writableFinished) return;
      if (!upstreamError) clientGone = true;
      abort.abort();
    });

    const dispatched = performance.now();
    let res;
    try {
      res = await upstream.pool.request({
        path: upstream.chatPath,
        method: 'POST',
        headers: upstream.headers,
        body: request.body as Buffer,
        signal: abort.signal,
      });
    } catch (err) {
      if (abort.signal.aborted) return reply; // client already gone
      return upstreamFailure(reply, err);
    }

    const extraHeaders = passthroughHeaders(res.headers);
    const contentType = res.headers['content-type'];
    const type = Array.isArray(contentType) ? contentType[0] : contentType;

    if (parsed.stream === true) {
      // Hijack so Fastify neither buffers nor serialises: bytes go from the upstream socket
      // to the client socket as they arrive.
      reply.hijack();
      res.body.once('error', (err) => {
        if (!clientGone) upstreamError = err;
      });
      reply.raw.writeHead(res.statusCode, {
        ...extraHeaders,
        ...(type ? { 'content-type': type } : {}),
        'cache-control': 'no-cache',
        'x-accel-buffering': 'no',
        'server-timing': `gw-pre;dur=${ms(dispatched - started)}`,
      });
      reply.raw.flushHeaders();
      try {
        await pipeline(res.body, reply.raw);
      } catch (err) {
        // Upstream died or the client left mid-stream; pipeline already destroyed both ends.
        if (!clientGone) {
          reply.log.warn(
            { errClass: (err as Error).name, code: (err as { code?: string }).code },
            'stream terminated',
          );
        }
      }
      return reply;
    }

    let payload: Buffer;
    try {
      payload = Buffer.from(await res.body.arrayBuffer());
    } catch (err) {
      if (abort.signal.aborted) return reply;
      return upstreamFailure(reply, err);
    }
    const received = performance.now();
    const upstreamMs = received - dispatched;
    const preDispatchMs = dispatched - started;

    return reply
      .code(res.statusCode)
      .headers(extraHeaders)
      .header('content-type', type ?? 'application/json')
      .header('server-timing', `gw-pre;dur=${ms(preDispatchMs)}, upstream;dur=${ms(upstreamMs)}`)
      .send(payload);
  });
};
