import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { PassThrough, Transform, type Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import { errorBody } from '../errors.ts';
import { chatRequest } from '../request-body.ts';
import { usageSettler, type UsageSettler } from '../usage/settle.ts';
import { SseUsageTap, usageFromBody } from '../usage/sse-usage.ts';
import { logAuthRejected, providerAuthMessage, tryJson } from '../providers/common.ts';
import type { Breaker } from '../resilience/breaker.ts';
import { chainFor, type Chains } from '../resilience/fallback.ts';
import { isRetryable, planRetry, type Outcome, type RetryPolicy } from '../resilience/retry.ts';
import { phaseOf } from '../resilience/timeouts.ts';
import type { UpstreamRequest } from '../providers/types.ts';
import type { Target, Upstream } from '../upstream.ts';

const TIMEOUT_CODES = new Set([
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
  'UND_ERR_CONNECT_TIMEOUT',
]);

const ms = (n: number) => n.toFixed(3);

// Upstream headers a client needs to react to (back-off, correlation, rate-limit state, timing). Kept on
// translated and rewritten error replies too: only the body of those is the gateway's.
const PASSTHROUGH = /^(retry-after|x-request-id|request-id|openai-processing-ms|x-ratelimit-.+|anthropic-ratelimit-.+|server-timing)$/;

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

export interface ChatRouteOptions {
  upstream: Upstream;
  breaker: Breaker;
  /** Fallback chains by first model; a model with no chain is served by itself. */
  chains: Chains;
  retry: RetryPolicy;
  maxDurationMs: number;
  defaultMaxTokens: number;
  cutDrainMs?: number;
}

/** What the route remembers about one request while it runs; the handler's finally and the deadline timer read it. */
interface RequestState {
  deadline?: NodeJS.Timeout;
  drain?: NodeJS.Timeout;
  /** The model being attempted, or serving: the price the estimate is charged at if no usage is ever seen. */
  model?: string;
}

/** An attempt that ended without an answer to serve. */
type Failure =
  | { kind: 'status'; model: string; target: Target; status: number; headers: Record<string, string | string[] | undefined>; body: Buffer }
  | { kind: 'error'; model: string; err: unknown };

const asText = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

export const chatRoutes: FastifyPluginAsync<ChatRouteOptions> = async (app, opts) => {
  const { upstream, breaker, chains, retry, maxDurationMs, defaultMaxTokens } = opts;
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
    const state: RequestState = {};
    try {
      return await handleChat(request, reply, settle, state);
    } finally {
      clearTimeout(state.deadline);
      clearTimeout(state.drain);
      settle.keep(state.model);
    }
  });

  async function handleChat(request: FastifyRequest, reply: FastifyReply, settle: UsageSettler, state: RequestState) {
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
    const chain = chainFor(chains, parsed.model);
    const headTarget = upstream.resolve(parsed.model);
    if (!headTarget) return refuse(400, `The model "${parsed.model}" does not exist or is not served by this gateway.`, 'model_not_found', 'model');
    if (!headTarget.configured && chain.length === 1) return refuse(503, `The provider for "${parsed.model}" is not configured on this gateway.`, 'provider_not_configured');

    // What one attempt sends: the request as this model's provider wants it. A model other than the one asked
    // for gets the client's body with its own name in it.
    const prepare = (model: string, target: Target): { ok: true; forward: UpstreamRequest } | { ok: false; param: string; message: string } => {
      const body = model === parsed.model ? parsed : { ...parsed, model };
      const raw = model === parsed.model ? rawBody : Buffer.from(JSON.stringify(body));
      const built = target.adapter.buildRequest({ body, raw, metered, defaultMaxTokens, apiKey: target.apiKey });
      return built.ok ? { ok: true, forward: built.request } : built;
    };
    // The model asked for is checked before anything is sent: a request it cannot take is the client's to fix.
    const headPrepared = headTarget.configured ? prepare(parsed.model, headTarget) : undefined;
    if (headPrepared && !headPrepared.ok) return refuse(400, headPrepared.message, 'unsupported_parameter', headPrepared.param);
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
    // The deadline for the whole request, every attempt and backoff included. The per-attempt timeouts only
    // limit silence, so without this a slow answer could outlive the budget hold that covers it.
    let deadlineHit = false;
    let guard: DeadlineGuard | undefined;
    let relay: PassThrough | undefined;
    state.deadline = setTimeout(() => {
      deadlineHit = true;
      // The provider may have worked and no usage will come: the estimate is charged now, not when the
      // (possibly stuck) response finishes.
      settle.keep(state.model);
      if (guard) {
        guard.cutWith(maxDurationEvent);
        abort.abort(); // the upstream goes at once; the relay below lets the response still finish cleanly
        // Nothing more may be written to the relay once it is ended (a write after end would reset the client
        // before the cut event), so the upstream is detached first.
        if (relay) upstreamStream?.unpipe(relay);
        relay?.end();
        // A client that doesn't read what is left is dropped rather than kept waiting forever.
        state.drain = setTimeout(() => reply.raw.destroy(), cutDrainMs);
      } else {
        abort.abort();
      }
    }, maxDurationMs);
    const tooLong = () =>
      reply.code(504).send(errorBody('upstream call exceeded the maximum duration', 'gateway_error', 'upstream_max_duration'));
    const remainingMs = () => maxDurationMs - (performance.now() - dispatched);

    // The attempt loop. Over the chain, each model gets up to retry.maxAttempts attempts; an attempt is
    // refused outright by an open breaker, retried after a backoff when the failure says the provider (not the
    // request) was the problem, and ends the loop when it succeeds or fails in a way no other model would fix.
    // Nothing is sent to the client while this runs, so any attempt can be abandoned for another.
    let attempts = 0;
    let lastFailure: Failure | undefined;
    let soonestReopenMs: number | undefined;
    let served: { model: string; target: Target; forward: UpstreamRequest; res: Awaited<ReturnType<Target['pool']['request']>> } | undefined;

    models: for (const [index, model] of chain.entries()) {
      const target = index === 0 ? headTarget : upstream.resolve(model);
      if (!target?.configured) continue;
      const prepared = index === 0 ? headPrepared! : prepare(model, target);
      if (!prepared.ok) continue; // this model cannot take the request as sent; the next may
      const { forward } = prepared;
      let triesOnModel = 0;
      while (true) {
        if (abort.signal.aborted) break models;
        // The first attempt always runs; later ones only if there is time left to make them worth starting.
        if (attempts > 0 && remainingMs() < retry.minRemainingMs) break models;
        const acquired = await breaker.acquire(target.provider);
        if (!acquired.allowed) {
          soonestReopenMs = Math.min(soonestReopenMs ?? Infinity, acquired.retryInMs);
          continue models;
        }
        const permit = acquired.permit;
        attempts++;
        triesOnModel++;
        state.model = model;
        const attemptStarted = performance.now();

        let outcome: Outcome;
        try {
          const res = await target.pool.request({
            path: target.basePath + forward.path,
            method: 'POST',
            headers: forward.headers,
            body: forward.body,
            signal: abort.signal,
          });
          if (res.statusCode < 300) {
            void breaker.record(permit, 'success');
            reply.log.info({ model, target: target.provider, outcome: res.statusCode, ms: ms(performance.now() - attemptStarted) }, 'upstream attempt');
            served = { model, target, forward, res };
            break models;
          }
          // The provider's own error answer: kept (read in full, which also frees the socket) in case it is
          // the one the client gets.
          let body: Buffer;
          try {
            body = Buffer.from(await res.body.arrayBuffer());
          } catch (err) {
            if (abort.signal.aborted) {
              void breaker.record(permit, 'abandoned');
              break models;
            }
            // The status alone decides what happens next; the client gets the answer without its body.
            reply.log.warn({ errClass: (err as Error).name, code: (err as { code?: string }).code }, 'upstream error body unreadable');
            body = Buffer.alloc(0);
          }
          outcome = { kind: 'status', status: res.statusCode };
          lastFailure = { kind: 'status', model, target, status: res.statusCode, headers: res.headers, body };
          // A status the caller caused (400, 404...) says the provider is alive; it is not a failure of it.
          await breaker.record(permit, isRetryable(outcome) ? 'failure' : 'answered');
        } catch (err) {
          const phase = abort.signal.aborted ? 'deadline' : phaseOf(err);
          outcome = { kind: 'error', phase };
          if (phase === 'deadline') {
            void breaker.record(permit, 'abandoned');
            break models;
          }
          lastFailure = { kind: 'error', model, err };
          await breaker.record(permit, isRetryable(outcome) ? 'failure' : 'abandoned');
        }

        // Class and code only: an error's message can carry request data.
        const failureLog =
          outcome.kind === 'status'
            ? { outcome: outcome.status }
            : { outcome: outcome.phase, code: (lastFailure?.kind === 'error' ? (lastFailure.err as { code?: string }).code : undefined) ?? '' };
        reply.log.warn({ model, target: target.provider, ...failureLog, ms: ms(performance.now() - attemptStarted) }, 'upstream attempt failed');
        if (!isRetryable(outcome)) break models; // no other attempt or model would change the answer
        const step = planRetry(
          {
            outcome,
            retryAfter: lastFailure?.kind === 'status' ? lastFailure.headers['retry-after'] : undefined,
            attemptsMade: triesOnModel,
            remainingMs: remainingMs(),
            nowMs: Date.now(),
          },
          retry,
        );
        if (step.action === 'next-model') continue models;
        try {
          await sleep(step.waitMs, undefined, { signal: abort.signal });
        } catch {
          break models; // the deadline passed or the client left while waiting
        }
      }
    }

    reply.header('x-gateway-attempts', String(attempts));
    if (state.model !== undefined) reply.header('x-gateway-model', state.model);

    if (!served) {
      if (deadlineHit) return tooLong(); // the estimate stays: the provider may have worked
      if (abort.signal.aborted) return reply; // client already gone
      return answerFailure(reply, request, settle, lastFailure, soonestReopenMs, { started, dispatched });
    }

    const { res, target, forward } = served;
    state.model = served.model;
    const extraHeaders = passthroughHeaders(res.headers, request.rateLimit != null);
    const translated = target.adapter.translates ? target.adapter : undefined;
    const contentType = res.headers['content-type'];
    const type = Array.isArray(contentType) ? contentType[0] : contentType;

    if (parsed.stream === true) {
      // Hijack so Fastify neither buffers nor serialises: bytes go from the upstream socket
      // to the client socket as they arrive. Reply headers are written only now, after the upstream
      // answered 200, which is why every attempt before this point could be retried.
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
      guard = new DeadlineGuard(translated !== undefined || /text\/event-stream/i.test(type ?? ''));
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
              if (metered) settle.used(usage, served.model);
            },
          });
          await pipeline(relay, translator, guard, reply.raw);
        } else if (metered && forward.tap !== 'none') {
          // Once bytes are flowing a failure keeps the estimate charged: tokens were partly used.
          const tap = new SseUsageTap(
            (usage) => {
              if (usage) settle.used(usage, served.model);
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
      // stream that fails after bytes were sent).
      return upstreamFailure(reply, err, null);
    }
    let type2 = type;
    if (translated) {
      try {
        const answer = translated.parseResponse(payload);
        payload = Buffer.from(JSON.stringify(answer.openaiBody));
        type2 = 'application/json';
        if (metered && answer.usage) settle.used(answer.usage, served.model);
      } catch (err) {
        // The provider answered 2xx and did the work, but its body is not one the adapter can read.
        return upstreamFailure(reply, err, null);
      }
    }
    const received = performance.now();
    if (!translated && metered) {
      const usage = usageFromBody(payload);
      if (usage) settle.used(usage, served.model);
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

  // No attempt produced an answer to serve. The provider did no work we saw, so everything held goes back, and
  // the client gets the last attempt's answer in the OpenAI shape (with the provider's own back-off and
  // correlation headers), or, if no attempt was made at all, 503 with the soonest a breaker will let a call through.
  function answerFailure(
    reply: FastifyReply,
    request: FastifyRequest,
    settle: UsageSettler,
    failure: Failure | undefined,
    soonestReopenMs: number | undefined,
    timing: { started: number; dispatched: number },
  ) {
    settle.refund();
    if (failure === undefined) {
      if (soonestReopenMs !== undefined) reply.header('retry-after', String(Math.max(1, Math.ceil(soonestReopenMs / 1000))));
      return reply
        .code(503)
        .send(errorBody('No provider is available for this model right now. Try again shortly.', 'gateway_error', 'all_providers_unavailable'));
    }
    if (failure.kind === 'error') return upstreamFailure(reply, failure.err, null);

    const extra = passthroughHeaders(failure.headers, request.rateLimit != null);
    const gwTiming = `gw-pre;dur=${ms(timing.dispatched - timing.started)}, upstream;dur=${ms(performance.now() - timing.dispatched)}`;
    const providerTiming = asText(extra['server-timing']);
    reply.headers(extra).header('server-timing', providerTiming ? `${providerTiming}, ${gwTiming}` : gwTiming);

    // The provider rejected the gateway's own credential. That is not the caller's doing and the provider's
    // wording is not the caller's business: they get a generic 502. The log keeps the status and the provider's
    // error code only, never its message, which can echo part of the key.
    if (failure.status === 401) {
      const e = (tryJson(failure.body) as { error?: { code?: unknown; type?: unknown; status?: unknown } } | undefined)?.error;
      const providerCode = [e?.code, e?.type, e?.status].find((v): v is string => typeof v === 'string')?.slice(0, 64);
      logAuthRejected(reply.log, failure.target.provider, providerCode, failure.status);
      return reply.code(502).send(errorBody(providerAuthMessage(failure.target.provider), 'gateway_error', 'provider_auth_failed'));
    }
    // A translated provider's error is rewritten into the OpenAI error shape, streamed request or not.
    const adapter = failure.target.adapter;
    if (adapter.translates) {
      const mappedError = adapter.mapError(failure.status, failure.body);
      return reply.code(mappedError.status).send(mappedError.body);
    }
    const type = asText(failure.headers['content-type']);
    return reply.code(failure.status).header('content-type', type ?? 'application/json').send(failure.body);
  }
};
