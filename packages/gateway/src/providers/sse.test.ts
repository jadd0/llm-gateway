import { describe, expect, it } from 'vitest';
import { SseParser, type SseEvent } from './sse.ts';
import { fixture } from './test-support.ts';

function parseAll(bytes: Buffer, size: number): SseEvent[] {
  const p = new SseParser();
  const out: SseEvent[] = [];
  for (let i = 0; i < bytes.length; i += size) out.push(...p.push(bytes.subarray(i, i + size)));
  out.push(...p.end());
  return out;
}

describe('SseParser', () => {
  const names = [
    'anthropic-stream.sse',
    'anthropic-stream-unicode.sse',
    'anthropic-stream-error.sse',
    'gemini-stream.sse', // CRLF line endings
    'gemini-stream-unicode.sse',
    'openai-stream.sse',
  ];

  it('events split at every byte boundary parse identically', () => {
    for (const name of names) {
      const bytes = fixture(name);
      const whole = parseAll(bytes, bytes.length);
      expect(whole.length, name).toBeGreaterThan(2);
      for (let size = 1; size < 8; size++) expect(parseAll(bytes, size), `${name} in ${size}-byte pieces`).toEqual(whole);
      // Two pieces, cut at every possible offset.
      for (let cut = 1; cut < bytes.length; cut++) {
        const p = new SseParser();
        const got = [...p.push(bytes.subarray(0, cut)), ...p.push(bytes.subarray(cut)), ...p.end()];
        expect(got, `${name} cut at ${cut}`).toEqual(whole);
      }
    }
  });

  it('a multi-byte character split across chunks decodes correctly', () => {
    const bytes = Buffer.from('data: {"t":"مرحبا 👋🏽"}\n\n', 'utf8');
    const emoji = bytes.indexOf(Buffer.from('👋'));
    // Cut inside the 4-byte emoji and inside a 2-byte Arabic letter.
    for (const cut of [emoji + 1, emoji + 2, emoji + 3, bytes.indexOf(Buffer.from('م')) + 1]) {
      const p = new SseParser();
      const got = [...p.push(bytes.subarray(0, cut)), ...p.push(bytes.subarray(cut)), ...p.end()];
      expect(got).toEqual([{ event: undefined, data: '{"t":"مرحبا 👋🏽"}' }]);
    }
  });

  it('handles named events, multi-line data, comments, all three line endings and a final unterminated event', () => {
    const text = ': keep-alive\nevent: a\ndata: 1\ndata: 2\n\r\ndata: x\r\r\ndata:y\n\ndata: tail';
    expect(parseAll(Buffer.from(text), 3)).toEqual([
      { event: 'a', data: '1\n2' },
      { event: undefined, data: 'x' },
      { event: undefined, data: 'y' },
      { event: undefined, data: 'tail' },
    ]);
  });

  it('a long event arriving a byte at a time is scanned once, not from its start on every push', () => {
    const bytes = Buffer.from(`data: ${'a'.repeat(300_000)}\n\n`);
    const p = new SseParser();
    const got: SseEvent[] = [];
    const started = performance.now();
    for (let i = 0; i < bytes.length; i++) got.push(...p.push(bytes.subarray(i, i + 1)));
    const ms = performance.now() - started;
    expect(got).toEqual([{ event: undefined, data: 'a'.repeat(300_000) }]);
    // A rescan per push is about 4.5e10 character reads (seconds); one scan is a few ms.
    expect(ms).toBeLessThan(10_000);
  });
});
