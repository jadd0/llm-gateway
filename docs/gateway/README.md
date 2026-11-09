# Gateway

Diagram: [chat-passthrough.html](chat-passthrough.html) (the OpenAI-format path); routing and translation: [../providers/providers.html](../providers/providers.html). Code: `packages/gateway/src/`.

| File | Job |
|---|---|
| `config.ts` | Env parsed with zod; a blank value counts as unset |
| `upstream.ts` | Picks the provider for a model and keeps one undici `Pool` per upstream origin (`UPSTREAM_CONNECTIONS` sockets, connect, headers and idle timeouts from `UPSTREAM_CONNECT_TIMEOUT_MS`, `UPSTREAM_HEADERS_TIMEOUT_MS`, `UPSTREAM_IDLE_TIMEOUT_MS`); the base URL's path is joined in front of the request path |
| `providers/` | Router and one adapter per provider format; see [../providers/README.md](../providers/README.md) |
| `app.ts` | `buildApp(config)`: Fastify with request logging off, the auth hook, and the Postgres and Redis handles |
| `routes/chat.ts` | `POST /v1/chat/completions`: validates, then runs the attempt loop (retries, breaker, fallback; see [../resilience/](../resilience/README.md)) |
| `requestlog/` | The collector (first hook; one log entry per request, whatever its outcome) and the sinks that queue it; see [../request-log/README.md](../request-log/README.md) |
| `cache/` | The exact-match response cache: a preHandler between rate limit and budget, and the fill after a served 2xx; see [../cache/README.md](../cache/README.md) |
| `resilience/` | Timeouts, retry policy, circuit breaker and fallback chains |
| `server.ts` | Entry point, start-up line naming every provider and its base URL, graceful shutdown on SIGTERM and SIGINT (in-flight requests finish, buffered log entries are sent) |

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
- **Failures.** Retryable failures are retried and fall back along the model chain first (see [../resilience/](../resilience/README.md)). When nothing serves, a connection error gives 502 and an upstream timeout gives 504, both with
  `{"error":{"message":..., "type":"gateway_error"}}`. An upstream 4xx or 5xx is passed through unchanged.
- **Timing.** Non-streamed responses carry `server-timing: gw-pre;dur=<ms>, gw-post;dur=<ms>, upstream;dur=<ms>`;
  streamed responses carry `server-timing: gw-pre;dur=<ms>`. `gw-pre` is request received to upstream request
  dispatched, `upstream` is dispatch to the upstream body fully copied into memory, `gw-post` is that point to the reply being
  handed to Fastify. Serialising and writing the reply happen after `gw-post` and are not in any field.
- **Upstream headers.** `retry-after`, `x-request-id`, `request-id`, `openai-processing-ms`, `server-timing`, every `x-ratelimit-*` and every `anthropic-ratelimit-*`
  header are passed through, streamed and not, and also on rewritten error replies; other upstream headers are dropped. When the gateway's own
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
