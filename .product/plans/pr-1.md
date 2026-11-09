# PR 1 — Skeleton, mock provider and streaming passthrough

**CONCERN:** the repo holds only the loop kit, README and roadmap; there is no runnable gateway,
no provider to test against and no measurement, so no later PR has a baseline to compare to.

**ACCEPTANCE:** `docker compose up` brings up Redis and Postgres+pgvector; `POST /v1/chat/completions` through the gateway returns the mock's response, streamed and non-streamed, with SSE chunks arriving unbuffered (test asserts the first chunk reaches the client before the last is sent); a committed k6 run of the mock direct vs through the gateway records gateway overhead p50/p95 and req/s in BENCHMARKS.md with hardware and versions.

**SCOPE GUARD:** one upstream (the mock, OpenAI wire format). No auth, rate limits, budgets,
caching, retries, breaker, provider adapters or log pipeline: each has its own PR. Redis and
Postgres are brought up but not used by gateway code. No dashboard package yet.

**BASE:** main `6bf898d`; branch `pr-1-skeleton` (worktree `.claude/worktrees/pr-1-skeleton`);
stacked on none; migration: none. Residuals owned by this PR: none.

**Starting point:** the worktree already holds an uncommitted scaffold (workspaces, tsconfig,
vitest config, compose file, `.env.example`, and a working mock provider at
`packages/mock-provider/src/server.ts`). Keep it, adjust it as below, commit it in step 1.

