# Providers

Diagram: [providers.html](providers.html). Code: `packages/gateway/src/providers/`, `upstream.ts`, `routes/chat.ts`.

Apps speak OpenAI format only. The gateway reads the `model` name, picks a provider, and translates the
request, the answer, the streamed chunks, the usage and the errors between OpenAI's format and the provider's.

Each model name is one attempt target: retries, the circuit breaker and fallback to another model's provider are in
[../resilience/](../resilience/README.md).

## The three formats side by side

| | OpenAI (and the mock) | Anthropic | Gemini |
|---|---|---|---|
| Path | `/chat/completions` on the base URL (which carries `/v1`) | `/v1/messages` | `/models/<model>:generateContent`, or `:streamGenerateContent?alt=sse` |
| Key header | `authorization: Bearer` | `x-api-key` and `anthropic-version` | `x-goog-api-key` |
| System prompt | a `system` message | top-level `system` | `systemInstruction` |
| Turns | `messages` | `messages` (user/assistant) | `contents` (user/model, `parts`) |
| Output limit | `max_tokens` / `max_completion_tokens` | `max_tokens`, required (default `RATE_LIMIT_DEFAULT_MAX_TOKENS`) | `generationConfig.maxOutputTokens` |
| Stop reason | `finish_reason` | `end_turn`/`stop_sequence` to `stop`, `max_tokens` to `length`, `refusal` to `content_filter` | `STOP` to `stop`, `MAX_TOKENS` to `length`, `SAFETY`/`RECITATION` and similar to `content_filter` |
| Usage | `usage.prompt_tokens`/`completion_tokens` | `input_tokens`/`output_tokens` | `promptTokenCount`; completion is `candidatesTokenCount` plus `thoughtsTokenCount` (thinking is billed as output) |
| Stream | `data:` chunks, `[DONE]` | named events: `message_start` (input usage), `content_block_delta`, `message_delta` (stop reason, output usage), `message_stop` | `data:` events only; each carries cumulative usage; the stream just ends |

## How a request moves

1. `routes/chat.ts` checks the body, then asks `upstream.resolve(model)`. `providers/router.ts` picks the
   provider by the longest matching prefix in `MODEL_ROUTES`. No match gives 400 `model_not_found`; a real
   provider with no key gives 503 `provider_not_configured`. Both give back everything the rate limiter and
   budget took up front.
2. The provider's adapter builds the upstream request: path, its own key, body. A parameter it cannot
   translate gives 400 `unsupported_parameter` naming the field.
3. `upstream.ts` sends it on a keep-alive pool for the provider's origin. The base URL's path is kept and joined
   in front of the adapter's path, so `https://openrouter.ai/api/v1` works.
4. The answer comes back. OpenAI-format answers pass through as bytes with usage read by the shared tap.
   Translated answers are converted: a JSON body is parsed and rewritten; a stream goes through the adapter's
   transform. Usage goes to `usage/settle.ts`, the same path as for OpenAI, so the rate limiter and the budget
   settle to the real token counts whatever the provider.

## Decisions

- **Plain HTTP over the gateway's own pools, no provider SDKs.** One place for timeouts, streaming and
  measurement, and no extra dependencies.
- **Text chat only.** What a client asks for that the translated providers cannot do is refused with 400
  `unsupported_parameter` naming the field, rather than dropped; a client that asked for it would otherwise build
  on a wrong answer. OpenAI requests pass through untouched. Tools and images are on the roadmap.
  - **Refused** (for Anthropic and Gemini) when they ask for something: `tools`, `tool_choice`, `functions`,
    `function_call`, `parallel_tool_calls`, `logprobs: true`, `top_logprobs` above 0, `response_format`, `audio`,
    `modalities`, `prediction`, `logit_bias`, `presence_penalty` and `frequency_penalty` other than 0, `seed`,
    `reasoning_effort`, `n` other than 1, non-text content parts, tool messages. Neutral values (`null`, `0`,
    `false`, `n: 1`) are what SDKs send for "no preference" and pass.
  - **Dropped** without a word, because they change nothing about the answer: `user`, `metadata`,
    `service_tier`, `store`.
  - **Anthropic only:** `temperature` above 1 is refused (its range is 0 to 1, OpenAI's is 0 to 2).
  - **Gemini** is always sent `maxOutputTokens`: the client's limit, else the default allowance the budget hold is
    sized on, so the provider's cap and the hold agree.
- **The usage-only chunk follows OpenAI's rule.** It is written only when the client sent
  `stream_options.include_usage`; usage is reported to the gateway either way.
- **Stream translation never buffers.** `providers/sse.ts` parses incrementally with a streaming UTF-8 decoder
  and holds only an incomplete trailing line. Each event is converted and written when it is complete.
- **Errors keep the provider's status** (a 429 stays 429 with `retry-after`; Anthropic's 529 becomes 503) and get an
  OpenAI-shaped body carrying the provider's message. The exception is a provider that rejects the gateway's own
  key (401): the client gets a 502 `provider_auth_failed` saying the gateway's credentials for that provider
  were rejected, in all three formats, and the provider's real status and error code go to the server log (never its message, which can echo part of the key). An
  error that arrives mid-stream is typed by meaning: rate limits are `rate_limit_error`, a request the provider
  called invalid stays `invalid_request_error`, and overload or provider faults are `server_error`.
- **`OPENAI_BASE_URL` includes its version path** (`https://api.openai.com/v1`). The gateway starts only if it has
  a path, so an old `http://host:port` fails with a message rather than 404ing every request.
- **Credentials are isolated.** An adapter receives only its own provider's key and builds every header itself; the
  client's `Authorization` is never forwarded. A test sends one request to each provider and checks no header holds
  another provider's key or the client's.
- **Prices** (`pricing/prices.ts`) are read from each provider's pricing page with the date and URL stored per
  row. Standard (short-context) rates are used; a prompt past a model's long-context threshold is billed higher by
  the provider and under-priced here (R12).

## Configuration

`MODEL_ROUTES` (default `claude-=anthropic,gpt-=openai,o1=openai,o3=openai,o4=openai,gemini-=gemini` plus the
`mock-*` routes), `OPENAI_BASE_URL` (default `https://api.openai.com/v1`; must include a path), `ANTHROPIC_BASE_URL`, `ANTHROPIC_VERSION`,
`GEMINI_BASE_URL`, `MOCK_BASE_URL`, and the keys `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`.
Mock model names: `mock-` and `mock-openai-` use OpenAI format, `mock-anthropic-` and `mock-gemini-` the others.

## What was tested against what

The contract tests run against the files in `packages/gateway/src/providers/fixtures/`. **No Anthropic or Gemini
key was available when this was built, so those fixtures were written from the providers' public API reference and
streaming documentation examples, not recorded from live calls**; they are marked by their content (placeholder ids
such as `msg_fixture`). `npm run smoke:providers` makes one tiny live call per provider (streamed and not, 5 output
tokens) once keys are in `.env.local`, and `-- --record` saves scrubbed raw answers under `fixtures/recorded/` for
review. It has not been run against a live provider: only the mock formats were exercised, and OpenAI answered 401 to
the placeholder key.

## Measured

Translation overhead figures are pending: the full benchmark (`bash bench/run-providers.sh`, the realistic
streamed scenario through each mock format) is run behind `bench/quiet.sh` by the orchestrator after the build.
Until then no figure is committed; a short smoke run only proved the script works.
