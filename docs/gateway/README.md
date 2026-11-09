# Gateway

Diagram: [chat-passthrough.html](chat-passthrough.html). Code: `packages/gateway/src/`.

| File | Job |
|---|---|
| `config.ts` | Env parsed with zod; a blank value counts as unset |
| `upstream.ts` | One undici `Pool` per upstream origin, `UPSTREAM_CONNECTIONS` sockets, timeouts from `UPSTREAM_TIMEOUT_MS` |
| `app.ts` | `buildApp(config)`: Fastify with request logging off |
| `routes/chat.ts` | `POST /v1/chat/completions` |
| `server.ts` | Entry point, graceful shutdown on SIGTERM and SIGINT |

## Behaviour

- **Validation.** Only `model` (string), `messages` (array) and optional `stream` (boolean) are checked,
  otherwise 400. Everything else is forwarded as the original bytes. A non-JSON content-type gets 415, in the same error shape.
- **Streaming.** For `stream: true` the route waits for the upstream status line, hijacks the raw
  response, writes the status and headers once, then pipes upstream bytes to the client as they arrive.
  No compression, no chunk parsing, no collecting. If the client disconnects the upstream request is
  aborted, so a dropped client never holds a pooled socket.
- **Non-streamed.** Status and content-type from the upstream, body passed as bytes.
- **Failures.** Connection error gives 502, upstream timeout gives 504 (in the hang test, within about half a second of `UPSTREAM_TIMEOUT_MS`), both with
  `{"error":{"message":..., "type":"gateway_error"}}`. An upstream 4xx or 5xx is passed through unchanged.
- **Timing.** Non-streamed responses carry `server-timing: gw-pre;dur=<ms>, upstream;dur=<ms>`; streamed
  responses carry `server-timing: gw-pre;dur=<ms>`. `gw-pre` is the pre-dispatch time (request received to
  upstream request dispatched); `upstream` is dispatch to body received.
- **Upstream headers.** `retry-after`, `x-request-id`, `openai-processing-ms` and every `x-ratelimit-*`
  header are passed through, streamed and not; other upstream headers are dropped.
- **Errors.** Fastify's own errors (415 unsupported content-type, oversized body) and unknown routes (404)
  use the same `invalid_request_error` shape.
- **Binding.** The gateway listens on `GATEWAY_HOST`, default `127.0.0.1`. It has no auth yet and forwards
  `OPENAI_API_KEY` upstream for any caller, so until auth lands (PR 3) keep it bound to localhost.
- **Logging.** Nothing logs per request. `LOG_LEVEL` defaults to `warn`; failures log error class and code only.

## Run

```
cp .env.example .env.local
npm run dev:mock      # port 9000
npm run dev:gateway   # port 8080
curl -N localhost:8080/v1/chat/completions -H 'content-type: application/json' -d '{"model":"m","stream":true,"messages":[{"role":"user","content":"hi"}]}'
```

## Why this design

Fastify for a small, fast HTTP core; an undici `Pool` so upstream connections are kept alive and the pool
size is a named, tunable number; Node's type stripping so there is no build step. The streaming path is
deliberately the least clever code in the file: hijack and pipe, so there is nothing to buffer.

## Measured (from [BENCHMARKS.md](../../BENCHMARKS.md))

0.233 ms p50 / 0.982 ms p95 added, non-streamed at 1000 req/s; 0.238 ms p50 / 0.254 ms p95 added to first
streamed byte at 200 req/s. The gateway's pre-dispatch time is 0.008 ms p50 (`server-timing`).

## Questions you should be able to answer

1. **How does the gateway avoid buffering SSE?** For `stream: true` it waits for the upstream status line,
   hijacks the raw response, writes headers once and pipes upstream bytes to the client. It never parses or
   collects chunks. A test asserts the first chunk reaches the client well before the mock sends its last.
2. **What happens when the client aborts mid-stream?** The response `close` aborts the upstream request, so
   the pooled socket is released. In the adversarial run, 500 simultaneous aborts left no live upstream
   responses within 5 s.
3. **What happens when the upstream fails?** Connection errors give 502 and timeouts 504, in an OpenAI-shaped
   body; upstream 4xx and 5xx pass through unchanged. Retries and fallback are later PRs.
4. **Why forward the original bytes instead of re-serialising?** It is cheaper, and the gateway only needs
   to know three fields, so everything else stays untouched.
5. **What does `server-timing` tell you?** Only the gateway's pre-dispatch time. The real overhead is the
   k6 difference against a direct run, which includes the extra HTTP hop.
