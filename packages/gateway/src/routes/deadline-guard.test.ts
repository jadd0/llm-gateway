import { describe, expect, it } from 'vitest';
import { DeadlineGuard, maxDurationEvent } from './chat.ts';

const collect = (g: DeadlineGuard) =>
  new Promise<string>((resolve) => {
    const parts: Buffer[] = [];
    g.on('data', (c: Buffer) => parts.push(c));
    g.on('end', () => resolve(Buffer.concat(parts).toString('utf8')));
  });

describe('DeadlineGuard.cutWith', () => {
  it('cuts a stream that is still arriving, once, and says so', async () => {
    const g = new DeadlineGuard(true);
    const out = collect(g);
    g.write('data: {"a":1}\n\n');
    expect(g.cutWith(maxDurationEvent)).toBe(true);
    expect(g.cutWith(maxDurationEvent)).toBe(false);
    g.write('data: {"late":1}\n\n'); // dropped
    expect(await out).toBe(`data: {"a":1}\n\n\n\n${maxDurationEvent}`);
  });

  it('does nothing to an answer that had already arrived whole: no cut, so no max-duration code', async () => {
    const g = new DeadlineGuard(true);
    const out = collect(g);
    g.write('data: {"a":1}\n\n');
    g.end('data: [DONE]\n\n');
    expect(await out).toBe('data: {"a":1}\n\ndata: [DONE]\n\n');
    expect(g.cutWith(maxDurationEvent)).toBe(false);
  });
});
