import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { Transform, type Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { errorBody } from '../errors.ts';
import { chatRequest, type ChatBody } from '../request-body.ts';
import { usageSettler, type UsageSettler } from '../usage/settle.ts';
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

function upstreamFailure(reply: FastifyReply, err: unknown, refund: UsageSettler | null): FastifyReply {
  // `refund` is passed only when the provider did no work (no 2xx was received): then everything held up
  // front goes back. A 2xx whose body broke passes null, because the provider did generate it.
  refund?.refund();
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
// up-front charges. The body is changed as little as possible:
//   - the client already asked: forwarded untouched, usage read;
//   - no stream_options: the option is spliced in after the opening brace, so nothing else in the bytes
//     moves (no JSON round trip, big integers keep their precision); the usage-only chunk the client
//     did not ask for is stripped from what it receives;
//   - stream_options with include_usage not true: rewritten through JSON, usage chunk stripped;
//   - stream_options of any other shape: forwarded untouched and not reconciled (the estimate stays).
function forwardBody(parsed: ChatBody, raw: Buffer, metered: boolean): { body: Buffer; tap: Tap } {
  if (!metered || parsed.stream !== true) return { body: raw, tap: 'none' };
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

// Sits last in a streamed answer's pipeline. When the call's total deadline passes it replaces the rest
// of the answer with one OpenAI-shaped error event and ends the stream.
class DeadlineGuard extends Transform {
  #cut = false;
  override _transform(chunk: Buffer, _enc: BufferEncoding, done: (err?: Error | null, data?: Buffer) => void) {
    if (this.#cut) done();
    else done(null, chunk);
  }
  cutWith(event: string) {
    if (this.#cut) return;
    this.#cut = true;
    // A blank line first closes any event the cut interrupted.
    this.push(`\n\n${event}`);
    this.push(null);
  }
}

const maxDurationEvent = `data: ${JSON.stringify({
  error: { message: 'upstream call exceeded the maximum duration', type: 'gateway_error', code: 'upstream_max_duration' },
})}\n\n`;

export const chatRoutes: FastifyPluginAsync<{ upstream: Upstream; maxDurationMs: number }> = async (app, opts) => {
  const { upstream, maxDurationMs } = opts;

  // Keep the original bytes so the upstream receives exactly what the client sent.
  app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (_req, body, done) =>
    done(null, body),
  );

  app.post('/v1/chat/completions', { config: { rateLimited: true, budgeted: true } }, async (request, reply) => {
    // Every way out of the handler ends the request's up-front charges. keep() is last and counts only
    // if nothing above it (used, refund) already did: it is the case of no usage seen.
    const settle = usageSettler(request);
    const timers: { deadline?: NodeJS.Timeout } = {};
    try {
      return await handleChat(request, reply, settle, timers);
    } finally {
      clearTimeout(timers.deadline);
      settle.keep();
    }
  });

  async function handleChat(
    request: FastifyRequest,
    reply: FastifyReply,
    settle: UsageSettler,
    timers: { deadline?: NodeJS.Timeout },
  ) {
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
    // Usage is needed only when something was charged up front (either plugin may be off).
    const metered = (request.rateLimit ?? null) !== null || (request.budget ?? null) !== null;
    const rawBody = request.body as Buffer;
    const forward = forwardBody(parsed, rawBody, metered);
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

    // A client that left before anything was sent upstream cost the provider nothing: everything held goes
    // back. After dispatch the provider may bill, so the estimate stays (the catch blocks below).
    if (abort.signal.aborted || request.raw.socket.destroyed) {
      settle.refund();
      return reply;
    }

    const dispatched = performance.now();
    // The deadline for the whole call. UPSTREAM_TIMEOUT_MS only limits silence, so without this a slow
    // answer could outlive the budget hold that covers it.
    let deadlineHit = false;
    let guard: DeadlineGuard | undefined;
    timers.deadline = setTimeout(() => {
      deadlineHit = true;
      if (guard) {
        guard.cutWith(maxDurationEvent);
        reply.raw.once('finish', () => abort.abort());
      } else {
        abort.abort();
      }
    }, maxDurationMs);
    const tooLong = () =>
      reply.code(504).send(errorBody('upstream call exceeded the maximum duration', 'gateway_error', 'upstream_max_duration'));
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
      if (deadlineHit) return tooLong(); // the estimate stays: the provider may have worked
      if (abort.signal.aborted) return reply; // client already gone
      return upstreamFailure(reply, err, settle);
    }

    // The provider refused or failed before any answer reached the client: nothing was used.
    if (res.statusCode >= 300) settle.refund();

    const extraHeaders = passthroughHeaders(res.headers, request.rateLimit != null);
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
      guard = new DeadlineGuard();
      try {
        if (metered && res.statusCode < 300 && forward.tap !== 'none') {
          // Once bytes are flowing a failure keeps the estimate charged: tokens were partly used.
          const tap = new SseUsageTap(
            (usage) => {
              if (usage) settle.used(usage);
            },
            { stripUsageChunk: forward.tap === 'strip' },
          );
          await pipeline(res.body, tap, guard, reply.raw);
        } else {
          await pipeline(res.body, guard, reply.raw);
        }
      } catch (err) {
        // Upstream died or the client left mid-stream; pipeline already destroyed both ends.
        if (!clientGone && !deadlineHit) {
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
      if (deadlineHit) return tooLong();
      if (abort.signal.aborted) return reply;
      // The provider answered 2xx and the body then broke: it did the work, so the estimate stays (as for a
      // stream that fails after bytes were sent). A non-2xx answer was already refunded above.
      return upstreamFailure(reply, err, null);
    }
    const received = performance.now();
    if (metered && res.statusCode < 300) {
      const usage = usageFromBody(payload);
      if (usage) settle.used(usage);
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
  }
};
