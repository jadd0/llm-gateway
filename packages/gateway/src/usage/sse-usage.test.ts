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
