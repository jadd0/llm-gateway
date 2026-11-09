import { readFileSync } from 'node:fs';
import type { Transform } from 'node:stream';
import type { ChatBody } from '../request-body.ts';
import type { AdapterClock, BuildInput } from './types.ts';

export const fixture = (name: string): Buffer => readFileSync(new URL(`./fixtures/${name}`, import.meta.url));

export const clock: AdapterClock = { now: () => 1_700_000_000, newId: () => 'fixed-id' };

/** Writes `input` to a transform in pieces of `size` bytes and returns everything it produced. */
export async function run(t: Transform, input: Buffer, size = input.length): Promise<string> {
  const out: string[] = [];
  t.on('data', (c: Buffer | string) => out.push(c.toString()));
  const done = new Promise<void>((resolve, reject) => {
    t.on('end', resolve);
    t.on('error', reject);
  });
  for (let i = 0; i < input.length; i += size) t.write(input.subarray(i, i + size));
  t.end();
  await done;
  return out.join('');
}

/** OpenAI SSE text to its events: parsed JSON, or the string '[DONE]'. */
export function openaiEvents(sse: string): any[] {
  return sse
    .split('\n\n')
    .filter(Boolean)
    .map((e) => {
      expect_prefix(e);
      const data = e.slice(6);
      return data === '[DONE]' ? data : JSON.parse(data);
    });
}
function expect_prefix(e: string) {
  if (!e.startsWith('data: ')) throw new Error(`not an SSE data event: ${e.slice(0, 40)}`);
}

export const chatBody = (extra: Record<string, unknown> = {}): ChatBody =>
  ({ model: 'm', messages: [{ role: 'user', content: 'hi' }], ...extra }) as ChatBody;

export function input(body: ChatBody, over: Partial<BuildInput> = {}): BuildInput {
  return { body, raw: Buffer.from(JSON.stringify(body)), metered: true, defaultMaxTokens: 1024, apiKey: 'test-key', ...over };
}
