import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { describe, expect, it } from 'vitest';
import { parseUsage, SseUsageTap, usageFromBody, type Usage } from './sse-usage.ts';

const usage = { prompt_tokens: 11, completion_tokens: 22, total_tokens: 33 };
const event = (o: object) => `data: ${JSON.stringify(o)}\n\n`;
const stream =
  event({ choices: [{ delta: { content: 'a' } }], usage: null }) +
  event({ choices: [{ delta: { content: 'é€' } }], usage: null }) +
  event({ choices: [], usage }) +
  'data: [DONE]\n\n';

async function run(chunks: Buffer[]) {
  let got: { called: number; usage: Usage | undefined } = { called: 0, usage: undefined };
  const out: Buffer[] = [];
  const tap = new SseUsageTap((u) => {
    got = { called: got.called + 1, usage: u };
  });
  tap.on('data', (c: Buffer) => out.push(c));
  await pipeline(Readable.from(chunks), tap);
  return { got, out: Buffer.concat(out) };
}

describe('SseUsageTap', () => {
  it('extracts usage from the final chunk; bytes out equal bytes in', async () => {
    const bytes = Buffer.from(stream);
    const { got, out } = await run([bytes]);
    expect(got).toEqual({ called: 1, usage: { promptTokens: 11, completionTokens: 22, totalTokens: 33 } });
    expect(out.equals(bytes)).toBe(true);
  });

  it('finds the usage however the bytes are split, including inside a multi-byte character', async () => {
    const bytes = Buffer.from(stream);
    for (const size of [1, 2, 3, 7, 50, bytes.length]) {
      const chunks: Buffer[] = [];
      for (let i = 0; i < bytes.length; i += size) chunks.push(bytes.subarray(i, i + size));
      const { got, out } = await run(chunks);
      expect(got.usage?.totalTokens).toBe(33);
      expect(out.equals(bytes)).toBe(true);
    }
  });

  it('chunks are forwarded immediately, not held until the stream ends', async () => {
    const tap = new SseUsageTap(() => {});
    const seen: string[] = [];
    tap.on('data', (c: Buffer) => seen.push(c.toString()));
    tap.write(Buffer.from(event({ choices: [], usage: null })));
    await new Promise((r) => setImmediate(r));
    expect(seen).toHaveLength(1); // out before end() was called
    tap.end();
  });

  it('reports no usage when the stream has none, and never when it is destroyed early', async () => {
    const none = await run([Buffer.from(event({ choices: [], usage: null }) + 'data: [DONE]\n\n')]);
    expect(none.got).toEqual({ called: 1, usage: undefined });

    let called = 0;
    const tap = new SseUsageTap(() => void called++);
    tap.on('data', () => {});
    tap.write(Buffer.from(event({ choices: [], usage })));
    tap.destroy();
    await new Promise((r) => setTimeout(r, 20));
    expect(called).toBe(0);
  });

  it('a usage that is not a data line is ignored', async () => {
    const { got } = await run([Buffer.from(`: comment "usage": {"total_tokens": 9}\nevent: x\n\n`)]);
    expect(got.usage).toBeUndefined();
  });
});

describe('SseUsageTap with stripping', () => {
  const content = event({ choices: [{ delta: { content: 'a' } }], usage: null });
  const usageOnly = event({ choices: [], usage });
  const done = 'data: [DONE]\n\n';

  async function strip(chunks: Buffer[]) {
    let got: Usage | undefined;
    let called = 0;
    const out: Buffer[] = [];
    const tap = new SseUsageTap((u) => {
      got = u;
      called++;
    }, { stripUsageChunk: true });
    tap.on('data', (c: Buffer) => out.push(c));
    await pipeline(Readable.from(chunks), tap);
    return { got, called, out: Buffer.concat(out).toString() };
  }

  it('drops the usage-only event, keeps every other byte, and still reads the usage', async () => {
    const all = Buffer.from(content + content + usageOnly + done);
    const { got, called, out } = await strip([all]);
    expect(out).toBe(content + content + done);
    expect(got?.totalTokens).toBe(33);
    expect(called).toBe(1);
  });

  it('does the same however the bytes are split', async () => {
    const all = Buffer.from(content + usageOnly + done);
    for (const size of [1, 2, 5, 17, 64, all.length]) {
      const chunks: Buffer[] = [];
      for (let i = 0; i < all.length; i += size) chunks.push(all.subarray(i, i + size));
      const { got, out } = await strip(chunks);
      expect(out).toBe(content + done);
      expect(got?.totalTokens).toBe(33);
    }
  });

  it('keeps a usage chunk that also carries choices, and a stream without any usage', async () => {
    const withChoice = event({ choices: [{ delta: {}, finish_reason: 'stop' }], usage });
    expect((await strip([Buffer.from(withChoice + done)])).out).toBe(withChoice + done);
    const none = await strip([Buffer.from(content + done)]);
    expect(none.out).toBe(content + done);
    expect(none.got).toBeUndefined();
    expect(none.called).toBe(1);
  });

  it('holds back only the event in progress', async () => {
    const tap = new SseUsageTap(() => {}, { stripUsageChunk: true });
    const seen: string[] = [];
    tap.on('data', (c: Buffer) => seen.push(c.toString()));
    tap.write(Buffer.from(content));
    await new Promise((r) => setImmediate(r));
    expect(seen.join('')).toBe(content); // a complete event is out at once
    tap.write(Buffer.from(content.slice(0, 20)));
    await new Promise((r) => setImmediate(r));
    expect(seen.join('')).toBe(content); // half an event waits for its other half
    tap.write(Buffer.from(content.slice(20)));
    await new Promise((r) => setImmediate(r));
    expect(seen.join('')).toBe(content + content);
    tap.end();
  });
});

