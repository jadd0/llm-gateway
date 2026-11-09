import http, { type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fallbackEmbedder, localEmbedder, unit, voyageEmbedder, type Embedder } from './embedder.ts';

const DIM = 8;
const ramp = (n: number) => Array.from({ length: n }, (_, i) => i + 1);

interface Seen {
  path: string;
  auth: string | undefined;
  body: Record<string, unknown>;
}
let server: Server;
let origin = '';
const seen: Seen[] = [];
// What the stub does with the next request: answer, answer late, or answer wrongly.
let mode: 'ok' | 'slow' | 'error' | 'short' | 'zero' = 'ok';

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
      seen.push({ path: req.url ?? '', auth: req.headers.authorization, body });
      const reply = () => {
        if (mode === 'error') {
          res.writeHead(500).end('{}');
          return;
        }
        const vec = mode === 'short' ? ramp(DIM - 1) : mode === 'zero' ? new Array(DIM).fill(0) : ramp(DIM).map((x) => x * 3);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(req.url?.endsWith('/embeddings') ? { data: [{ embedding: vec }] } : { embeddings: [vec] }));
      };
      if (mode === 'slow') setTimeout(reply, 400);
      else reply();
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
});

const voyage = (over: Partial<Parameters<typeof voyageEmbedder>[0]> = {}) =>
  voyageEmbedder({ apiKey: 'key-123', baseUrl: `${origin}/v1`, model: 'voyage-4-lite', dimensions: DIM, timeoutMs: 100, inputType: 'none', ...over });
const local = (over: Partial<Parameters<typeof localEmbedder>[0]> = {}) =>
  localEmbedder({ baseUrl: origin, model: 'hf.co/x/voyage-4-nano-GGUF:Q8_0', dimensions: DIM, timeoutMs: 100, inputType: 'none', ...over });
const norm = (v: number[]) => Math.sqrt(v.reduce((a, x) => a + x * x, 0));
const reset = (m: typeof mode = 'ok') => {
  seen.length = 0;
  mode = m;
};

const local2 = (): Embedder => ({ embed: async () => ({ vector: [1], embedder: 'voyage-4-nano' }) });

