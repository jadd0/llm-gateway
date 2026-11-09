import { StringDecoder } from 'node:string_decoder';
import { Transform, type TransformCallback } from 'node:stream';

export interface Usage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

const isCount = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n >= 0;

// `usage` objects as providers send them. total_tokens is trusted when present; otherwise the parts.
export function parseUsage(raw: unknown): Usage | undefined {
  const u = raw as { prompt_tokens?: unknown; completion_tokens?: unknown; total_tokens?: unknown } | null;
  if (typeof u !== 'object' || u === null) return undefined;
  const promptTokens = isCount(u.prompt_tokens) ? u.prompt_tokens : 0;
  const completionTokens = isCount(u.completion_tokens) ? u.completion_tokens : 0;
  const totalTokens = isCount(u.total_tokens) ? u.total_tokens : promptTokens + completionTokens;
  if (!isCount(u.total_tokens) && !isCount(u.prompt_tokens) && !isCount(u.completion_tokens)) return undefined;
  return { promptTokens, completionTokens, totalTokens };
}

const HAS_USAGE = /"usage"\s*:\s*\{/;

// Usage from a non-streamed JSON response body, or undefined when there is none.
export function usageFromBody(body: Buffer): Usage | undefined {
  const text = body.toString('utf8');
  if (!HAS_USAGE.test(text)) return undefined;
  try {
    return parseUsage((JSON.parse(text) as { usage?: unknown }).usage);
  } catch {
    return undefined;
  }
}

// A line (or, when stripping, an event) longer than this is not something the gateway needs to read;
// it is forwarded or skipped rather than held without bound.
const MAX_LINE = 1024 * 1024;

const EMPTY = Buffer.alloc(0);

// Where the scan for the end of an SSE event stands between chunks. A line ends with \n, \r or \r\n, and
// an event ends at an empty line, so any two line endings in a row close it (\n\n, \r\r, \r\n\r\n, \n\r\n,
// \r\n\n, ...). A lone \r at the very end of the data might be the start of \r\n, so after content it waits
// for the next byte; after a line ending it closes the event at once (a following \n becomes an empty line
// at the start of the next). The bytes are only inspected, never changed.
interface EventScan {
  /** The last byte seen ended a line. */
  afterEol: boolean;
  /** The last byte was a \r after content: whether it is a line of its own or half of \r\n depends on the next byte. */
  heldCr: boolean;
}

const freshScan = (): EventScan => ({ afterEol: false, heldCr: false });

// Index just past the end of the event inside `buf`, or -1 when it is still open; `st` carries what was
// learnt, so the next call starts where this one stopped instead of from the event's first byte.
function eventEnd(buf: Buffer, st: EventScan): number {
  let i = 0;
  if (st.heldCr && buf.length > 0) {
    st.heldCr = false;
    st.afterEol = true;
    if (buf[0] === 10) i = 1; // it was \r\n
  }
  while (i < buf.length) {
    const c = buf[i]!;
    if (c !== 10 && c !== 13) {
      st.afterEol = false;
      i++;
      continue;
    }
    let len = 1;
    if (c === 13) {
      if (i + 1 >= buf.length) {
        if (st.afterEol) return i + 1;
        st.heldCr = true;
        return -1;
      }
      if (buf[i + 1] === 10) len = 2;
    }
    i += len;
    if (st.afterEol) return i;
    st.afterEol = true;
  }
  return -1;
}

const LINE_END = /\r\n|\r|\n/;

export interface SseUsageTapOptions {
  /**
   * Drops the usage-only event (`choices: []` plus `usage`) from what is forwarded, for a client that
   * did not ask for usage. Only the event in progress is held back; every other event is forwarded as
   * soon as it is complete.
   */
  stripUsageChunk?: boolean;
}

/**
 * Pass-through tap on an SSE response. Without stripping, every chunk is forwarded the moment it
 * arrives, byte for byte. The tap reads complete `data: {` lines that carry a `usage` object. `onEnd`
 * runs once when the stream finishes, with the last usage seen (undefined when none came). A stream
 * that is destroyed early (client left, upstream died) never reaches it.
 */
export class SseUsageTap extends Transform {
  private readonly decoder = new StringDecoder('utf8');
  private carry = '';
  private skipping = false;
  private last: Usage | undefined;
  private strip: boolean;
  // The event in progress, as the chunks that made it: joined once, when its end arrives, so an event
  // delivered in many small pieces is copied once rather than on every piece.
  private held: Buffer[] = [];
  private heldBytes = 0;
  private readonly scanState = freshScan();
  private readonly onEnd: (usage: Usage | undefined) => void;

  constructor(onEnd: (usage: Usage | undefined) => void, opts: SseUsageTapOptions = {}) {
    super();
    this.onEnd = onEnd;
    this.strip = opts.stripUsageChunk === true;
  }

  override _transform(chunk: Buffer, _enc: BufferEncoding, cb: TransformCallback): void {
    try {
      if (this.strip) this.stripChunk(chunk);
      else {
        this.push(chunk);
        // A decoder keeps a multi-byte character split across chunks together.
        this.scan(this.decoder.write(chunk));
      }
    } catch {
      // Reading usage must never break the stream.
    }
    cb();
  }

  override _flush(cb: TransformCallback): void {
    try {
      if (this.heldBytes > 0) {
        const rest = this.takeHeld();
        if (!this.inspect(rest.toString('utf8'))) this.push(rest);
      }
      if (!this.strip) {
        this.carry += this.decoder.end();
        if (this.carry) this.line(this.carry);
      }
      this.carry = '';
      this.onEnd(this.last);
    } catch {
      // Same: the bytes already went out.
    }
    cb();
  }

  private takeHeld(extra?: Buffer): Buffer {
    const parts = extra ? [...this.held, extra] : this.held;
    const joined = parts.length === 1 ? parts[0]! : Buffer.concat(parts);
    this.held = [];
    this.heldBytes = 0;
    return joined;
  }

  private stripChunk(chunk: Buffer): void {
    let rest = chunk;
    while (rest.length > 0) {
      const end = eventEnd(rest, this.scanState);
      if (end < 0) break;
      const event = this.takeHeld(rest.subarray(0, end));
      rest = rest.subarray(end);
      Object.assign(this.scanState, freshScan());
      if (!this.inspect(event.toString('utf8'))) this.push(event);
    }
    if (rest.length === 0) return;
    this.held.push(Buffer.from(rest)); // the chunk may be reused by its producer
    this.heldBytes += rest.length;
    if (this.heldBytes > MAX_LINE) {
      // Not an event worth holding: forward it and stop stripping. The decoder is primed with what was
      // held, so a character split at this boundary and the usage line after it are still read.
      const all = this.takeHeld();
      this.push(all);
      this.strip = false;
      this.scan(this.decoder.write(all));
    }
  }

  // Reads the usage in a complete event. True when the event is the usage-only chunk.
  private inspect(text: string): boolean {
    let usageOnly = false;
    for (const l of text.split(LINE_END)) {
      const parsed = this.parseLine(l);
      if (parsed === undefined) continue;
      this.last = parsed.usage;
      if (parsed.emptyChoices) usageOnly = true;
    }
    return usageOnly;
  }

  private scan(text: string): void {
    const parts = (this.carry + text).split(LINE_END);
    this.carry = parts.pop() ?? '';
    for (const l of parts) {
      if (this.skipping) {
        this.skipping = false; // the tail of an oversized line
        continue;
      }
      this.line(l);
    }
    if (this.carry.length > MAX_LINE) {
      this.carry = '';
      this.skipping = true;
    }
  }

  private line(l: string): void {
    const parsed = this.parseLine(l);
    if (parsed) this.last = parsed.usage;
  }

  private parseLine(l: string): { usage: Usage; emptyChoices: boolean } | undefined {
    if (!l.startsWith('data: {') || !HAS_USAGE.test(l)) return undefined;
    try {
      const obj = JSON.parse(l.slice(6)) as { usage?: unknown; choices?: unknown };
      const usage = parseUsage(obj.usage);
      if (!usage) return undefined;
      return { usage, emptyChoices: Array.isArray(obj.choices) && obj.choices.length === 0 };
    } catch {
      return undefined; // not JSON we understand
    }
  }
}
