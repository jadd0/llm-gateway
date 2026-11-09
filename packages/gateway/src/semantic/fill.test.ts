import { randomBytes } from 'node:crypto';
import { like } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';
import { createDb } from '../db/client.ts';
import { semanticCache } from '../db/schema.ts';
import { testConfig } from '../test-env.ts';
import { createSemanticFill, type FillJob } from './fill.ts';
import { createSemanticStore, type SemanticStore } from './store.ts';
import { angle, stubEmbedder } from './test-support.ts';

const config = testConfig();
const handle = createDb({ databaseUrl: config.databaseUrl, poolSize: 4 });
const store = createSemanticStore(handle.db);
const run = randomBytes(4).toString('hex');
const NOW = new Date('2030-01-01T00:00:00Z').getTime();
const job = (text: string, n = 0, tag = 's'): FillJob => ({ scope: `${run}-${tag}`, split: { text, contextHash: 'd'.repeat(64) }, exactKey: `k-${text}-${n}`, ttlS: 600 });
const rows = (tag: string) => handle.db.select().from(semanticCache).where(like(semanticCache.scope, `${run}-${tag}`));

afterAll(async () => {
  await handle.db.delete(semanticCache).where(like(semanticCache.scope, `${run}%`));
  await handle.close();
});

describe('semantic fill', () => {
  it('fill runs after the response is sent', async () => {
    const stub = stubEmbedder({ hello: angle(5) });
    stub.hold();
    const fill = createSemanticFill({ embedder: stub.embedder, store, queueMax: 10, maxChars: 100, clock: () => NOW });
    // enqueue returns at once, while the embedding has not even been answered: nothing waits for it.
    expect(fill.enqueue(job('hello', 0, 'one'))).toBe(true);
    expect(await rows('one')).toHaveLength(0);
    expect(stub.calls).toEqual([{ text: 'hello', patient: true }]);
    stub.release();
    await fill.idle();
    const [row] = await rows('one');
    expect(row).toMatchObject({ scope: `${run}-one`, exactKey: 'k-hello-0', embedder: 'voyage-4-lite' });
    // The row lives as long as the answer does.
    expect(row!.expiresAt.getTime()).toBe(NOW + 600_000);
    expect(fill.stats()).toMatchObject({ filled: 1, dropped: 0, failed: 0 });
  });

  it('full queue drops, counted', async () => {
    const texts = Array.from({ length: 20 }, (_, i) => `t${i}`);
    const stub = stubEmbedder(Object.fromEntries(texts.map((t, i) => [t, angle(i)])));
    stub.hold();
    const warnings: object[] = [];
    const fill = createSemanticFill({ embedder: stub.embedder, store, queueMax: 5, maxChars: 100, concurrency: 2, log: { warn: (o) => void warnings.push(o) } });
    // 2 start at once (in flight), 5 wait, the other 13 are dropped.
    const accepted = texts.map((t) => fill.enqueue(job(t, 0, 'two')));
    expect(accepted.filter(Boolean)).toHaveLength(7);
    expect(accepted.slice(0, 7).every(Boolean)).toBe(true);
    expect(fill.stats()).toMatchObject({ queued: 5, inFlight: 2, dropped: 13 });
    expect(warnings).toHaveLength(1);
    stub.release();
    await fill.idle();
    expect(fill.stats()).toMatchObject({ filled: 7, dropped: 13, queued: 0, inFlight: 0 });
    expect(await rows('two')).toHaveLength(7);
  });

  it('a prompt with no embedding, or a store that fails, is counted and costs nothing else', async () => {
    const stub = stubEmbedder({ ok: angle(1) });
    const failing: SemanticStore = { ...store, upsert: async () => Promise.reject(Object.assign(new Error('prompt text'), { code: 'XX000' })) };
    const logged: object[] = [];
    const fill = createSemanticFill({ embedder: stub.embedder, store: failing, queueMax: 5, maxChars: 100, log: { warn: (o) => void logged.push(o) } });
    fill.enqueue(job('missing'));
    fill.enqueue(job('ok'));
    await fill.idle();
    expect(fill.stats()).toMatchObject({ failed: 2, filled: 0 });
    expect(logged).toEqual([{ errClass: 'Error', code: 'XX000', op: 'fill' }]);
  });

  it('a Drizzle-wrapped Postgres error is logged with the code of its cause and none of its text', async () => {
    const stub = stubEmbedder({ ok: angle(1) });
    const wrapped = Object.assign(new Error('Failed query: insert ... prompt text', { cause: Object.assign(new Error('prompt text'), { code: '57P01' }) }), { name: 'DrizzleQueryError' });
    const failing: SemanticStore = { ...store, upsert: async () => Promise.reject(wrapped) };
    const logged: object[] = [];
    const fill = createSemanticFill({ embedder: stub.embedder, store: failing, queueMax: 5, maxChars: 100, log: { warn: (o) => void logged.push(o) } });
    fill.enqueue(job('ok'));
    await fill.idle();
    expect(logged).toEqual([{ errClass: 'DrizzleQueryError', code: '57P01', op: 'fill' }]);
  });

  it('a prompt over the length limit is not queued; a closed fill takes nothing', async () => {
    const stub = stubEmbedder({});
    const fill = createSemanticFill({ embedder: stub.embedder, store, queueMax: 5, maxChars: 4 });
    expect(fill.enqueue(job('12345'))).toBe(false);
    expect(fill.stats().dropped).toBe(0);
    await fill.close();
    expect(fill.enqueue(job('1'))).toBe(false);
    expect(stub.calls).toHaveLength(0);
  });
});
