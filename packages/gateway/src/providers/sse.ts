import { StringDecoder } from 'node:string_decoder';
import { Transform, type TransformCallback } from 'node:stream';

export interface SseEvent {
  /** The `event:` field, when the provider names its events. */
  event: string | undefined;
  /** The `data:` lines joined with "\n". */
  data: string;
}

/**
 * Incremental Server-Sent Events parser. Bytes go in as they arrive, whole events come out. It holds only
 * the incomplete trailing line and the fields of the event in progress, and decodes through a streaming
 * UTF-8 decoder so a character split across two chunks is not corrupted. Lines end with \n, \r or \r\n.
 */
export class SseParser {
  readonly #decoder = new StringDecoder('utf8');
  #pending = '';
  // How much of #pending is known to hold no line ending, so a long line arriving in many pieces is
  // scanned once rather than from its start on every push.
  #scanned = 0;
  // Pieces after #pending that hold no line ending. They are joined only when one arrives, so a long line
  // delivered in tiny pieces is not copied whole on every push.
  #tail: string[] = [];
  #event: string | undefined;
  #data: string[] = [];

  push(chunk: Buffer): SseEvent[] {
    const text = this.#decoder.write(chunk);
    // Nothing is held back (#scanned covers #pending) and the piece ends no line: park it.
    if (this.#scanned === this.#pending.length && !/[\r\n]/.test(text)) {
      if (text !== '') this.#tail.push(text);
      return [];
    }
    this.#pending += this.#tail.join('') + text;
    this.#tail = [];
    const out: SseEvent[] = [];
    let start = 0;
    let from = this.#scanned;
    let end = -1;
    for (;;) {
      end = -1;
      for (let i = from; i < this.#pending.length; i++) {
        const c = this.#pending.charCodeAt(i);
        if (c === 10 || c === 13) {
          end = i;
          break;
        }
      }
      if (end < 0) break;
      // A \r at the very end might be the first half of \r\n: wait for the next byte.
      if (this.#pending.charCodeAt(end) === 13 && end === this.#pending.length - 1) break;
      const crlf = this.#pending.charCodeAt(end) === 13 && this.#pending.charCodeAt(end + 1) === 10;
      this.#line(this.#pending.slice(start, end), out);
      start = end + (crlf ? 2 : 1);
      from = start;
    }
    // Everything before a held-back \r, or the whole remainder when no line ending was found, is scanned.
    this.#scanned = (end < 0 ? this.#pending.length : end) - start;
    this.#pending = this.#pending.slice(start);
    return out;
  }

  /** The stream ended: a last line without a line ending, and an event without its blank line, still count. */
  end(): SseEvent[] {
    this.#pending += this.#tail.join('') + this.#decoder.end();
    this.#tail = [];
    const out: SseEvent[] = [];
    if (this.#pending !== '') this.#line(this.#pending.replace(/\r$/, ''), out);
    this.#pending = '';
    this.#scanned = 0;
    this.#line('', out);
    return out;
  }

  #line(line: string, out: SseEvent[]) {
    if (line === '') {
      if (this.#data.length > 0 || this.#event !== undefined) {
        out.push({ event: this.#event, data: this.#data.join('\n') });
      }
      this.#event = undefined;
      this.#data = [];
      return;
    }
    if (line.startsWith(':')) return; // comment
    const colon = line.indexOf(':');
    const field = colon < 0 ? line : line.slice(0, colon);
    let value = colon < 0 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'data') this.#data.push(value);
    else if (field === 'event') this.#event = value;
  }
}

/** One OpenAI-format SSE event. */
export const sseData = (payload: unknown): string => `data: ${JSON.stringify(payload)}\n\n`;
export const SSE_DONE = 'data: [DONE]\n\n';

/**
 * A provider's event stream in, OpenAI-format SSE out. Each provider event is converted and written as soon
 * as it is complete; nothing but the parser's incomplete trailing line is held.
 */
export abstract class SseTranslator extends Transform {
  readonly #parser = new SseParser();

  /** OpenAI SSE text for one provider event ('' for none). */
  protected abstract onEvent(event: SseEvent): string;
  /** What to write when the provider's stream ends. */
  protected abstract onEnd(): string;

  override _transform(chunk: Buffer, _enc: BufferEncoding, done: TransformCallback) {
    let out = '';
    for (const ev of this.#parser.push(chunk)) out += this.onEvent(ev);
    if (out) this.push(out);
    done();
  }

  override _flush(done: TransformCallback) {
    let out = '';
    for (const ev of this.#parser.end()) out += this.onEvent(ev);
    out += this.onEnd();
    if (out) this.push(out);
    done();
  }
}
