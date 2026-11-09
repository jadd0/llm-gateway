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

function finishReason(reason: unknown): string {
  switch (reason) {
    case 'MAX_TOKENS':
      return 'length';
    case 'SAFETY':
    case 'RECITATION':
    case 'BLOCKLIST':
    case 'PROHIBITED_CONTENT':
    case 'SPII':
    case 'IMAGE_SAFETY':
      return 'content_filter';
    default:
      return 'stop'; // STOP and anything else
  }
}

const count = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0);

interface GeminiResponse {
  candidates?: Array<{ content?: { parts?: Array<{ text?: unknown; thought?: unknown }> }; finishReason?: unknown }>;
  promptFeedback?: { blockReason?: unknown };
  usageMetadata?: { promptTokenCount?: unknown; candidatesTokenCount?: unknown; thoughtsTokenCount?: unknown };
  modelVersion?: unknown;
  responseId?: unknown;
  error?: { message?: unknown; status?: unknown };
}

// Visible answer text: the first candidate's text parts, leaving out the model's thought summaries.
function textOf(r: GeminiResponse): string {
  const parts = r.candidates?.[0]?.content?.parts;
  if (!Array.isArray(parts)) return '';
  return parts.filter((p) => typeof p?.text === 'string' && p.thought !== true).map((p) => p.text as string).join('');
}

// Thinking tokens are billed as output, so they count as completion tokens.
function usageOf(r: GeminiResponse): Usage | undefined {
  const u = r.usageMetadata;
  if (!u) return undefined;
  return toUsage(count(u.promptTokenCount), count(u.candidatesTokenCount) + count(u.thoughtsTokenCount));
}

function finishOf(r: GeminiResponse): string | undefined {
  const reason = r.candidates?.[0]?.finishReason;
  if (reason !== undefined && reason !== null) return finishReason(reason);
  if (r.promptFeedback?.blockReason !== undefined) return 'content_filter'; // the prompt was refused: no candidates
  return undefined;
}

class GeminiStream extends SseTranslator {
  #base: { id: string; created: number; model: string };
  #started = false;
  #finish: string | undefined;
  #usage: Usage | undefined;
  #failed = false;
  readonly #opts: StreamOptions;

  constructor(opts: StreamOptions, clock: AdapterClock) {
    super();
    this.#opts = opts;
    this.#base = { id: `chatcmpl-${clock.newId()}`, created: clock.now(), model: '' };
  }

  protected override onEvent(ev: SseEvent): string {
    if (this.#failed) return '';
    let data: GeminiResponse;
    try {
      data = JSON.parse(ev.data);
    } catch {
      return '';
    }
    if (data.error) {
      this.#failed = true;
      return sseData(
        errorEvent(
          typeof data.error.message === 'string' ? data.error.message : 'provider error',
          'server_error',
          typeof data.error.status === 'string' ? data.error.status.toLowerCase() : 'provider_error',
        ),
      );
    }
    let out = '';
    if (!this.#started) {
      this.#started = true;
      this.#base = {
        id: typeof data.responseId === 'string' ? `chatcmpl-${data.responseId}` : this.#base.id,
        created: this.#base.created,
        model: typeof data.modelVersion === 'string' ? data.modelVersion : '',
      };
      out += sseData(chunkObject(this.#base, { role: 'assistant', content: '' }, null));
    }
    const text = textOf(data);
    if (text !== '') out += sseData(chunkObject(this.#base, { content: text }, null));
    this.#finish = finishOf(data) ?? this.#finish;
    this.#usage = usageOf(data) ?? this.#usage; // cumulative: the last one is the total
    return out;
  }

  // Gemini ends its stream by closing it; the finish chunk waits for that so it carries the final usage.
  protected override onEnd(): string {
    if (this.#failed) return '';
    if (!this.#started || this.#finish === undefined) {
      return sseData(errorEvent('provider stream ended before the answer was complete', 'server_error', 'upstream_stream_incomplete'));
    }
    let out = sseData(chunkObject(this.#base, {}, this.#finish));
    if (this.#usage) {
      this.#opts.onUsage(this.#usage);
      if (this.#opts.includeUsage) out += sseData(usageChunk(this.#base, this.#usage));
    }
    return out + SSE_DONE;
  }
}

export function createGeminiAdapter(options: { clock?: AdapterClock } = {}): TranslatingAdapter {
  const clock = options.clock ?? defaultClock;
  return {
    translates: true,

    buildRequest({ body, apiKey }: BuildInput): BuildResult {
      const refused = unsupportedParameter(body);
      if (refused) return { ok: false, ...refused };
      const convo = conversation(body.messages);
      if (isUnsupported(convo)) return { ok: false, ...convo };

      const stop = body.stop === undefined || body.stop === null ? undefined : stopList(body.stop);
      if (body.stop !== undefined && body.stop !== null && stop === undefined) {
        return { ok: false, param: 'stop', message: '"stop" must be a string or an array of strings.' };
      }
      const maxOutputTokens = positiveInt(body.max_tokens) ?? positiveInt(body.max_completion_tokens);
      const temperature = num(body.temperature);
      const topP = num(body.top_p);
      const generationConfig = {
        ...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
        ...(temperature !== undefined ? { temperature } : {}),
        ...(topP !== undefined ? { topP } : {}),
        ...(stop ? { stopSequences: stop } : {}),
      };
      const request = {
        contents: convo.turns.map((t) => ({ role: t.role === 'assistant' ? 'model' : 'user', parts: [{ text: t.text }] })),
        ...(convo.system.length ? { systemInstruction: { parts: [{ text: convo.system.join('\n\n') }] } } : {}),
        ...(Object.keys(generationConfig).length ? { generationConfig } : {}),
      };
      const model = encodeURIComponent(body.model);
      const path = body.stream === true ? `/models/${model}:streamGenerateContent?alt=sse` : `/models/${model}:generateContent`;
      const headers: Record<string, string> = { 'content-type': 'application/json' };
      if (apiKey) headers['x-goog-api-key'] = apiKey;
      return { ok: true, request: { path, headers, body: Buffer.from(JSON.stringify(request)), tap: 'none' } };
    },

    parseResponse(raw: Buffer): TranslatedResponse {
      const json = JSON.parse(raw.toString('utf8')) as GeminiResponse;
      const usage = usageOf(json);
      return {
        openaiBody: completionObject({
          id: `chatcmpl-${typeof json.responseId === 'string' ? json.responseId : clock.newId()}`,
          created: clock.now(),
          model: typeof json.modelVersion === 'string' ? json.modelVersion : '',
          text: textOf(json),
          finish: finishOf(json) ?? 'stop',
          usage,
        }),
        usage,
      };
    },

    streamTransform(opts: StreamOptions): Transform {
      return new GeminiStream(opts, clock);
    },

    mapError(status: number, raw: Buffer) {
      const json = tryJson(raw) as { error?: { message?: unknown; status?: unknown } } | undefined;
      const message = typeof json?.error?.message === 'string' ? json.error.message : 'provider error';
      const code = typeof json?.error?.status === 'string' ? json.error.status.toLowerCase() : undefined;
      return mapped(status, message, code);
    },
  };
}
