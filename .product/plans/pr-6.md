# PR 6 — Provider adapters: Anthropic, OpenAI and Gemini

**CONCERN:** the gateway only speaks to one OpenAI-format upstream (the mock); real apps need
Anthropic and Google models behind the same endpoint, and each provider has its own request,
response and streaming format.

**ACCEPTANCE:** one OpenAI-format request routes by model name to Anthropic, OpenAI or the third provider, translating request, response, streaming chunks and usage; contract tests run against recorded fixtures; one live smoke call per provider documented, not in the gate.

**SCOPE GUARD:** text chat only. No tool/function calling, images or audio, `n > 1`, logprobs
or embeddings: for Anthropic and Gemini these get a 400 `unsupported_parameter`, never silently
dropped; OpenAI requests pass through untouched. No retries, fallback or breaker (PR 7). The mock
stays the benchmark target; live calls are a hand-run script, never in the gate or CI.

**BASE:** main after PR 5 merges (usage flows into the PR 4/5 reconcile hook; real prices go in
PR 5's price table); branch `pr-6-providers` (worktree `.claude/worktrees/pr-6-providers`);
stacked on none; migration: none. Residuals owned by this PR: **R1** (base URL path discarded),
closed here.

## Files
| path | change |
|---|---|
| `packages/gateway/src/providers/types.ts` | **new**. `Adapter` interface: `buildRequest(body) → {path, headers, body}`, `parseResponse(json) → {openaiBody, usage}`, `streamTransform() → Transform` (provider SSE → OpenAI SSE, reports usage), `mapError(status, body)` |
| `packages/gateway/src/providers/router.ts` | **new**. Model name → provider from `MODEL_ROUTES`; unknown → 400 `model_not_found` |
| `packages/gateway/src/providers/openai.ts` | **new**. Pass-through adapter (no translation; usage via PR 4's tap) |
| `packages/gateway/src/providers/anthropic.ts` | **new**. Messages API translation |
| `packages/gateway/src/providers/gemini.ts` | **new**. `generateContent` / `streamGenerateContent?alt=sse` translation |
| `packages/gateway/src/providers/common.ts`, `packages/gateway/src/providers/test-support.ts` | **new**. Shared translation helpers (unsupported-parameter check, message flattening, OpenAI object builders, error shape); shared test helpers |
| `packages/gateway/src/providers/sse.ts` | **new**. Incremental SSE parser: events split across chunks, multi-byte UTF-8 split across chunks |
| `packages/gateway/src/providers/*.test.ts` | **new**. Beside each file above |
| `packages/gateway/src/providers/fixtures/` | **new**. Recorded real responses (JSON and raw SSE) per provider, ids and headers stripped |
| `packages/gateway/src/upstream.ts` | one undici Pool per provider origin; base URL path kept and joined (closes R1) |
| `packages/gateway/src/routes/chat.ts` | route via router → adapter; translated streams piped through the adapter's transform, still unbuffered |
| `packages/gateway/src/routes/chat.test.ts` | existing tests renamed to `mock-*` models and the fake upstream fitted to the new interface |
| `packages/gateway/src/routes/chat-providers.test.ts` | **new**. Routing, translation, unbuffered-through-translation, key isolation, usage, errors (beside the route, separate from chat.test's shared fixtures) |
| `packages/gateway/src/{config.test.ts,test-env.ts,auth/plugin.test.ts,ratelimit/*.test.ts,pricing/prices.test.ts}`, `bench/run-{baseline,ratelimit,budget}.sh`, `bench/k6/chat.js` | provider settings tests; test config mirrors OPENAI_BASE_URL into MOCK_BASE_URL; models renamed `mock-*`; bench scripts set MOCK_BASE_URL; k6 takes MODEL |
| `packages/gateway/src/pricing/prices.ts` | real models added with price, `asOf` date and source URL per row |
| `packages/gateway/src/config.ts`, `.env.example` | provider rows (Decisions) |
| `packages/mock-provider/src/server.ts` | add Anthropic-format `POST /v1/messages` and Gemini-format `:generateContent` / `:streamGenerateContent`, same latency/outage controls |
| `packages/mock-provider/src/server.test.ts` | tests for the two new formats |
| `scripts/smoke-providers.ts` | **new**. One tiny live call per provider (streamed and non-streamed, `max_tokens` 5); `--record` saves scrubbed raw answers under `fixtures/recorded/` for review (it does not overwrite the hand-written fixtures the tests assert exact values on). Never in the gate or CI |
| `package.json` | script `smoke:providers` |
| `bench/run-providers.sh` | **new**. Realistic streamed scenario through each mock format, vs PR 5's baseline |
| `bench/results/pr-6/*.json` | **new** |
| `BENCHMARKS.md` | "Translation overhead (PR 6)" section |
| `docs/providers/README.md` | **new**. Adapters, the three formats side by side, routing, error mapping, scope, numbers, interview Qs |
| `docs/providers/providers.html` | **new**. Archify diagram: request → router → adapter → provider, and the streamed translation path |
| `docs/README.md`, `docs/architecture/*`, `docs/gateway/README.md`, `docs/mock-provider/README.md`, `docs/budgets/README.md` | providers built; request path and mock formats updated |
| `docs/diagrams/flows.md` | add the routing and translation flow; passthrough flow now names the OpenAI adapter |
| `docs/gateway/chat-passthrough.html`, `README.md`, `BENCHMARKS.md`, `.env.example` | passthrough diagram redrawn; README line; benchmark section (figures pending); provider env |
| `.product/RESIDUALS.md` | move R1 to Closed |

## Schema

none.

## Invariants

- **Apps speak OpenAI format only.** Every response, streamed or not, from every provider, is
  OpenAI-shaped (`chat.completion` / `chat.completion.chunk`, `finish_reason`, `usage`).
- **Routing** by longest matching prefix in `MODEL_ROUTES`. The model name is forwarded as given.
- **Anthropic translation:** `system` messages joined into `system`; consecutive same-role
  messages merged; `max_tokens` required (`max_tokens ?? max_completion_tokens ?? default`);
  `stop` → `stop_sequences`; `temperature`, `top_p` mapped. Response: text blocks joined;
  `end_turn`/`stop_sequence` → `stop`, `max_tokens` → `length`; `input_tokens`/`output_tokens`
  → `prompt_tokens`/`completion_tokens`. Stream: `message_start` (input usage),
  `content_block_delta` text → `delta.content`, `message_delta` (stop reason, output usage) →
  final chunk + usage chunk, `message_stop` → `[DONE]`, `ping` ignored, `error` event → stream
  ends with an OpenAI-shaped error event. Headers `x-api-key`, `anthropic-version`.
- **Gemini translation:** messages → `contents` (`user`/`model`, `parts:[{text}]`), system →
  `systemInstruction`; `generationConfig` {`maxOutputTokens`, `temperature`, `topP`,
  `stopSequences`}. Response: first candidate's text parts joined; `STOP` → `stop`, `MAX_TOKENS`
  → `length`, `SAFETY`/`RECITATION` → `content_filter`; usage from `usageMetadata`
  (`promptTokenCount`; completion = `candidatesTokenCount + thoughtsTokenCount`). Header
  `x-goog-api-key`.
- **Streaming stays unbuffered through translation:** each provider event is converted and
  written as soon as it is complete; the SSE parser holds only an incomplete trailing event and
  decodes bytes with a streaming UTF-8 decoder.
- **Usage** from every adapter reaches the PR 4/5 reconcile hook; translated streams report it
  from the adapter, OpenAI from PR 4's tap.
- **Errors:** provider status kept (429 stays 429 with `retry-after`; Anthropic 529 overloaded →
  503); body mapped to the OpenAI error shape with the provider's message.
- **Credentials isolation:** each provider receives only its own key; a test asserts no
  Anthropic key reaches Gemini and vice versa, and no client key reaches any provider.
- **Unsupported parameters** for translated providers (`tools`, `tool_choice`, image or audio
  content parts, `n > 1`, `logprobs`, `response_format`) → 400 `unsupported_parameter` naming
  the field.

## Tests

`providers/sse.test.ts`: `events split at every byte boundary parse identically`;
`a multi-byte character split across chunks decodes correctly`.

`providers/anthropic.test.ts` and `providers/gemini.test.ts` (each against its fixtures):
- `request translation: system, merged turns, max_tokens default, stop, sampling params`
- `non-streamed response translates text, finish_reason and usage`
- `streamed fixture translates to OpenAI chunks ending in [DONE] with usage`
- `provider error event mid-stream ends the stream with an OpenAI-shaped error`
- `unsupported parameters return 400 unsupported_parameter`
- `error statuses map (429 keeps retry-after; 529 → 503 for Anthropic)`

`providers/router.test.ts`: `longest prefix wins`; `unknown model returns 400 model_not_found`.
`providers/openai.test.ts`: `request and response pass through byte-identical`.
`routes/chat.test.ts`: `each provider format via the mock returns an OpenAI-shaped response`;
`translated stream is unbuffered (first chunk before the mock's last)`; `each provider gets only
its own key`; `usage from each format reaches reconcile`.
`upstream` (in chat.test): `base URL with a path prefix is joined, not discarded` (closes R1).

## Acceptance proof

1. `bash scripts/gate.sh` → PASS (fixtures and mock formats; no network).
2. Mock formats: curl `model: mock-anthropic-1` and `mock-gemini-1` streamed → OpenAI chunks
   (hop: `router.ts` → `anthropic.ts`/`gemini.ts` → `upstream.ts` → mock).
3. Live, by hand, with the founder's keys in `.env.local`: `npm run smoke:providers` → one
   streamed and one non-streamed call per provider succeed; output saved to
   `bench/results/pr-6/smoke.txt` (no keys, no ids). `--record` refreshed the committed fixtures.
4. `bash bench/run-providers.sh` → translation overhead per format vs OpenAI pass-through.

## Adversarial

1. Feed each recorded stream through the parser one byte at a time: output identical.
2. A prompt in Arabic and emoji through Anthropic and Gemini (mock and one live call): text intact.
3. Provider returns 429 mid-load: the client gets 429 with `retry-after`; rate-limit and budget
   reconcile still happen (estimate kept, nothing double-charged).
4. Grep fixtures, smoke output, logs and k6 output for any API key or request id: none.
5. Every figure in BENCHMARKS.md and docs/providers traces to `bench/results/pr-6/` (R3).

## Data flows

- Chat completion routing and translation → `docs/providers/providers.html` → `packages/gateway/src/{routes/chat.ts,providers/*.ts,upstream.ts}`

## Decisions

- **Google Gemini is the third provider** (founder, D-020).
- **Plain HTTP over the gateway's own undici pools, no provider SDKs** (founder, D-021): one place
  for timeouts, streaming and measurement; no extra dependencies.
- **One live smoke call per provider, run by hand with the founder's keys** (founder, D-022). Not in
  the gate or CI. The builder runs it only once the founder has put `ANTHROPIC_API_KEY`,
  `OPENAI_API_KEY` and `GEMINI_API_KEY` in the root `.env.local`; until then the build ships with
  fixtures recorded from public API documentation examples and says so.
- **Text chat only** for v1; tools and images go on the README roadmap.
- **Prices** come from each provider's published pricing page, fetched at build time, with the
  date and URL stored per row; never from memory. Models priced: the current flagship and
  smallest text model per provider, plus the `mock-*` models.
- **Mock model names** route to the mock in each format: `mock-` / `mock-openai-` → OpenAI format,
  `mock-anthropic-` → Anthropic format, `mock-gemini-` → Gemini format.
- **Config rows:** `MODEL_ROUTES` (default
  `claude-=anthropic,gpt-=openai,o1=openai,o3=openai,o4=openai,gemini-=gemini,mock-anthropic-=mock-anthropic,mock-gemini-=mock-gemini,mock-=mock-openai`),
  `ANTHROPIC_API_KEY`, `ANTHROPIC_BASE_URL=https://api.anthropic.com`,
  `ANTHROPIC_VERSION=2023-06-01`, `GEMINI_API_KEY`,
  `GEMINI_BASE_URL=https://generativelanguage.googleapis.com/v1beta`, `MOCK_BASE_URL=http://127.0.0.1:9000`,
  `DEFAULT_MAX_TOKENS` (shared with PR 4's default). Keys blank in `.env.example`; a provider
  with no key returns 503 `provider_not_configured` instead of crashing at start-up.
- **Docs** (R2): interview Qs incl. "why adapters, not SDKs?", "how do you translate a stream
  without buffering it?", "what breaks if an SSE event is split across TCP packets?",
  "what don't you support yet and why?".