describe('embedders', () => {
  it('voyage request shape (model, input_type, output_dimension, auth)', async () => {
    reset();
    const got = await voyage().embed('hello');
    expect(got?.embedder).toBe('voyage-4-lite');
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      path: '/v1/embeddings',
      auth: 'Bearer key-123',
      body: { input: ['hello'], model: 'voyage-4-lite', output_dimension: DIM, output_dtype: 'float' },
    });
    // No input_type unless asked for.
    expect('input_type' in seen[0]!.body).toBe(false);
    reset();
    await voyage({ inputType: 'query' }).embed('hello');
    expect(seen[0]!.body.input_type).toBe('query');
  });

  it('local request shape: Ollama /api/embed with the dimensions, NFC text and an optional query prompt', async () => {
    reset();
    const got = await local().embed('café');
    expect(got?.embedder).toBe('voyage-4-nano');
    expect(seen[0]).toMatchObject({ path: '/api/embed', body: { model: 'hf.co/x/voyage-4-nano-GGUF:Q8_0', dimensions: DIM, input: ['café'] } });
    reset();
    await local({ inputType: 'query' }).embed('q');
    expect(seen[0]!.body.input).toEqual(['Represent the query for retrieving supporting documents: q']);
  });

  it('vectors are unit length', async () => {
    reset();
    for (const e of [voyage(), local()]) {
      const got = (await e.embed('x'))!;
      expect(got.vector).toHaveLength(DIM);
      expect(norm(got.vector)).toBeCloseTo(1, 10);
    }
    expect(norm(unit([3, 4])!)).toBeCloseTo(1, 12);
    expect(unit([0, 0])).toBeUndefined();
    expect(unit([1, Number.NaN])).toBeUndefined();
  });

  it('a wrong-length vector, an error status and a zero vector are no vector', async () => {
    for (const m of ['short', 'error', 'zero'] as const) {
      reset(m);
      expect(await voyage().embed('x'), m).toBeUndefined();
      expect(await local().embed('x'), m).toBeUndefined();
    }
  });

  it('voyage timeout falls back to local', async () => {
    reset('slow');
    const slowVoyage = voyage({ timeoutMs: 60 });
    const fast: Embedder = { embed: async () => ({ vector: unit(ramp(DIM))!, embedder: 'voyage-4-nano' }) };
    const both = fallbackEmbedder(slowVoyage, fast, { backoffMs: 10_000 });
    const t0 = performance.now();
    const got = await both.embed('x');
    expect(got?.embedder).toBe('voyage-4-nano');
    expect(performance.now() - t0).toBeLessThan(350);
    // The primary is left alone while it backs off: no second request goes to it.
    const before = seen.length;
    await both.embed('y');
    expect(seen.length).toBe(before);
  });

  it('the primary is tried again once its back-off has passed', async () => {
    reset('error');
    let t = 1_000;
    const both = fallbackEmbedder(voyage(), local2(), { backoffMs: 5_000, clock: () => t });
    await both.embed('a');
    expect(seen).toHaveLength(1);
    t += 4_999;
    await both.embed('b');
    expect(seen).toHaveLength(1);
    mode = 'ok';
    t += 1;
    expect((await both.embed('c'))?.embedder).toBe('voyage-4-lite');
    expect(seen).toHaveLength(2);
  });

  it('no voyage key uses local', async () => {
    reset();
    const got = await fallbackEmbedder(undefined, local(), { backoffMs: 1000 }).embed('x');
    expect(got?.embedder).toBe('voyage-4-nano');
    expect(seen.map((s) => s.path)).toEqual(['/api/embed']);
  });

  it('both down returns undefined within both budgets', async () => {
    reset('slow');
    const both = fallbackEmbedder(voyage({ timeoutMs: 80 }), local({ timeoutMs: 60 }), { backoffMs: 10_000 });
    const t0 = performance.now();
    expect(await both.embed('x')).toBeUndefined();
    const took = performance.now() - t0;
    expect(took).toBeGreaterThanOrEqual(120);
    expect(took).toBeLessThan(380);
    // A refused connection is no vector either, and no throw.
    const dead = localEmbedder({ baseUrl: 'http://127.0.0.1:9', model: 'm', dimensions: DIM, timeoutMs: 100, inputType: 'none' });
    expect(await dead.embed('x')).toBeUndefined();
  });

  it('a patient caller waits longer for the primary, but goes straight to local while the primary backs off', async () => {
    reset('slow');
    // 400 ms reply: the request path (60 ms) gives up, the patient path (600 ms) waits for it.
    const fresh = fallbackEmbedder(voyage({ timeoutMs: 60 }), local({ timeoutMs: 60 }), { backoffMs: 10_000 });
    expect((await fresh.embed('x', { patient: true }))?.embedder).toBe('voyage-4-lite');

    // A request that failed started the back-off: the fill does not wait on the primary either.
    const both = fallbackEmbedder(voyage({ timeoutMs: 60 }), local({ timeoutMs: 60 }), { backoffMs: 10_000 });
    expect(await both.embed('x')).toBeUndefined();
    seen.length = 0;
    await both.embed('x', { patient: true });
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((s) => s.path === '/api/embed')).toBe(true);
  });

  it('a patient failure starts the back-off for everyone', async () => {
    reset('error');
    const both = fallbackEmbedder(voyage(), local2(), { backoffMs: 10_000 });
    await both.embed('x', { patient: true });
    expect(seen).toHaveLength(1);
    await both.embed('y');
    await both.embed('z', { patient: true });
    expect(seen).toHaveLength(1);
  });
});
