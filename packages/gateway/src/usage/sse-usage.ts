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

// A line longer than this is not an SSE event the gateway needs to read; the carry-over is dropped
// rather than grown without bound.
const MAX_LINE = 1024 * 1024;

/**
 * Pass-through tap on an SSE response. Every chunk is forwarded the moment it arrives, byte for byte;
 * the tap only reads complete `data: {` lines that carry a `usage` object. `onEnd` runs once when the
 * stream finishes, with the last usage seen (undefined when none came). A stream that is destroyed
 * early (client left, upstream died) never reaches it.
 */
export class SseUsageTap extends Transform {
  private carry = '';
  private skipping = false;
  private last: Usage | undefined;

  private readonly onEnd: (usage: Usage | undefined) => void;

  constructor(onEnd: (usage: Usage | undefined) => void) {
    super();
    this.onEnd = onEnd;
  }

  override _transform(chunk: Buffer, _enc: BufferEncoding, cb: TransformCallback): void {
    this.push(chunk);
    try {
      this.scan(chunk.toString('utf8'));
    } catch {
      // Reading usage must never break the stream.
    }
    cb();
  }

  override _flush(cb: TransformCallback): void {
    try {
      if (this.carry) this.line(this.carry);
      this.carry = '';
      this.onEnd(this.last);
    } catch {
      // Same: the bytes already went out.
    }
    cb();
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
    if (!l.startsWith('data: {') || !HAS_USAGE.test(l)) return;
    try {
      const usage = parseUsage((JSON.parse(l.slice(6)) as { usage?: unknown }).usage);
      if (usage) this.last = usage;
    } catch {
      // Not JSON we understand; ignore the line.
    }
  }
}
