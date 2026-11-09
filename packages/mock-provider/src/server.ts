// Mock OpenAI-compatible provider. Exists so benchmarks measure the gateway,
// not a real provider's servers, and so outages can be triggered on demand.
//
// Behaviour is set from env at boot and can be changed at runtime:
// Three request formats, each at the path the real provider uses: OpenAI /v1/chat/completions,
// Anthropic /v1/messages, Gemini /v1beta/models/<model>:generateContent and :streamGenerateContent.
//   GET  /__control          -> current settings
//   POST /__control {...}    -> merge new settings (e.g. {"outage":"error"})
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { setTimeout as sleep } from 'node:timers/promises';
import { randomUUID } from 'node:crypto';

export type Outage = 'off' | 'error' | 'hang' | 'reset';

export interface Settings {
  latencyMs: number; // time to first byte of the completion
  tokenDelayMs: number; // gap between streamed tokens
  completionTokens: number;
  errorRate: number; // 0..1, fraction of requests answered with a 500
  outage: Outage;
}

const num = (v: string | undefined, fallback: number): number => {
  const n = Number(v);
  return v === undefined || v === '' || Number.isNaN(n) ? fallback : n;
};

export function settingsFromEnv(env: NodeJS.ProcessEnv): Settings {
  return {
    latencyMs: num(env.MOCK_LATENCY_MS, 200),
    tokenDelayMs: num(env.MOCK_TOKEN_DELAY_MS, 10),
    completionTokens: num(env.MOCK_COMPLETION_TOKENS, 20),
    errorRate: num(env.MOCK_ERROR_RATE, 0),
    outage: 'off',
  };
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? JSON.parse(raw) : {};
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

type Format = 'openai' | 'anthropic' | 'gemini';

interface ChatBody {
  model?: string;
  stream?: boolean;
  messages?: { content?: unknown }[];
  system?: unknown;
  contents?: { parts?: { text?: unknown }[] }[];
  systemInstruction?: { parts?: { text?: unknown }[] };
}

const textLength = (v: unknown): number => {
  if (typeof v === 'string') return v.length;
  if (Array.isArray(v)) return v.reduce<number>((n, p) => n + textLength((p as { text?: unknown })?.text), 0);
  return 0;
};

// Rough prompt token count: ~4 chars per token. Good enough for a mock.
function promptTokens(body: ChatBody): number {
  const chars =
    (body.messages ?? []).reduce((n, m) => n + textLength(m.content), 0) +
    textLength(body.system) +
    (body.contents ?? []).reduce((n, c) => n + textLength(c.parts), 0) +
    textLength(body.systemInstruction?.parts);
  return Math.max(1, Math.ceil(chars / 4));
}

const failureBody = (format: Format) =>
  format === 'anthropic'
    ? { type: 'error', error: { type: 'api_error', message: 'mock provider failure' } }
    : format === 'gemini'
      ? { error: { code: 500, message: 'mock provider failure', status: 'INTERNAL' } }
      : { error: { message: 'mock provider failure', type: 'server_error' } };

interface Call {
  settings: Settings;
  res: ServerResponse;
  model: string;
  stream: boolean;
  prompt: number;
}

async function respondOpenai({ settings, res, model, stream, prompt }: Call): Promise<void> {
  const id = `chatcmpl-${randomUUID()}`;
  const created = Math.floor(Date.now() / 1000);
  const usage = {
    prompt_tokens: prompt,
    completion_tokens: settings.completionTokens,
    total_tokens: prompt + settings.completionTokens,
  };

  if (!stream) {
    await sleep(settings.latencyMs + settings.tokenDelayMs * settings.completionTokens);
    sendJson(res, 200, {
      id,
      object: 'chat.completion',
      created,
      model,
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content: 'tok '.repeat(settings.completionTokens).trim() },
          finish_reason: 'stop',
        },
      ],
      usage,
    });
    return;
  }

  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });
  await sleep(settings.latencyMs);

  const chunk = (delta: object, finish: string | null, extra: object = {}) =>
    `data: ${JSON.stringify({
      id,
      object: 'chat.completion.chunk',
      created,
      model,
      choices: [{ index: 0, delta, finish_reason: finish }],
      ...extra,
    })}\n\n`;

  res.write(chunk({ role: 'assistant', content: '' }, null));
  for (let i = 0; i < settings.completionTokens; i++) {
    if (res.destroyed) return; // client went away
    if (i > 0 && settings.tokenDelayMs > 0) await sleep(settings.tokenDelayMs);
    res.write(chunk({ content: 'tok ' }, null));
  }
  res.write(chunk({}, 'stop', { usage }));
  res.end('data: [DONE]\n\n');
}

