import { Transform, type TransformCallback } from 'node:stream';
import { SseParser } from '../providers/sse.ts';
import { parseUsage, type Usage } from '../usage/sse-usage.ts';
import type { CachedCompletion } from './replay.ts';

/**
 * Sits in a streamed reply's pipeline, passes every byte through unchanged and reads the OpenAI-format events
 * as they go by, so the answer can be cached without holding the client's stream back. `complete()` is
 * undefined unless the stream ended the way a good one does.
 */
export class StreamCollector extends Transform {
  readonly #parser = new SseParser();
  readonly #parts: string[] = [];
  readonly #maxChars: number;
  #chars = 0;
  #finish: string | undefined;
  #usage: Usage | undefined;
  #done = false;
  #spoiled = false;

  /** `maxChars` bounds what is held; past it the answer is too big to cache and nothing more is kept. */
  constructor(maxChars: number) {
    super();
    this.#maxChars = maxChars;
  }

  override _transform(chunk: Buffer, _enc: BufferEncoding, done: TransformCallback) {
    this.#read(this.#parser.push(chunk));
    done(null, chunk);
  }

  override _flush(done: TransformCallback) {
    this.#read(this.#parser.end());
    done();
  }

  #read(events: { data: string }[]) {
    for (const { data } of events) {
      if (data === '[DONE]') {
        this.#done = true;
        continue;
      }
      let json: { error?: unknown; choices?: { index?: number; delta?: Record<string, unknown>; finish_reason?: string | null }[]; usage?: unknown };
      try {
        json = JSON.parse(data);
      } catch {
        this.#spoiled = true;
        continue;
      }
      // An error event, or a second choice, or a tool call: not an answer this cache keeps.
      if (json.error !== undefined) this.#spoiled = true;
      const usage = parseUsage(json.usage);
      if (usage) this.#usage = usage;
      for (const choice of json.choices ?? []) {
        if (choice.index !== undefined && choice.index !== 0) {
          this.#spoiled = true;
          continue;
        }
        const delta = choice.delta ?? {};
        if (delta.tool_calls !== undefined || delta.function_call !== undefined) this.#spoiled = true;
        if (typeof delta.content === 'string' && !this.#spoiled) {
          this.#chars += delta.content.length;
          if (this.#chars > this.#maxChars) this.#spoiled = true;
          else this.#parts.push(delta.content);
        }
        if (typeof choice.finish_reason === 'string') this.#finish = choice.finish_reason;
      }
    }
  }

  /** The answer, once the stream has ended well: [DONE] seen, no error, one plain-text choice that stopped or hit its limit. */
  complete(): Omit<CachedCompletion, 'model'> | undefined {
    if (!this.#done || this.#spoiled) return undefined;
    if (this.#finish !== 'stop' && this.#finish !== 'length') return undefined;
    return {
      content: this.#parts.join(''),
      finishReason: this.#finish,
      usage: this.#usage ?? null,
    };
  }
}

/**
 * The answer in a non-streamed OpenAI-format body, or undefined when it is not one to keep: more than one
 * choice, no text (a tool call, a refusal), or a finish reason other than stop or length (content_filter).
 */
export function completionFromBody(body: Buffer): Omit<CachedCompletion, 'model'> | undefined {
  let json: { choices?: { index?: number; message?: Record<string, unknown>; finish_reason?: unknown }[]; usage?: unknown };
  try {
    json = JSON.parse(body.toString('utf8'));
  } catch {
    return undefined;
  }
  if (!Array.isArray(json?.choices) || json.choices.length !== 1) return undefined;
  const choice = json.choices[0]!;
  const message = choice.message;
  if (typeof message?.content !== 'string') return undefined;
  if (message.tool_calls !== undefined || message.function_call !== undefined) return undefined;
  if (choice.finish_reason !== 'stop' && choice.finish_reason !== 'length') return undefined;
  return { content: message.content, finishReason: choice.finish_reason, usage: parseUsage(json.usage) ?? null };
}
