import type { Transform } from 'node:stream';
import type { ChatBody } from '../request-body.ts';
import type { Usage } from '../usage/sse-usage.ts';

export const PROVIDER_IDS = ['openai', 'anthropic', 'gemini', 'mock-openai', 'mock-anthropic', 'mock-gemini'] as const;
export type ProviderId = (typeof PROVIDER_IDS)[number];

/** How a streamed answer's usage is read and shown (see forwardBody in openai.ts). */
export type Tap = 'none' | 'read' | 'strip';

export interface BuildInput {
  /** The client's request, parsed. */
  body: ChatBody;
  /** The client's request bytes, for pass-through. */
  raw: Buffer;
  /** Something was charged up front, so usage is needed from the answer. */
  metered: boolean;
  /** Output tokens assumed (and required by Anthropic) when the request names no limit. */
  defaultMaxTokens: number;
  /** This provider's own credential; no other credential ever reaches an adapter. */
  apiKey: string | undefined;
}

export interface UpstreamRequest {
  /** Appended to the provider's base URL path. */
  path: string;
  headers: Record<string, string>;
  body: Buffer;
  tap: Tap;
}

export type BuildResult =
  | { ok: true; request: UpstreamRequest }
  | { ok: false; param: string; message: string };

export interface MappedError {
  status: number;
  /** An OpenAI-shaped error body. */
  body: { error: { message: string; type: string; code?: string } };
}

export interface TranslatedResponse {
  /** A `chat.completion` object. */
  openaiBody: Record<string, unknown>;
  usage: Usage | undefined;
}

export interface StreamOptions {
  /** The client asked for stream_options.include_usage: the usage-only chunk is written. */
  includeUsage: boolean;
  /** Called once with the answer's usage when the provider reports it. */
  onUsage(usage: Usage): void;
  /** Where a mid-stream rejection of the gateway's credentials is logged (provider and code only). */
  log?: { error(obj: object, msg: string): void };
}

interface AdapterBase {
  buildRequest(input: BuildInput): BuildResult;
}

/** OpenAI-format upstreams: bytes pass through, usage is read by the shared SSE tap. */
export interface PassthroughAdapter extends AdapterBase {
  translates: false;
}

/** Providers with their own format: request, response, stream and errors are translated to OpenAI's. */
export interface TranslatingAdapter extends AdapterBase {
  translates: true;
  /** The provider's non-streamed JSON body to a `chat.completion`. Throws on a body that is not JSON. */
  parseResponse(body: Buffer): TranslatedResponse;
  /** Provider SSE in, OpenAI SSE out. */
  streamTransform(options: StreamOptions): Transform;
  /** A non-2xx answer: status kept (except where noted per provider), body in the OpenAI error shape. */
  mapError(status: number, body: Buffer): MappedError;
}

export type Adapter = PassthroughAdapter | TranslatingAdapter;

export interface AdapterClock {
  /** Unix seconds for `created`. */
  now(): number;
  /** An id for the completion when the provider gives none. */
  newId(): string;
}
