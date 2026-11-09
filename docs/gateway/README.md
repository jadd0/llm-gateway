# Gateway

Diagram: [chat-passthrough.html](chat-passthrough.html) (the OpenAI-format path); routing and translation: [../providers/providers.html](../providers/providers.html). Code: `packages/gateway/src/`.

| File | Job |
|---|---|
| `config.ts` | Env parsed with zod; a blank value counts as unset |
| `upstream.ts` | Picks the provider for a model and keeps one undici `Pool` per upstream origin (`UPSTREAM_CONNECTIONS` sockets, timeouts from `UPSTREAM_TIMEOUT_MS`); the base URL's path is joined in front of the request path |
| `providers/` | Router and one adapter per provider format; see [../providers/README.md](../providers/README.md) |
| `app.ts` | `buildApp(config)`: Fastify with request logging off, the auth hook, and the Postgres and Redis handles |
| `routes/chat.ts` | `POST /v1/chat/completions` |
| `server.ts` | Entry point, graceful shutdown on SIGTERM and SIGINT |

## Behaviour

- **Providers.** The `model` name picks a provider (`MODEL_ROUTES`). OpenAI-format upstreams (OpenAI, the mock) get the
  request bytes and the sections below describe them; Anthropic and Gemini are translated both ways, streams included,
  and their errors are rewritten into the OpenAI shape. An unknown model is 400 `model_not_found`, a provider without a key
  503 `provider_not_configured`. See [../providers/README.md](../providers/README.md).
- **Validation.** Only `model` (string), `messages` (array) and optional `stream` (boolean) are checked,
  otherwise 400. Everything else is forwarded as the original bytes. A non-JSON content-type gets 415, in the same error shape.
- **Streaming.** For `stream: true` the route waits for the upstream status line, hijacks the raw
  response, writes the status and headers once, then pipes upstream bytes to the client as they arrive.
  No compression, no chunk parsing, no collecting. If the client disconnects the upstream request is
  aborted, so a dropped client never holds a pooled socket.
- **Non-streamed.** Status and content-type from the upstream, body passed as bytes.
- **Failures.** Connection error gives 502, upstream timeout gives 504 (in the hang test, within about half a second of `UPSTREAM_TIMEOUT_MS`), both with
  `{"error":{"message":..., "type":"gateway_error"}}`. An upstream 4xx or 5xx is passed through unchanged.
- **Timing.** Non-streamed responses carry `server-timing: gw-pre;dur=<ms>, gw-post;dur=<ms>, upstream;dur=<ms>`;
  streamed responses carry `server-timing: gw-pre;dur=<ms>`. `gw-pre` is request received to upstream request
  dispatched, `upstream` is dispatch to the upstream body fully copied into memory, `gw-post` is that point to the reply being
  handed to Fastify. Serialising and writing the reply happen after `gw-post` and are not in any field.
- **Upstream headers.** `retry-after`, `x-request-id`, `openai-processing-ms` and every `x-ratelimit-*`
  header are passed through, streamed and not; other upstream headers are dropped. When the gateway's own
  rate limiter has set `x-ratelimit-*` headers (they describe the caller's key) the upstream's are dropped instead.
- **Errors.** Fastify's own errors (415 unsupported content-type, oversized body) and unknown routes (404)
  use the same `invalid_request_error` shape.
- **Auth.** An `onRequest` hook (`auth/plugin.ts`) runs before the body is read: it takes the bearer key, looks
  it up and either answers 401 or sets `request.tenant`. It covers unknown routes too. The client's
  `Authorization` header is never forwarded; the upstream key is the provider's own (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY` or `GEMINI_API_KEY`). Because the hook
  runs before the route starts its clock, `gw-pre` in `server-timing` does not include the key check.
  See [../auth/README.md](../auth/README.md).
- **Rate limit.** After auth and before the route, a `preHandler` (`ratelimit/plugin.ts`) charges the request to the
  key's buckets or answers 429 / 400. A streamed request is sent upstream with `stream_options.include_usage=true`
  and its bytes pass through a tap that reads the final usage (and drops the usage-only chunk if the client did not ask for it); see [../rate-limiter/README.md](../rate-limiter/README.md).
- **Budget.** After the rate limiter, a `preHandler` (`budget/plugin.ts`) reserves the request's worst-case cost against
  the tenant's monthly cap or answers 402 / 400 / 503. The route ends every request through one shared step
  (`usage/settle.ts`) that settles the rate limiter and the budget together; see [../budgets/README.md](../budgets/README.md).
- **Binding.** The gateway listens on `GATEWAY_HOST`, default `127.0.0.1`.
- **Logging.** Nothing logs per request. `LOG_LEVEL` defaults to `warn`; failures log error class and code only.

## Run

```
cp .env.example .env.local
docker compose up -d --wait && npm run db:migrate
npm run keys -- create-tenant acme && npm run keys -- create-key acme   # prints a gw_ key once
npm run dev:mock      # port 9000
npm run dev:gateway   # port 8080
curl -N localhost:8080/v1/chat/completions -H "authorization: Bearer $KEY" -H 'content-type: application/json' -d '{"model":"mock-m","stream":true,"messages":[{"role":"user","content":"hi"}]}'
```

## Why this design

Fastify for a small, fast HTTP core; an undici `Pool` so upstream connections are kept alive and the pool
size is a named, tunable number; Node's type stripping so there is no build step. The streaming path is
deliberately the least clever code in the file: hijack and pipe, so there is nothing to buffer.

## Measured (from [BENCHMARKS.md](../../BENCHMARKS.md))

0.233 ms p50 / 0.982 ms p95 added, non-streamed at 1000 req/s; 0.238 ms p50 / 0.254 ms p95 added to first
streamed byte at 200 req/s. The gateway's own `server-timing` figure, effectively its pre-dispatch time, was 0.008 ms p50 in the instant run; the rest of the 0.233 ms is the extra HTTP hop and reply write, which only the k6 difference captures.

## Questions you should be able to answer

1. **How does the gateway avoid buffering SSE?** For `stream: true` it waits for the upstream status line,
   hijacks the raw response, writes headers once and pipes upstream bytes to the client. It never parses or
   collects chunks. A test asserts the first chunk reaches the client well before the mock sends its last.
2. **What happens when the client aborts mid-stream?** The response `close` aborts the upstream request, so
   the pooled socket is released. In the adversarial run, 500 simultaneous aborts left no live upstream
   responses within 5 s.
3. **What happens when the upstream fails?** Connection errors give 502 and timeouts 504, in an OpenAI-shaped
   body; an OpenAI-format upstream's 4xx and 5xx pass through unchanged and the other providers' are mapped to the OpenAI error shape. Retries and fallback are later PRs.
4. **Why forward the original bytes instead of re-serialising?** It is cheaper, and the gateway only needs
   to know three fields, so everything else stays untouched.
5. **What does `server-timing` tell you?** Only the gateway's own in-process time. The real overhead is the
   k6 difference against a direct run, which includes the extra HTTP hop.