// Anthropic Messages API: JSON body, or named SSE events (message_start ... message_stop).
async function respondAnthropic({ settings, res, model, stream, prompt }: Call): Promise<void> {
  const id = `msg_${randomUUID()}`;
  const n = settings.completionTokens;
  if (!stream) {
    await sleep(settings.latencyMs + settings.tokenDelayMs * n);
    sendJson(res, 200, {
      id,
      type: 'message',
      role: 'assistant',
      model,
      content: [{ type: 'text', text: 'tok '.repeat(n).trim() }],
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: { input_tokens: prompt, output_tokens: n },
    });
    return;
  }
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
  await sleep(settings.latencyMs);
  const event = (type: string, data: object) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
  res.write(
    event('message_start', {
      message: { id, type: 'message', role: 'assistant', model, content: [], stop_reason: null, usage: { input_tokens: prompt, output_tokens: 1 } },
    }) +
      event('content_block_start', { index: 0, content_block: { type: 'text', text: '' } }) +
      event('ping', {}),
  );
  for (let i = 0; i < n; i++) {
    if (res.destroyed) return;
    if (i > 0 && settings.tokenDelayMs > 0) await sleep(settings.tokenDelayMs);
    res.write(event('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'tok ' } }));
  }
  res.end(
    event('content_block_stop', { index: 0 }) +
      event('message_delta', { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: n } }) +
      event('message_stop', {}),
  );
}

// Gemini generateContent: JSON body, or `data:`-only SSE events separated by CRLF, each carrying the
// cumulative usageMetadata, the last one with finishReason.
async function respondGemini({ settings, res, model, stream, prompt }: Call): Promise<void> {
  const n = settings.completionTokens;
  const usageMetadata = { promptTokenCount: prompt, candidatesTokenCount: n, totalTokenCount: prompt + n };
  if (!stream) {
    await sleep(settings.latencyMs + settings.tokenDelayMs * n);
    sendJson(res, 200, {
      candidates: [{ content: { role: 'model', parts: [{ text: 'tok '.repeat(n).trim() }] }, finishReason: 'STOP', index: 0 }],
      usageMetadata,
      modelVersion: model,
    });
    return;
  }
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
  await sleep(settings.latencyMs);
  const event = (last: boolean) =>
    `data: ${JSON.stringify({
      candidates: [{ content: { role: 'model', parts: [{ text: 'tok ' }] }, index: 0, ...(last ? { finishReason: 'STOP' } : {}) }],
      ...(last ? { usageMetadata } : {}),
      modelVersion: model,
    })}\r\n\r\n`;
  for (let i = 0; i < n; i++) {
    if (res.destroyed) return;
    if (i > 0 && settings.tokenDelayMs > 0) await sleep(settings.tokenDelayMs);
    if (i === n - 1) res.end(event(true));
    else res.write(event(false));
  }
  if (n === 0) res.end();
}

const responders = { openai: respondOpenai, anthropic: respondAnthropic, gemini: respondGemini };

function handleChat(format: Format) {
  return async (settings: Settings, req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const body = (await readJson(req)) as ChatBody;

    if (settings.outage === 'hang') return; // never answer; tests client timeouts
    if (settings.outage === 'reset') {
      req.socket.destroy();
      return;
    }
    if (settings.outage === 'error' || Math.random() < settings.errorRate) {
      sendJson(res, 500, failureBody(format));
      return;
    }

    const url = new URL(req.url ?? '/', 'http://mock');
    const fromPath = /\/models\/([^/:]+):(stream)?[gG]enerateContent$/.exec(url.pathname);
    await responders[format]({
      settings,
      res,
      model: format === 'gemini' ? decodeURIComponent(fromPath?.[1] ?? 'mock-gemini-model') : (body.model ?? 'mock-model'),
      stream: format === 'gemini' ? fromPath?.[2] === 'stream' : body.stream === true,
      prompt: promptTokens(body),
    });
  };
}

async function handleControl(
  settings: Settings,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  if (req.method === 'POST') {
    const patch = (await readJson(req)) as Partial<Settings>;
    Object.assign(settings, patch);
  }
  sendJson(res, 200, settings);
}

// The returned object is mutated by POST /__control, and tests may also mutate it directly.
export function createMockServer(settings: Settings): Server {
  const server = createServer((req, res) => {
    const path = (req.url ?? '').split('?')[0] ?? '';
    const route =
      req.method === 'POST' && path === '/v1/chat/completions'
        ? handleChat('openai')
        : req.method === 'POST' && path === '/v1/messages'
          ? handleChat('anthropic')
          : req.method === 'POST' && /^\/v1beta\/models\/[^/:]+:(stream)?[gG]enerateContent$/.test(path)
            ? handleChat('gemini')
            : path === '/__control'
              ? handleControl
              : null;

    if (!route) {
      sendJson(res, 404, { error: { message: 'not found' } });
      return;
    }
    route(settings, req, res).catch((err: unknown) => {
      if (!res.headersSent) sendJson(res, 400, { error: { message: String(err) } });
      else res.destroy();
    });
  });

  // Default keepAliveTimeout (5s) can race the gateway's pooled sockets under load.
  server.keepAliveTimeout = 65_000;
  return server;
}

if (import.meta.main) {
  const settings = settingsFromEnv(process.env);
  const port = num(process.env.MOCK_PORT, 9000);
  createMockServer(settings).listen(port, '127.0.0.1', () => {
    console.log(`mock provider on http://127.0.0.1:${port}`, settings);
  });
}
