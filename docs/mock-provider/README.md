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

## Questions you should be able to answer

1. **Why a mock provider at all?** To measure the gateway and not someone else's servers, to be free and
   repeatable, and to trigger outages on demand.
2. **How do you know the mock is not the bottleneck?** Direct runs against it stayed at or below 1.437 ms p95
   through 20000 req/s, while the gateway's p95 degraded from 12000 req/s.
3. **What do `hang` and `reset` test?** `hang` never answers, so it exercises the gateway's timeout (504).
   `reset` destroys the socket, which exercises dropped connections.
4. **How does streaming pacing work?** After `latencyMs` it emits a role chunk, then `completionTokens`
   chunks `tokenDelayMs` apart, a final chunk with usage, then `[DONE]`.
5. **What does it not do?** It does not model a real tokenizer, real errors beyond a 500, or real rate limits.
