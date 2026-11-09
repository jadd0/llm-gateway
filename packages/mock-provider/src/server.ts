// Mock OpenAI-compatible provider. Exists so benchmarks measure the gateway,
// not a real provider's servers, and so outages can be triggered on demand.
//
// Behaviour is set from env at boot and can be changed at runtime:
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

interface ChatBody {
  model?: string;
  stream?: boolean;
  messages?: { content?: unknown }[];
}

// Rough prompt token count: ~4 chars per token. Good enough for a mock.
function promptTokens(body: ChatBody): number {
  const chars = (body.messages ?? []).reduce(
    (n, m) => n + (typeof m.content === 'string' ? m.content.length : 0),
    0,
  );
  return Math.max(1, Math.ceil(chars / 4));
}

async function handleChat(
  settings: Settings,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const body = (await readJson(req)) as ChatBody;

  if (settings.outage === 'hang') return; // never answer; tests client timeouts
  if (settings.outage === 'reset') {
    req.socket.destroy();
    return;
  }
  if (settings.outage === 'error' || Math.random() < settings.errorRate) {
    sendJson(res, 500, { error: { message: 'mock provider failure', type: 'server_error' } });
    return;
  }

  const id = `chatcmpl-${randomUUID()}`;
  const model = body.model ?? 'mock-model';
  const created = Math.floor(Date.now() / 1000);
  const usage = {
    prompt_tokens: promptTokens(body),
    completion_tokens: settings.completionTokens,
    total_tokens: promptTokens(body) + settings.completionTokens,
  };

  if (!body.stream) {
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
    const route =
      req.method === 'POST' && req.url === '/v1/chat/completions'
        ? handleChat
        : req.url === '/__control'
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
