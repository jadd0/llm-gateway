# Mock provider

Diagram: [mock-provider.html](mock-provider.html). Code: `packages/mock-provider/src/server.ts`.

The mock speaks the OpenAI chat-completions wire format. It exists so benchmarks measure the gateway
and not a real provider's servers, and so outages can be triggered on demand.

| Setting | Env | Meaning |
|---|---|---|
| `latencyMs` | `MOCK_LATENCY_MS` | time before the first byte of the completion |
| `tokenDelayMs` | `MOCK_TOKEN_DELAY_MS` | gap between streamed tokens |
| `completionTokens` | `MOCK_COMPLETION_TOKENS` | tokens per answer |
| `errorRate` | `MOCK_ERROR_RATE` | fraction of requests answered with a 500 |
| `outage` | control only | `off`, `error` (always 500), `hang` (never answers), `reset` (drops the socket) |

`GET /__control` returns the current settings; `POST /__control` with a JSON object merges new ones.

`createMockServer(settings)` returns an `http.Server` over a settings object the caller owns, which is how
the tests drive it; the process starts listening only when the file is run directly.
