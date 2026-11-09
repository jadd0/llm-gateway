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
  otherwise 400. Everything else is forwarded as the original bytes.
- **Streaming.** For `stream: true` the route waits for the upstream status line, hijacks the raw
  response, writes the status and headers once, then pipes upstream bytes to the client as they arrive.
  No compression, no chunk parsing, no collecting. If the client disconnects the upstream request is
  aborted, so a dropped client never holds a pooled socket.
- **Non-streamed.** Status and content-type from the upstream, body passed as bytes.
- **Failures.** Connection error gives 502, upstream timeout gives 504, both with
  `{"error":{"message":..., "type":"gateway_error"}}`. An upstream 4xx or 5xx is passed through unchanged.
- **Timing.** Non-streamed responses carry `server-timing: gw;dur=<ms>, upstream;dur=<ms>`. Streamed
  responses carry `server-timing: gw-pre;dur=<ms>`, the time from receipt to upstream dispatch.
- **Logging.** Nothing logs per request. `LOG_LEVEL` defaults to `warn`; failures log error class and code only.

## Run

```
cp .env.example .env.local
npm run dev:mock      # port 9000
npm run dev:gateway   # port 8080
curl -N localhost:8080/v1/chat/completions -d '{"model":"m","stream":true,"messages":[{"role":"user","content":"hi"}]}'
```