## Files
| path | change |
|---|---|
| `package.json` | **new** (scaffold). npm workspaces; scripts `typecheck`, `test`, `dev:mock`, `dev:gateway`, `bench:baseline` |
| `package-lock.json` | **new** |
| `tsconfig.json` | **new** (scaffold). Strict, `erasableSyntaxOnly` so Node runs `.ts` directly with no build step |
| `vitest.config.ts` | **new** (scaffold). `include: ['packages/*/src/**/*.test.ts']`: tests sit beside the code they test (D-008) |
| `docker-compose.yml` | **new** (scaffold). Compose project `name: llm-gateway` so every worktree shares one stack; Redis 7.4 on 127.0.0.1:6379; `pgvector/pgvector:pg17` on 127.0.0.1:5436 (5432–5435 are taken on this machine); fix the comment to say Docker on macOS (Colima here), not Docker Desktop |
| `.env.example` | **new** (scaffold). Every key with a non-blank value |
| `.gitignore` | add `.env.local` |
| `packages/mock-provider/package.json` | **new** (scaffold) |
| `packages/mock-provider/src/server.ts` | **new** (scaffold). Refactor to export `createMockServer(settings)`; start-up only under `import.meta.main` |
| `packages/mock-provider/src/server.test.ts` | **new** |
| `packages/gateway/package.json` | **new** (scaffold). Deps: fastify, undici, zod |
| `packages/gateway/src/config.ts` | **new**. Env parsed with zod; blank strings treated as unset |
| `packages/gateway/src/errors.ts` | **new**. `errorBody`, the one OpenAI-shaped error constructor shared by `app.ts` and the chat route |
| `packages/gateway/src/upstream.ts` | **new**. One undici `Pool` per upstream origin, size `UPSTREAM_CONNECTIONS` |
| `packages/gateway/src/app.ts` | **new**. `buildApp(config)` returns a Fastify instance; registers the chat route |
| `packages/gateway/src/routes/chat.ts` | **new**. `POST /v1/chat/completions` passthrough, streamed and non-streamed |
| `packages/gateway/src/server.ts` | **new**. Entry: load config, listen, graceful shutdown on SIGTERM/SIGINT |
| `packages/gateway/src/routes/chat.test.ts` | **new** |
| `bench/k6/chat.js` | **new**. One parameterised k6 script (target URL, stream on/off, arrival rate, duration via env) |
| `bench/run-baseline.sh` | **new**. Starts mock + gateway natively, runs the 4 scenarios, writes results, stops both |
| `bench/results/pr-1/*.json` | **new**. Raw k6 summaries, one per scenario |
| `BENCHMARKS.md` | **new**. Method, machine, versions, results table for PR 1 |
| `docs/README.md` | **new**. Index: one line per part folder |
| `docs/architecture/README.md` | **new**. The whole system in one page: components, request flow (built vs planned, marked) |
| `docs/architecture/architecture.html` | **new**. Archify diagram of the full v1 architecture, built parts solid, planned parts marked |
| `docs/gateway/README.md` | **new**. The gateway: passthrough, streaming, upstream pool, error mapping, timing header |
| `docs/gateway/chat-passthrough.html` | **new**. Archify sequence diagram of a streamed and a non-streamed request, from the code as built |
| `docs/mock-provider/README.md` | **new**. What the mock is for, its settings and `/__control` |
| `docs/mock-provider/mock-provider.html` | **new**. Archify diagram of the mock's request handling and outage modes |
| `docs/benchmarks/README.md` | **new**. Method: why native not Docker (the decision record), k6 executor, scenarios, how overhead is cross-checked |
| `docs/benchmarks/benchmarks.html` | **new**. Archify diagram of the benchmark rig: k6 → gateway → mock, and k6 → mock direct |
| `docs/diagrams/flows.md` | add the flow line below (the kit's registry stays at this path; diagrams live in part folders) |
| `.github/workflows/ci.yml` | **new**. On push and PR: Node 24, `npm ci`, typecheck, test |
| `README.md` | replace "Getting started" with real run steps; link `BENCHMARKS.md` and `docs/` |

## Schema

none.

## Invariants

- **Streaming is never buffered.** For `stream: true` the route takes the raw response
  (`reply.hijack()`), writes status and headers once the upstream answers, and pipes upstream
  body bytes to the client as they arrive. No compression, no JSON parsing of chunks, no
  collecting the body. Client disconnect aborts the upstream request (AbortSignal), so a dropped
  client never holds a pooled socket.
- **Non-streamed responses** are passed through as bytes with the upstream status and
  content-type; the gateway does not re-serialise the JSON.
- **Upstream failure mapping:** connection error or upstream timeout → 502 / 504 with an
  OpenAI-shaped error body `{error:{message,type:"gateway_error"}}`. An upstream 4xx/5xx is passed
  through unchanged (retries/fallback are PR 7).
- **Timing header:** every non-streamed response carries
  `server-timing: gw;dur=<ms>, upstream;dur=<ms>` where upstream is request-sent → body received
  and gw is total minus upstream. Streamed responses carry `server-timing: gw-pre;dur=<ms>`
  (time from request received to upstream request dispatched), set before the first byte.
- **Nothing logs per request on the hot path.** Fastify logger level from `LOG_LEVEL`, default `warn`.
- The request body is validated only for shape the gateway needs (`model` string, `messages`
  array, optional `stream` boolean); everything else is forwarded untouched. Invalid → 400.

## Tests

`packages/gateway/src/routes/chat.test.ts` (starts a real mock server and the app on port 0):
- `non-streamed request returns the mock completion and usage`
- `streamed request relays SSE chunks ending in [DONE]`
- `stream is unbuffered: first chunk arrives before the mock sends its last` — mock set to
  20 tokens × 50 ms; assert time-to-first-chunk at the client < 500 ms while total > 1000 ms
- `client abort mid-stream aborts the upstream request` — mock observes its response closed
- `invalid body returns 400 without calling upstream`
- `upstream down returns 502 with an OpenAI-shaped error`
- `upstream 500 is passed through with its status`
- `non-streamed response carries server-timing gw and upstream durations`

`packages/mock-provider/src/server.test.ts`:
- `control endpoint switches outage to error and back`
- `streamed response emits completionTokens chunks then usage then [DONE]`

## Acceptance proof

1. `docker compose up -d --wait` → both services healthy (`docker compose ps`).
2. `npm run dev:mock` and `npm run dev:gateway` (from `.env.local`), then
   `curl -N localhost:8080/v1/chat/completions -d '{"model":"m","stream":true,"messages":[{"role":"user","content":"hi"}]}'`
   → tokens print one by one (route: `packages/gateway/src/routes/chat.ts` → `upstream.ts` → mock).
3. `bash scripts/gate.sh` → PASS (tests above).
4. `npm run bench:baseline` → writes `bench/results/pr-1/{direct,gateway}-{instant,realistic}.json`;
   numbers transcribed into `BENCHMARKS.md`. Each figure in BENCHMARKS.md must match its JSON file.

## Adversarial

1. Kill the mock mid-stream: the client gets a terminated stream, the gateway stays up and serves
   the next request.
2. 500 clients disconnect mid-stream at once: the upstream pool returns to idle (no leaked sockets).
3. Upstream sends a 5 MB non-streamed body: passed through intact, memory stays flat.
4. Upstream hangs (`outage: hang`): the client gets 504 within `UPSTREAM_TIMEOUT_MS`.
5. Benchmark figures in BENCHMARKS.md each trace to a committed JSON file; none invented.

## Data flows

- Chat completion passthrough → `docs/gateway/chat-passthrough.html` → `packages/gateway/src/{routes/chat.ts,upstream.ts}`

## Decisions

- **Framework:** Fastify 5 (D-002). Upstream HTTP client: undici `Pool` (Fastify's own fetch
  stack; keep-alive, explicit pool size so it can be named when it becomes the bottleneck).
- **TypeScript runs natively** via Node's type stripping: no build step, no ts-node/tsx.
- **Benchmark method (founder, this session):**
  - Two mock settings. *Instant*: `MOCK_LATENCY_MS=0`, `MOCK_TOKEN_DELAY_MS=0` → throughput
    ceiling. *Realistic*: 200 ms to first token, 20 tokens × 10 ms, streamed → user-felt overhead.
  - Overhead measured two ways that must agree: k6 direct-vs-gateway difference, and the
    gateway's own `server-timing`. If they disagree by more than 1 ms at p50, investigate before
    publishing.
  - Gateway, mock and k6 run natively on the laptop; Docker only for Redis/Postgres. Laptop vs
    cloud VM for final numbers is PR 12.
- **k6 shape:** `constant-arrival-rate` executor (fixed requests/s, not fixed users, so a slow
  gateway can't hide by slowing the load). Per scenario: 30 s warm-up discarded, 60 s measured.
  Throughput run steps the rate up until errors > 1% or p95 doubles; the last good rate is the
  req/s figure. Record k6 `--summary-export` JSON.
- **BENCHMARKS.md records:** machine (Apple M5, 10 cores, 24 GB), macOS, Node, k6, Fastify and
  undici versions, pool size, payload size, rates, durations, git commit.
- **Docs are one folder per part** (D-009): `docs/<part>/README.md` plus an archify diagram
  (standard quality, one pass, drawn from the code as built) in the same folder. Each README is
  plain English for the founder, ≤ 1 page: what the part does and why, the decisions and their
  numbers, and 3–5 likely interview questions with answers. PR 1's parts: architecture, gateway,
  mock-provider, benchmarks. Between them they cover what a gateway is, SSE streaming, why the
  mock exists, how overhead is measured, and the PR 1 numbers.
- **Tests sit beside the code** they test as `<file>.test.ts` (D-008); no `test/` folders.
- **CI** runs typecheck and tests only; benchmarks are run locally and committed.
- New config rows (all in `.env.example` with defaults): `GATEWAY_PORT=8080`,
  `OPENAI_BASE_URL=http://127.0.0.1:9000`, `UPSTREAM_CONNECTIONS=256`,
  `UPSTREAM_TIMEOUT_MS=30000`, `LOG_LEVEL=warn`, `MOCK_*` as in the scaffold.
