import type { Transform } from 'node:stream';
import type { Usage } from '../usage/sse-usage.ts';
import {
  chunkObject,
  completionObject,
  count,
  defaultClock,
  incompleteStreamEvent,
  isUnsupported,
  mapped,
  prepare,
  providerStreamError,
  toUsage,
  tryJson,
  usageChunk,
  type ProviderErrorKind,
} from './common.ts';
import { SSE_DONE, SseTranslator, sseData, type SseEvent } from './sse.ts';
import type { AdapterClock, BuildInput, BuildResult, StreamOptions, TranslatedResponse, TranslatingAdapter } from './types.ts';

// Anthropic stop reasons to OpenAI finish reasons. Unknown reasons read as a normal stop.
function finishReason(stop: unknown): string {
  switch (stop) {
    case 'max_tokens':
      return 'length';
    case 'refusal':
      return 'content_filter';
    default:
      return 'stop'; // end_turn, stop_sequence, pause_turn
  }
}

interface AnthropicUsage {
  input_tokens?: unknown;
  output_tokens?: unknown;
}

// Anthropic's streamed error types by what they mean to an OpenAI client.
function errorKind(type: unknown): ProviderErrorKind {
  switch (type) {
    case 'invalid_request_error':
    case 'not_found_error':
    case 'request_too_large':
      return 'invalid_request';
    case 'rate_limit_error':
      return 'rate_limit';
    case 'authentication_error':
    case 'permission_error':
      return 'auth';
    default:
      return 'server'; // overloaded_error, api_error, timeout_error and anything new
  }
}

class AnthropicStream extends SseTranslator {
  #base: { id: string; created: number; model: string };
  #inputTokens = 0;
  #finished = false; // message_stop seen
  #failed = false;
  readonly #opts: StreamOptions;
  readonly #clock: AdapterClock;

  constructor(opts: StreamOptions, clock: AdapterClock) {
    super();
    this.#opts = opts;
    this.#clock = clock;
    this.#base = { id: `chatcmpl-${clock.newId()}`, created: clock.now(), model: '' };
  }

  protected override onEvent(ev: SseEvent): string {
    if (this.#failed || this.#finished) return '';
    let data: { type?: unknown; [k: string]: any };
    try {
      data = JSON.parse(ev.data);
    } catch {
      return ''; // not JSON: nothing to translate
    }
    switch (data.type ?? ev.event) {
      case 'message_start': {
        const m = data.message ?? {};
        this.#base = {
          id: typeof m.id === 'string' ? `chatcmpl-${m.id}` : this.#base.id,
          created: this.#base.created,
          model: typeof m.model === 'string' ? m.model : '',
        };
        this.#inputTokens = count(m.usage?.input_tokens);
        return sseData(chunkObject(this.#base, { role: 'assistant', content: '' }, null));
      }
      case 'content_block_delta': {
        const d = data.delta;
        if (d?.type === 'text_delta' && typeof d.text === 'string' && d.text !== '') {
          return sseData(chunkObject(this.#base, { content: d.text }, null));
        }
        return '';
      }
      case 'message_delta': {
        const u: AnthropicUsage = data.usage ?? {};
        const usage: Usage = toUsage(u.input_tokens === undefined ? this.#inputTokens : count(u.input_tokens), count(u.output_tokens));
        this.#opts.onUsage(usage);
        let out = sseData(chunkObject(this.#base, {}, finishReason(data.delta?.stop_reason)));
        if (this.#opts.includeUsage) out += sseData(usageChunk(this.#base, usage));
        return out;
      }
      case 'message_stop':
        this.#finished = true;
        return SSE_DONE;
      case 'error': {
        this.#failed = true;
        const e = data.error ?? {};
        return providerStreamError(
          errorKind(e.type),
          typeof e.message === 'string' ? e.message : 'provider error',
          typeof e.type === 'string' ? e.type : 'provider_error',
          'anthropic',
          this.#opts.log,
        );
      }
      default:
        return ''; // ping, content_block_start/stop, thinking and tool blocks
    }
  }

  protected override onEnd(): string {
    if (this.#failed || this.#finished) return '';
    // The provider closed the stream without finishing the message.
    return incompleteStreamEvent();
  }
}

export interface AnthropicOptions {
  version: string;
  clock?: AdapterClock;
}

export function createAnthropicAdapter(options: AnthropicOptions): TranslatingAdapter {
  const clock = options.clock ?? defaultClock;
  return {
    translates: true,

    buildRequest({ body, apiKey, defaultMaxTokens }: BuildInput): BuildResult {
      const p = prepare(body);
      if (isUnsupported(p)) return { ok: false, ...p };
      // Anthropic's temperature runs 0 to 1; OpenAI's to 2. A value past 1 is refused, not clamped.
      if (p.temperature !== undefined && p.temperature > 1) {
        return { ok: false, param: 'temperature', message: '"temperature" above 1 is not supported for this model: Anthropic accepts 0 to 1.' };
      }
      const request = {
        model: body.model,
        // Required by Anthropic: the caller's limit, else the gateway's default allowance.
        max_tokens: p.maxTokens ?? defaultMaxTokens,
        messages: p.convo.turns.map((t) => ({ role: t.role, content: t.text })),
        ...(p.convo.system.length ? { system: p.convo.system.join('\n\n') } : {}),
        ...(p.stop ? { stop_sequences: p.stop } : {}),
        ...(p.temperature !== undefined ? { temperature: p.temperature } : {}),
        ...(p.topP !== undefined ? { top_p: p.topP } : {}),
        ...(body.stream === true ? { stream: true } : {}),
      };
      const headers: Record<string, string> = {
        'content-type': 'application/json',
        'anthropic-version': options.version,
      };
      if (apiKey) headers['x-api-key'] = apiKey;
      return { ok: true, request: { path: '/v1/messages', headers, body: Buffer.from(JSON.stringify(request)), tap: 'none' } };
    },

    parseResponse(raw: Buffer): TranslatedResponse {
      const json = JSON.parse(raw.toString('utf8')) as {
        id?: unknown;
        model?: unknown;
        content?: unknown;
        stop_reason?: unknown;
        usage?: AnthropicUsage;
      };
      const text = Array.isArray(json.content)
        ? json.content
            .filter((b: { type?: unknown; text?: unknown }) => b?.type === 'text' && typeof b.text === 'string')
            .map((b: { text: string }) => b.text)
            .join('')
        : '';
      const usage = json.usage ? toUsage(count(json.usage.input_tokens), count(json.usage.output_tokens)) : undefined;
      return {
        openaiBody: completionObject({
          id: typeof json.id === 'string' ? `chatcmpl-${json.id}` : `chatcmpl-${clock.newId()}`,
          created: clock.now(),
          model: typeof json.model === 'string' ? json.model : '',
          text,
          finish: finishReason(json.stop_reason),
          usage,
        }),
        usage,
      };
    },

    streamTransform(opts: StreamOptions): Transform {
      return new AnthropicStream(opts, clock);
    },

    mapError(status: number, raw: Buffer) {
      const json = tryJson(raw) as { error?: { type?: unknown; message?: unknown } } | undefined;
      const message = typeof json?.error?.message === 'string' ? json.error.message : 'provider error';
      const code = typeof json?.error?.type === 'string' ? json.error.type : undefined;
      // 529 is Anthropic's "overloaded"; to an OpenAI client that is a 503.
      return mapped(status === 529 ? 503 : status, message, code);
    },
  };
}