describe('large events in strip mode', () => {
  const run = async (chunks: Iterable<Buffer>) => {
    let got: Usage | undefined;
    const out: Buffer[] = [];
    const tap = new SseUsageTap((u) => (got = u), { stripUsageChunk: true });
    tap.on('data', (c: Buffer) => out.push(c));
    await pipeline(Readable.from(chunks), tap);
    return { got, out: Buffer.concat(out) };
  };

  it('1 MiB event fed byte by byte finishes under 2 s', async () => {
    const head = Buffer.from('data: {"choices":[{"delta":{"content":"');
    const tail = Buffer.from('"}}],"usage":null}\n\n');
    const filler = Buffer.alloc(1_000_000, 0x61);
    const whole = Buffer.concat([head, filler, tail, Buffer.from(event({ choices: [], usage }))]);
    expect(whole.length).toBeGreaterThan(1_000_000);
    const bytes = Array.from({ length: whole.length }, (_, i) => whole.subarray(i, i + 1));
    const started = performance.now();
    const { got, out } = await run(bytes);
    const elapsed = performance.now() - started;
    expect(got?.totalTokens).toBe(33);
    // The big event is forwarded whole; only the usage-only event is dropped.
    expect(out.length).toBe(head.length + filler.length + tail.length);
    expect(elapsed).toBeLessThan(2000);
  }, 20_000);

  it('overflow fallback still finds usage', async () => {
    // Lines of an event that never ends until past 1 MiB. The usage line is cut inside a two-byte
    // character exactly where the held bytes overflow, so only a primed decoder reads it whole.
    const filler = Buffer.from(`data: {"filler":"${'x'.repeat(1_048_540)}"}\n`);
    const usageLine = Buffer.from(`data: {"choices":[],"usage":${JSON.stringify(usage)},"n":"é"}\n\n`);
    const cut = usageLine.indexOf(Buffer.from('é')) + 1;
    const first = Buffer.concat([filler, usageLine.subarray(0, cut)]);
    expect(first.length).toBeGreaterThan(1024 * 1024);
    const after = Buffer.from(event({ choices: [{ delta: { content: 'z' } }], usage: null }) + 'data: [DONE]\n\n');
    const input = Buffer.concat([first, usageLine.subarray(cut), after]);
    const { got, out } = await run([first, Buffer.concat([usageLine.subarray(cut), after])]);
    expect(got?.totalTokens).toBe(33);
    // Stripping stops at the fallback, so every byte is forwarded unchanged.
    expect(out.equals(input)).toBe(true);
  });
});

describe('event terminators', () => {
  const body = (eol: string) => `data: {"choices":[{"delta":{"content":"a"}}],"usage":null}${eol}`;

  it.each(['\n\n', '\r\r', '\r\n\r\n', '\n\r\n', '\r\n\n', '\r\n\r', '\n\r'])(
    'terminator %j closes an event: events pass through one at a time and the bytes are untouched',
    async (eol) => {
      const tap = new SseUsageTap(() => {}, { stripUsageChunk: true });
      const seen: string[] = [];
      tap.on('data', (c: Buffer) => seen.push(c.toString()));
      let sent = '';
      for (let i = 0; i < 3; i++) {
        tap.write(Buffer.from(body(eol)));
        sent += body(eol);
        await new Promise((r) => setImmediate(r));
        expect(seen.join('')).toBe(sent); // out now, not held until 1 MiB
      }
      tap.end();
    },
  );

  it('strips the usage-only event whatever ends it, and still reads the usage', async () => {
    for (const eol of ['\r\r', '\r\n\r\n', '\n\r\n']) {
      const tap = new SseUsageTap(() => {}, { stripUsageChunk: true });
      const out: Buffer[] = [];
      tap.on('data', (c: Buffer) => out.push(c));
      const keep = body(eol);
      const only = `data: ${JSON.stringify({ choices: [], usage })}${eol}`;
      await pipeline(Readable.from([Buffer.from(keep + only + `data: [DONE]${eol}`)]), tap);
      expect(Buffer.concat(out).toString()).toBe(keep + `data: [DONE]${eol}`);
    }
  });
});

describe('multi-byte characters', () => {
  it('a character split across chunks inside the usage event still settles', async () => {
    const ev = event({ model: 'é€😀', choices: [], usage });
    const all = Buffer.from(ev + 'data: [DONE]\n\n');
    for (let cut = 1; cut < all.length; cut++) {
      const { got, out } = await run([all.subarray(0, cut), all.subarray(cut)]);
      expect(got.usage?.totalTokens).toBe(33);
      expect(out.equals(all)).toBe(true);
    }
  });
});

describe('usage parsing', () => {
  it('reads usage from a non-streamed body', () => {
    expect(usageFromBody(Buffer.from(JSON.stringify({ usage })))?.totalTokens).toBe(33);
    expect(usageFromBody(Buffer.from('{"choices":[]}'))).toBeUndefined();
    expect(usageFromBody(Buffer.from('not json "usage": {'))).toBeUndefined();
  });

  it('derives the total when the provider omits it, and rejects nonsense', () => {
    expect(parseUsage({ prompt_tokens: 4, completion_tokens: 6 })?.totalTokens).toBe(10);
    expect(parseUsage({ total_tokens: -1 })).toBeUndefined();
    expect(parseUsage({})).toBeUndefined();
    expect(parseUsage(null)).toBeUndefined();
    expect(parseUsage({ total_tokens: 'many' })).toBeUndefined();
  });
});
