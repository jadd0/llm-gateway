# Mock provider

Diagram: [mock-provider.html](mock-provider.html). Code: `packages/mock-provider/src/server.ts`.

The mock speaks three wire formats, each at the path the real provider uses: OpenAI `POST /v1/chat/completions`,
Anthropic `POST /v1/messages` (named SSE events from `message_start` to `message_stop`), and Gemini
`POST /v1beta/models/<model>:generateContent` or `:streamGenerateContent?alt=sse` (CRLF-separated `data:` events, the last with
`finishReason` and usage). Latency, pacing, error rate and outage modes apply to all three; an outage or error answers in the
format's own error shape. It exists so benchmarks measure the gateway
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

## Why this design

A real provider would add its own latency, rate limits, cost and outages to every measurement. The mock
makes provider behaviour a dial: latency and token pacing for realistic streams, zero for a throughput
ceiling, and outage modes for failure tests. Because it is an `http.Server` over a plain settings object, a
test can start one on port 0 and change its behaviour mid-test.

## Measured

Called directly, the mock's own latency floor in the instant profile was 1.190 ms p50 / 1.278 ms p95 at 1000
req/s, and in the realistic profile 200.202 ms p50 to first byte. It sustained every throughput step up to
20000 req/s with p95 at most 1.437 ms ([BENCHMARKS.md](../../BENCHMARKS.md)), so it was not the limit in the
gateway runs.
