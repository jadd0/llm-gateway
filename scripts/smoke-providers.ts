// One tiny live call per provider, streamed and not (max 5 output tokens), through the same adapters the
// gateway uses. Run by hand with real keys; never part of the gate or CI.
//
//   node --env-file-if-exists=.env.local scripts/smoke-providers.ts [--record]
//
// Reads OPENAI_API_KEY, ANTHROPIC_API_KEY and GEMINI_API_KEY; a provider with no key is skipped. It talks
// to the providers' real URLs (SMOKE_*_BASE_URL overrides), not to OPENAI_BASE_URL, which in a dev
// environment usually points at the mock. Prints status, finish reason, token counts and the length of the
// reply: never a key, a request id or a response header.
//
// --record also saves each raw answer under packages/gateway/src/providers/fixtures/recorded/, with the
// provider's ids stripped. Review the files and copy them over the hand-written fixtures when refreshing.
import { mkdirSync, writeFileSync } from 'node:fs';
import { createAnthropicAdapter } from '../packages/gateway/src/providers/anthropic.ts';
import { createGeminiAdapter } from '../packages/gateway/src/providers/gemini.ts';
import { createOpenAiAdapter } from '../packages/gateway/src/providers/openai.ts';
import { SseParser } from '../packages/gateway/src/providers/sse.ts';
import type { Adapter } from '../packages/gateway/src/providers/types.ts';

const record = process.argv.includes('--record');
const outDir = new URL('../packages/gateway/src/providers/fixtures/recorded/', import.meta.url);

interface Live {
  name: string;
  adapter: Adapter;
  baseUrl: string;
  apiKey: string | undefined;
  model: string;
}
const env = process.env;
const targets: Live[] = [
  {
    name: 'openai',
    adapter: createOpenAiAdapter(),
    baseUrl: env.SMOKE_OPENAI_BASE_URL ?? 'https://api.openai.com/v1',
    apiKey: env.OPENAI_API_KEY || undefined,
    model: env.SMOKE_OPENAI_MODEL ?? 'gpt-5-nano',
  },
  {
    name: 'anthropic',
    adapter: createAnthropicAdapter({ version: env.ANTHROPIC_VERSION || '2023-06-01' }),
    baseUrl: env.SMOKE_ANTHROPIC_BASE_URL ?? 'https://api.anthropic.com',
    apiKey: env.ANTHROPIC_API_KEY || undefined,
    model: env.SMOKE_ANTHROPIC_MODEL ?? 'claude-haiku-5-5',
  },
  {
    name: 'gemini',
    adapter: createGeminiAdapter(),
    baseUrl: env.SMOKE_GEMINI_BASE_URL ?? 'https://generativelanguage.googleapis.com/v1beta',
    apiKey: env.GEMINI_API_KEY || undefined,
    model: env.SMOKE_GEMINI_MODEL ?? 'gemini-3.1-flash-lite',
  },
];

// Ids and timestamps are the provider's, and add nothing to a fixture.
const scrub = (text: string) =>
  text
    .replace(/("(?:id|responseId|created|system_fingerprint)"\s*:\s*)(?:"[^"]*"|\d+)/g, '$1"scrubbed"')
    .replace(/(msg_|chatcmpl-|resp_)[A-Za-z0-9_-]+/g, '$1scrubbed');

async function call(t: Live, stream: boolean): Promise<string> {
  const body = {
    model: t.model,
    stream,
    max_completion_tokens: 5,
    messages: [{ role: 'user', content: 'Say hello in one word.' }],
    ...(stream ? { stream_options: { include_usage: true } } : {}),
  };
  const built = t.adapter.buildRequest({
    body,
    raw: Buffer.from(JSON.stringify(body)),
    metered: true,
    defaultMaxTokens: 5,
    apiKey: t.apiKey,
  });
  if (!built.ok) return `refused by adapter: ${built.param}`;
  const url = new URL(t.baseUrl.replace(/\/+$/, '') + built.request.path);
  const res = await fetch(url, { method: 'POST', headers: built.request.headers, body: new Uint8Array(built.request.body) });
  const raw = Buffer.from(await res.arrayBuffer());
  if (record && res.ok) {
    mkdirSync(outDir, { recursive: true });
    writeFileSync(new URL(`${t.name}-${stream ? 'stream.sse' : 'message.json'}`, outDir), scrub(raw.toString('utf8')));
  }
  if (!res.ok) {
    // Type and code only: an error message can quote the key it was sent.
    let err: { type?: string; code?: string } = {};
    try {
      err = t.adapter.translates ? t.adapter.mapError(res.status, raw).body.error : (JSON.parse(raw.toString('utf8')) as { error: typeof err }).error;
    } catch {
      // not JSON
    }
    return `HTTP ${res.status} error type=${err?.type ?? 'unknown'} code=${err?.code ?? 'none'}`;
  }
  if (!stream) {
    const json = t.adapter.translates ? (t.adapter.parseResponse(raw).openaiBody as any) : JSON.parse(raw.toString('utf8'));
    const choice = json.choices?.[0];
    return `HTTP ${res.status} finish=${choice?.finish_reason} reply_chars=${(choice?.message?.content ?? '').length} usage=${JSON.stringify(json.usage)}`;
  }
  // Streamed: count what the client would receive and find the usage.
  let out: string;
  if (t.adapter.translates) {
    const tr = t.adapter.streamTransform({ includeUsage: true, onUsage: () => {} });
    const parts: string[] = [];
    tr.on('data', (c: Buffer | string) => parts.push(c.toString()));
    const done = new Promise((r) => tr.on('end', r));
    tr.end(raw);
    await done;
    out = parts.join('');
  } else {
    out = raw.toString('utf8');
  }
  const events = new SseParser();
  const parsed = [...events.push(Buffer.from(out)), ...events.end()].map((e) => e.data);
  const chunks = parsed.filter((d) => d !== '[DONE]').map((d) => JSON.parse(d));
  const usage = chunks.find((c) => c.usage)?.usage;
  const reply = chunks.map((c) => c.choices?.[0]?.delta?.content ?? '').join('');
  return `HTTP ${res.status} events=${parsed.length} done=${parsed.at(-1) === '[DONE]'} reply_chars=${reply.length} usage=${JSON.stringify(usage)}`;
}

console.log(`smoke ${new Date().toISOString().slice(0, 10)}${record ? ' (recording)' : ''}`);
let failed = false;
for (const t of targets) {
  if (!t.apiKey) {
    console.log(`${t.name}: skipped (no key set)`);
    continue;
  }
  for (const stream of [false, true]) {
    try {
      const line = await call(t, stream);
      if (!line.startsWith('HTTP 2')) failed = true;
      console.log(`${t.name} ${t.model} ${stream ? 'streamed ' : 'plain    '} ${line}`);
    } catch (err) {
      failed = true;
      console.log(`${t.name} ${stream ? 'streamed' : 'plain'} failed: ${(err as Error).name} ${(err as { code?: string }).code ?? ''}`);
    }
  }
}
process.exit(failed ? 1 : 0);
