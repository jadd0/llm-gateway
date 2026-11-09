import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { PassThrough, Transform, type Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { errorBody } from '../errors.ts';
import { chatRequest } from '../request-body.ts';
import { usageSettler, type UsageSettler } from '../usage/settle.ts';
import { SseUsageTap, usageFromBody } from '../usage/sse-usage.ts';
import { logAuthRejected, providerAuthMessage, tryJson } from '../providers/common.ts';
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

// Sits last in a streamed answer's pipeline. When the call's total deadline passes it drops the rest of the
// answer and ends the stream, with one OpenAI-shaped error event first if the answer is an event stream
// (any other kind of body is ended without adding anything to it).
class DeadlineGuard extends Transform {
  #cut = false;
  readonly #appendsEvent: boolean;
  constructor(appendsEvent: boolean) {
    super();
    this.#appendsEvent = appendsEvent;
  }
  override _transform(chunk: Buffer, _enc: BufferEncoding, done: (err?: Error | null, data?: Buffer) => void) {
    if (this.#cut) done();
    else done(null, chunk);
  }
  cutWith(event: string) {
    if (this.#cut) return;
    this.#cut = true;
    // A blank line first closes any event the cut interrupted.
    if (this.#appendsEvent) this.push(`\n\n${event}`);
    this.push(null);
  }
}

const maxDurationEvent = `data: ${JSON.stringify({
  error: { message: 'upstream call exceeded the maximum duration', type: 'gateway_error', code: 'upstream_max_duration' },
})}\n\n`;

export const chatRoutes: FastifyPluginAsync<{ upstream: Upstream; maxDurationMs: number; defaultMaxTokens: number; cutDrainMs?: number }> = async (app, opts) => {
  const { upstream, maxDurationMs, defaultMaxTokens } = opts;
  // After a cut stream's last bytes are written, a client that still hasn't taken them this long is dropped.
  const cutDrainMs = opts.cutDrainMs ?? 5000;

  // Keep the original bytes so the upstream receives exactly what the client sent.
  app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (_req, body, done) =>
    done(null, body),
  );

  app.post('/v1/chat/completions', { config: { rateLimited: true, budgeted: true } }, async (request, reply) => {
    // Every way out of the handler ends the request's up-front charges. keep() is last and counts only
    // if nothing above it (used, refund) already did: it is the case of no usage seen.
    const settle = usageSettler(request);
    const timers: { deadline?: NodeJS.Timeout; drain?: NodeJS.Timeout } = {};
    try {
      return await handleChat(request, reply, settle, timers);
    } finally {
      clearTimeout(timers.deadline);
      clearTimeout(timers.drain);
      settle.keep();
    }
  });

  async function handleChat(
    request: FastifyRequest,
    reply: FastifyReply,
    settle: UsageSettler,
    timers: { deadline?: NodeJS.Timeout; drain?: NodeJS.Timeout },
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

    // Nothing has gone upstream yet, so a request refused here gives back everything it was charged.
    const refuse = (status: number, message: string, code: string, param?: string) => {
      settle.refund();
      return reply.code(status).send({
        error: { message, type: status >= 500 ? 'gateway_error' : 'invalid_request_error', code, ...(param ? { param } : {}) },
      });
    };
    const target = upstream.resolve(parsed.model);
    if (!target) return refuse(400, `The model "${parsed.model}" does not exist or is not served by this gateway.`, 'model_not_found', 'model');
    if (!target.configured) return refuse(503, `The provider for "${parsed.model}" is not configured on this gateway.`, 'provider_not_configured');
    const adapter = target.adapter;
    const built = adapter.buildRequest({ body: parsed, raw: rawBody, metered, defaultMaxTokens, apiKey: target.apiKey });
    if (!built.ok) return refuse(400, built.message, 'unsupported_parameter', built.param);
    const forward = built.request;
    const includeUsage = (parsed.stream_options as { include_usage?: unknown } | null | undefined)?.include_usage === true;

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
    if (reply.raw.destroyed || request.raw.socket.destroyed) {
      settle.refund();
      return reply;
    }

    const dispatched = performance.now();
    // The deadline for the whole call. UPSTREAM_TIMEOUT_MS only limits silence, so without this a slow
    // answer could outlive the budget hold that covers it.
    let deadlineHit = false;
    let guard: DeadlineGuard | undefined;
    let relay: PassThrough | undefined;
    timers.deadline = setTimeout(() => {
      deadlineHit = true;
      // The provider may have worked and no usage will come: the estimate is charged now, not when the
      // (possibly stuck) response finishes.
      settle.keep();
      if (guard) {
        guard.cutWith(maxDurationEvent);
        abort.abort(); // the upstream goes at once; the relay below lets the response still finish cleanly
        // Nothing more may be written to the relay once it is ended (a write after end would reset the client
        // before the cut event), so the upstream is detached first.
        if (relay) upstreamStream?.unpipe(relay);
        relay?.end();
        // A client that doesn't read what is left is dropped rather than kept waiting forever.
        timers.drain = setTimeout(() => reply.raw.destroy(), cutDrainMs);
      } else {
        abort.abort();
      }
    }, maxDurationMs);
    const tooLong = () =>
      reply.code(504).send(errorBody('upstream call exceeded the maximum duration', 'gateway_error', 'upstream_max_duration'));
    let res;
    try {
      res = await target.pool.request({
        path: target.basePath + forward.path,
        method: 'POST',
        headers: forward.headers,
        body: forward.body,
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
    const translated = adapter.translates ? adapter : undefined;

    // The provider rejected the gateway's own credential. That is not the caller's doing and the provider's
    // wording is not the caller's business: they get a generic 502. The log keeps the status and the provider's
    // error code only, never its message, which can echo part of the key.
    if (res.statusCode === 401) {
      let errBody: Buffer;
      try {
        errBody = Buffer.from(await res.body.arrayBuffer());
      } catch (err) {
        if (deadlineHit) return tooLong();
        if (abort.signal.aborted) return reply;
        return upstreamFailure(reply, err, null);
      }
      const e = (tryJson(errBody) as { error?: { code?: unknown; type?: unknown; status?: unknown } } | undefined)?.error;
      const providerCode = [e?.code, e?.type, e?.status].find((v): v is string => typeof v === 'string')?.slice(0, 64);
      logAuthRejected(reply.log, target.provider, providerCode, res.statusCode);
      return reply.code(502).send(errorBody(providerAuthMessage(target.provider), 'gateway_error', 'provider_auth_failed'));
    }

    // A translated provider's error is rewritten into the OpenAI error shape, streamed request or not.
    if (translated && res.statusCode >= 300) {
      let errBody: Buffer;
      try {
        errBody = Buffer.from(await res.body.arrayBuffer());
      } catch (err) {
        if (deadlineHit) return tooLong();
        if (abort.signal.aborted) return reply;
        return upstreamFailure(reply, err, null);
      }
      const mappedError = translated.mapError(res.statusCode, errBody);
      return reply.code(mappedError.status).headers(extraHeaders).send(mappedError.body);
    }
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
        ...(translated ? { 'content-type': 'text/event-stream' } : type ? { 'content-type': type } : {}),
        'cache-control': 'no-cache',
        'x-accel-buffering': 'no',
        'server-timing': `gw-pre;dur=${ms(dispatched - started)}`,
      });
      reply.raw.flushHeaders();
      guard = new DeadlineGuard(res.statusCode < 300 && (translated !== undefined || /text\/event-stream/i.test(type ?? '')));
      // The upstream body feeds the response through a relay, so aborting the upstream at the deadline
      // doesn't tear down the response before the cut has been written.
      relay = new PassThrough();
      res.body.pipe(relay);
      res.body.on('error', (e) => {
        if (!deadlineHit) relay!.destroy(e);
      });
      // A body destroyed without an error event (a reset connection) ends the response the same way.
      res.body.on('close', () => {
        if (!upstreamDone && !deadlineHit) {
          relay!.destroy(Object.assign(new Error('Premature close'), { code: 'ERR_STREAM_PREMATURE_CLOSE' }));
        }
      });
      try {
        if (translated) {
          // Provider events are converted as they arrive; usage is reported by the translator.
          const translator = translated.streamTransform({
            includeUsage,
            log: reply.log,
            onUsage: (usage) => {
              if (metered) settle.used(usage);
            },
          });
          await pipeline(relay, translator, guard, reply.raw);
        } else if (metered && res.statusCode < 300 && forward.tap !== 'none') {
          // Once bytes are flowing a failure keeps the estimate charged: tokens were partly used.
          const tap = new SseUsageTap(
            (usage) => {
              if (usage) settle.used(usage);
            },
            { stripUsageChunk: forward.tap === 'strip' },
          );
          await pipeline(relay, tap, guard, reply.raw);
        } else {
          await pipeline(relay, guard, reply.raw);
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
    let type2 = type;
    if (translated && res.statusCode < 300) {
      try {
        const answer = translated.parseResponse(payload);
        payload = Buffer.from(JSON.stringify(answer.openaiBody));
        type2 = 'application/json';
        if (metered && answer.usage) settle.used(answer.usage);
      } catch (err) {
        // The provider answered 2xx and did the work, but its body is not one the adapter can read.
        return upstreamFailure(reply, err, null);
      }
    }
    const received = performance.now();
    if (!translated && metered && res.statusCode < 300) {
      const usage = usageFromBody(payload);
      if (usage) settle.used(usage);
    }
    const upstreamMs = received - dispatched;
    const preDispatchMs = dispatched - started;

    reply
      .code(res.statusCode)
      .headers(extraHeaders)
      .header('content-type', type2 ?? 'application/json');
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
