import { randomUUID } from 'node:crypto';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { chatRequest } from '../request-body.ts';
import type { LogEntry } from './entry.ts';
import type { Sink } from './sink.ts';

/** What a route and the plugins in front of it tell the collector as a request runs. Every field is optional. */
export interface Notes {
  model: string;
  stream: boolean;
  provider: string;
  servedModel: string;
  promptTokens: number;
  completionTokens: number;
  costMicros: number;
  savedMicros: number;
  errorCode: string;
}

/** The state of the upstream response body when the client's connection closed. */
export interface UpstreamState {
  /** The upstream body failed (an error, or it was destroyed) before the client left. */
  failed: boolean;
  /** The upstream body is still flowing, or finished cleanly. */
  alive: boolean;
}

export interface RequestLogState {
  note(n: Partial<Notes>): void;
  /** Adds the time of one upstream attempt, in ms. */
  addUpstreamMs(ms: number): void;
  /** Marks the moment the first bytes (the headers) go to the client. Only the first call counts. */
  firstByte(): void;
  /** How the route reads its upstream body, for deciding who ended a response that did not finish. */
  upstreamState: (() => UpstreamState) | null;
}

declare module 'fastify' {
  interface FastifyInstance {
    /** Resolves once every request that has ended has had its log entry handed to the sink. Used at shutdown. */
    requestLogIdle(): Promise<void>;
  }
  interface FastifyRequest {
    /** Set on every request by the request-log collector. */
    reqlog: RequestLogState;
  }
}

export type CloseKind = 'complete' | 'client' | 'upstream';

/**
 * Who ended a response. This is the one place that decides it: a response whose writable side finished is
 * complete; one that did not was ended by the client leaving, unless the upstream body had already failed or was
 * destroyed, in which case it was the upstream. A response with no upstream body (an error the gateway made, a
 * cache replay) that did not finish was the client's doing.
 */
export function classifyClose(i: { finished: boolean; upstream: UpstreamState | null }): CloseKind {
  if (i.finished) return 'complete';
  if (i.upstream && (i.upstream.failed || !i.upstream.alive)) return 'upstream';
  return 'client';
}

export interface CollectorOptions {
  sink: Sink;
  /** `inline`: the row is written before the response is sent, where it can be (the benchmark's "before"). */
  mode: 'stream' | 'inline';
}

const asString = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);
const asInt = (v: unknown): number | null => {
  const n = typeof v === 'string' ? Number(v) : typeof v === 'number' ? v : NaN;
  return Number.isInteger(n) ? n : null;
};

