import type { Transform } from 'node:stream';
import type { Usage } from '../usage/sse-usage.ts';
import {
  chunkObject,
  completionObject,
  conversation,
  defaultClock,
  errorEvent,
  isUnsupported,
  mapped,
  num,
  positiveInt,
  stopList,
  toUsage,
  tryJson,
  unsupportedParameter,
  usageChunk,
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

const count = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0);

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
        return sseData(
          errorEvent(
            typeof e.message === 'string' ? e.message : 'provider error',
            e.type === 'overloaded_error' || e.type === 'api_error' ? 'server_error' : 'invalid_request_error',
            typeof e.type === 'string' ? e.type : 'provider_error',
          ),
        );
      }
      default:
        return ''; // ping, content_block_start/stop, thinking and tool blocks
    }
  }

  protected override onEnd(): string {
    if (this.#failed || this.#finished) return '';
    // The provider closed the stream without finishing the message.
    return sseData(errorEvent('provider stream ended before the answer was complete', 'server_error', 'upstream_stream_incomplete'));
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
      const refused = unsupportedParameter(body);
      if (refused) return { ok: false, ...refused };
      const convo = conversation(body.messages);
      if (isUnsupported(convo)) return { ok: false, ...convo };

      const stop = body.stop === undefined || body.stop === null ? undefined : stopList(body.stop);
      if (body.stop !== undefined && body.stop !== null && stop === undefined) {
        return { ok: false, param: 'stop', message: '"stop" must be a string or an array of strings.' };
      }
      const temperature = num(body.temperature);
      const topP = num(body.top_p);
      const request = {
        model: body.model,
        // Required by Anthropic: the caller's limit, else the gateway's default allowance.
        max_tokens: positiveInt(body.max_tokens) ?? positiveInt(body.max_completion_tokens) ?? defaultMaxTokens,
        messages: convo.turns.map((t) => ({ role: t.role, content: t.text })),
        ...(convo.system.length ? { system: convo.system.join('\n\n') } : {}),
        ...(stop ? { stop_sequences: stop } : {}),
        ...(temperature !== undefined ? { temperature } : {}),
        ...(topP !== undefined ? { top_p: topP } : {}),
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
