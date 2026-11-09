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

// Index just past the first blank line (the end of an SSE event), or -1 while the event is incomplete.
function eventEnd(buf: Buffer): number {
  const lf = buf.indexOf('\n\n');
  const crlf = buf.indexOf('\r\n\r\n');
  const a = lf < 0 ? Infinity : lf + 2;
  const b = crlf < 0 ? Infinity : crlf + 4;
  const end = Math.min(a, b);
  return end === Infinity ? -1 : end;
}

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
  private pending: Buffer = EMPTY;
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
      if (this.pending.length > 0) {
        if (!this.inspect(this.pending.toString('utf8'))) this.push(this.pending);
        this.pending = EMPTY;
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

  private stripChunk(chunk: Buffer): void {
    let buf = this.pending.length > 0 ? Buffer.concat([this.pending, chunk]) : chunk;
    for (let end = eventEnd(buf); end >= 0; end = eventEnd(buf)) {
      const event = buf.subarray(0, end);
      buf = buf.subarray(end);
      if (!this.inspect(event.toString('utf8'))) this.push(event);
    }
    if (buf.length > MAX_LINE) {
      // Not an event worth holding: forward it and stop stripping.
      this.push(buf);
      this.pending = EMPTY;
      this.strip = false;
      return;
    }
    this.pending = buf.length > 0 ? Buffer.from(buf) : EMPTY;
  }

  // Reads the usage in a complete event. True when the event is the usage-only chunk.
  private inspect(text: string): boolean {
    let usageOnly = false;
    for (const l of text.split(/\r?\n/)) {
      const parsed = this.parseLine(l);
      if (parsed === undefined) continue;
      this.last = parsed.usage;
      if (parsed.emptyChoices) usageOnly = true;
    }
    return usageOnly;
  }

  private scan(text: string): void {
    const parts = (this.carry + text).split('\n');
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
