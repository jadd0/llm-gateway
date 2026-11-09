import type { FastifyPluginAsync, FastifyReply } from 'fastify';
import type { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { errorBody } from '../errors.ts';
import { chatRequest, type ChatBody } from '../request-body.ts';
import type { RateLimitCharge } from '../ratelimit/plugin.ts';
import { SseUsageTap, usageFromBody } from '../usage/sse-usage.ts';
import type { Upstream } from '../upstream.ts';

const TIMEOUT_CODES = new Set([
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
  'UND_ERR_CONNECT_TIMEOUT',
]);

const ms = (n: number) => n.toFixed(3);

// Upstream headers a client needs to react to (back-off, correlation, rate-limit state).
const PASSTHROUGH = /^(retry-after|x-request-id|openai-processing-ms|x-ratelimit-.+)$/;

// When the gateway has set its own x-ratelimit-* headers they describe the caller's key, so the
// upstream's (which describe the gateway's account) are dropped.
function passthroughHeaders(upstream: Record<string, string | string[] | undefined>, ownLimits: boolean) {
  const out: Record<string, string | string[]> = {};
  for (const [name, value] of Object.entries(upstream)) {
    if (ownLimits && name.startsWith('x-ratelimit-')) continue;
    if (value !== undefined && PASSTHROUGH.test(name)) out[name] = value;
  }
  return out;
}

function upstreamFailure(reply: FastifyReply, err: unknown, charge: RateLimitCharge | null): FastifyReply {
  // Nothing reached the client and the provider did no work for it: the whole estimate goes back.
  void charge?.settle(0);
  const code = (err as { code?: string }).code ?? '';
  // Log the error class and code only; messages can carry request data.
  reply.log.warn({ errClass: (err as Error).name, code }, 'upstream request failed');
  if (TIMEOUT_CODES.has(code)) {
    return reply.code(504).send(errorBody('upstream timed out', 'gateway_error'));
  }
  return reply.code(502).send(errorBody('upstream unreachable', 'gateway_error'));
}

type Tap = 'none' | 'read' | 'strip';

// What goes upstream for a request, and how the answer's usage is read. A streamed answer only carries
// token counts if the provider is asked (stream_options.include_usage), and the counts correct the
// up-front charge. The body is changed as little as possible:
//   - the client already asked: forwarded untouched, usage read;
//   - no stream_options: the option is spliced in after the opening brace, so nothing else in the bytes
//     moves (no JSON round trip, big integers keep their precision); the usage-only chunk the client
//     did not ask for is stripped from what it receives;
//   - stream_options with include_usage not true: rewritten through JSON, usage chunk stripped;
//   - stream_options of any other shape: forwarded untouched and not reconciled (the estimate stays).
function forwardBody(parsed: ChatBody, raw: Buffer, limited: boolean): { body: Buffer; tap: Tap } {
  if (!limited || parsed.stream !== true) return { body: raw, tap: 'none' };
  if (!('stream_options' in parsed)) {
    const open = raw.indexOf(0x7b);
    if (open < 0) return { body: raw, tap: 'none' };
    const splice = Buffer.from('"stream_options":{"include_usage":true},');
    return { body: Buffer.concat([raw.subarray(0, open + 1), splice, raw.subarray(open + 1)]), tap: 'strip' };
  }
  const so = parsed.stream_options;
  if (typeof so !== 'object' || so === null || Array.isArray(so)) return { body: raw, tap: 'none' };
  if ((so as { include_usage?: unknown }).include_usage === true) return { body: raw, tap: 'read' };
  return {
    body: Buffer.from(JSON.stringify({ ...parsed, stream_options: { ...so, include_usage: true } })),
    tap: 'strip',
  };
}

export const chatRoutes: FastifyPluginAsync<{ upstream: Upstream }> = async (app, opts) => {
  const { upstream } = opts;

  // Keep the original bytes so the upstream receives exactly what the client sent.
  app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (_req, body, done) =>
    done(null, body),
  );

  app.post('/v1/chat/completions', { config: { rateLimited: true } }, async (request, reply) => {
    const started = performance.now();

    const checked = chatRequest(request);
    if (!checked.ok) {
      return reply
        .code(400)
        .send(
          checked.reason === 'json'
            ? errorBody('body is not valid JSON', 'invalid_request_error')
            : errorBody('body needs a string "model" and an array "messages"', 'invalid_request_error'),
        );
    }
    const parsed = checked.value;
    // Undefined when the rate limiter is not registered at all.
    const charge = request.rateLimit ?? null;
    const rawBody = request.body as Buffer;
    const forward = forwardBody(parsed, rawBody, charge !== null);
    const upstreamBody = forward.body;

    const abort = new AbortController();
    // 'close' on the response fires on client disconnect, on normal completion, and when a failed
    // upstream makes pipeline() destroy the response. It counts as the client leaving only if the
    // upstream body is still alive (or already finished cleanly) when it fires; a body that was
    // destroyed, with or without an 'error' event, is an upstream failure.
    let clientGone = false;
    let upstreamFailed = false;
    let upstreamDone = false;
    let upstreamStream: Readable | undefined;
    reply.raw.on('close', () => {
      if (reply.raw.writableFinished) return;
      clientGone =
        !upstreamFailed && (upstreamStream === undefined || upstreamDone || !upstreamStream.destroyed);
      abort.abort();
    });

    const dispatched = performance.now();
    let res;
    try {
      res = await upstream.pool.request({
        path: upstream.chatPath,
        method: 'POST',
        headers: upstream.headers,
        body: upstreamBody,
        signal: abort.signal,
      });
    } catch (err) {
      if (abort.signal.aborted) return reply; // client already gone
      return upstreamFailure(reply, err, charge);
    }

    // The provider refused or failed before any answer reached the client: nothing was used.
    if (res.statusCode >= 300) void charge?.settle(0);

    const extraHeaders = passthroughHeaders(res.headers, charge !== null);
    const contentType = res.headers['content-type'];
    const type = Array.isArray(contentType) ? contentType[0] : contentType;

    if (parsed.stream === true) {
      // Hijack so Fastify neither buffers nor serialises: bytes go from the upstream socket
      // to the client socket as they arrive.
      reply.hijack();
      upstreamStream = res.body;
      res.body.once('end', () => {
        upstreamDone = true;
      });
      res.body.once('error', () => {
        if (!clientGone) upstreamFailed = true;
      });
      reply.raw.writeHead(res.statusCode, {
        ...(reply.getHeaders() as Record<string, string | number | string[]>), // rate-limit headers set before the route ran
        ...extraHeaders,
        ...(type ? { 'content-type': type } : {}),
        'cache-control': 'no-cache',
        'x-accel-buffering': 'no',
        'server-timing': `gw-pre;dur=${ms(dispatched - started)}`,
      });
      reply.raw.flushHeaders();
      try {
        if (charge !== null && res.statusCode < 300 && forward.tap !== 'none') {
          // Once bytes are flowing a failure keeps the estimate charged: tokens were partly used.
          const tap = new SseUsageTap(
            (usage) => {
              if (usage) void charge.settle(usage.totalTokens);
            },
            { stripUsageChunk: forward.tap === 'strip' },
          );
          await pipeline(res.body, tap, reply.raw);
        } else {
          await pipeline(res.body, reply.raw);
        }
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
      // The provider answered 2xx and the body then broke: it did the work, so the estimate stays (as for a
      // stream that fails after bytes were sent). A non-2xx answer was already refunded above.
      return upstreamFailure(reply, err, null);
    }
    const received = performance.now();
    if (charge !== null && res.statusCode < 300) {
      const usage = usageFromBody(payload);
      if (usage) void charge.settle(usage.totalTokens);
    }
    const upstreamMs = received - dispatched;
    const preDispatchMs = dispatched - started;

    reply
      .code(res.statusCode)
      .headers(extraHeaders)
      .header('content-type', type ?? 'application/json');
    // gw-post is measured last so it covers building the reply, up to the send call.
    const postReceiptMs = performance.now() - received;
    return reply
      .header(
        'server-timing',
        `gw-pre;dur=${ms(preDispatchMs)}, gw-post;dur=${ms(postReceiptMs)}, upstream;dur=${ms(upstreamMs)}`,
      )
      .send(payload);
  });
};