const collectorPlugin: FastifyPluginAsync<CollectorOptions> = async (app, opts) => {
  app.decorateRequest('reqlog', null as unknown as RequestLogState);
  // Entries being built or written, so that shutdown can wait for them.
  const unfinished = new Set<Promise<void>>();
  app.decorate('requestLogIdle', async () => void (await Promise.allSettled([...unfinished])));
  const states = new WeakMap<FastifyRequest, { startedAt: number; t0: number; notes: Partial<Notes>; upstreamMs: number | null; ttfb: number | null; errorFromBody: string | null; done: boolean }>();

  // First onRequest hook of the app (the collector is registered before auth), so a refused request is logged too.
  app.addHook('onRequest', async (request, reply) => {
    const s = { startedAt: Date.now(), t0: performance.now(), notes: {} as Partial<Notes>, upstreamMs: null as number | null, ttfb: null as number | null, errorFromBody: null as string | null, done: false };
    states.set(request, s);
    request.reqlog = {
      note: (n) => void Object.assign(s.notes, n),
      addUpstreamMs: (ms) => void (s.upstreamMs = (s.upstreamMs ?? 0) + ms),
      firstByte: () => void (s.ttfb ??= performance.now() - s.t0),
      upstreamState: null,
    };
    // 'close' fires once for every way a response ends: finished, client gone, or destroyed. The entry is built a
    // tick later, after the route's own wrap-up (a cut stream's estimate is charged there) has run.
    // Who ended it is decided at the moment of closing, before the route aborts its upstream.
    reply.raw.once('close', () => {
      const kind = classifyClose({ finished: reply.raw.writableFinished, upstream: request.reqlog.upstreamState?.() ?? null });
      const p: Promise<void> = new Promise<void>((resolve) => setImmediate(() => void finish(request, reply, kind).finally(resolve))).finally(() => unfinished.delete(p));
      unfinished.add(p);
    });
  });

  // The body of an error the gateway or a provider produced carries its code; read it only for errors.
  app.addHook('onSend', async (request, reply, payload) => {
    const s = states.get(request);
    if (!s) return payload;
    s.ttfb ??= performance.now() - s.t0;
    if (reply.statusCode >= 400 && typeof payload === 'string' && payload.length < 4096) {
      try {
        s.errorFromBody = asString((JSON.parse(payload) as { error?: { code?: unknown } }).error?.code);
      } catch {
        // not JSON: no code
      }
    }
    if (opts.mode === 'inline') await finish(request, reply, 'complete');
    return payload;
  });

  // `kind` is how the response ended; from onSend (inline mode) it is written after this, so it is complete.
  async function finish(request: FastifyRequest, reply: FastifyReply, kind: CloseKind): Promise<void> {
    const s = states.get(request);
    if (!s || s.done) return;
    s.done = true;
    try {
      const tenant = request.tenant;
      // The model of a request refused before the route (budget, rate limit) is read from its body, once.
      let model = s.notes.model ?? null;
      let stream = s.notes.stream ?? false;
      if (model === null && Buffer.isBuffer(request.body)) {
        const body = chatRequest(request);
        if (body.ok) {
          model = body.value.model;
          stream = body.value.stream === true;
        }
      }
      const header = (name: string) => asString(reply.getHeader(name));
      const attempts = asInt(header('x-gateway-attempts')) ?? 0;
      const served = s.notes.servedModel ?? header('x-gateway-model');
      let status = reply.raw.headersSent ? reply.raw.statusCode : reply.statusCode;
      let errorCode = s.notes.errorCode ?? s.errorFromBody;
      if (kind === 'client') {
        // The client left before the answer was whole. Nothing the provider or the gateway did.
        if (!reply.raw.headersSent) status = 499;
        errorCode ??= 'client_closed';
      } else if (kind === 'upstream') {
        errorCode ??= 'upstream_stream_broken';
      }
      const entry: LogEntry = {
        requestId: request.id,
        startedAt: s.startedAt,
        tenantId: tenant?.tenantId ?? null,
        keyId: tenant?.keyId ?? null,
        model,
        servedModel: served,
        provider: s.notes.provider ?? null,
        status,
        errorCode,
        stream,
        promptTokens: s.notes.promptTokens ?? null,
        completionTokens: s.notes.completionTokens ?? null,
        costMicros: s.notes.costMicros ?? 0,
        savedMicros: s.notes.savedMicros ?? 0,
        cache: header('x-gateway-cache'),
        attempts,
        fallbackUsed: attempts > 0 && served !== null && model !== null && served !== model,
        latencyMs: Math.round(performance.now() - s.t0),
        ttfbMs: s.ttfb === null ? null : Math.round(s.ttfb),
        upstreamMs: s.upstreamMs === null ? null : Math.round(s.upstreamMs),
      };
      await opts.sink.write(entry);
    } catch (err) {
      request.log.warn({ errClass: (err as Error)?.name, code: (err as { code?: string })?.code }, 'request log entry could not be built');
    }
  }
};

// Same effect as fastify-plugin: the hooks apply to every route in the app.
export const requestLogCollector = Object.assign(collectorPlugin, { [Symbol.for('skip-override')]: true });

/** Request ids are uuids: they are the primary key of the request log and the id of the spend hold. */
export const newRequestId = (): string => randomUUID();
