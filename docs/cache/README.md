# Response cache

Diagram: [cache-flow.html](cache-flow.html). Code: `packages/gateway/src/cache/` (`key.ts`, `store.ts`, `single-flight.ts`,
`replay.ts`, `collect.ts`, `plugin.ts`), the fill in `routes/chat.ts`, and the hit's ledger row in `budget/`.

Apps send the same deterministic request again and again (evals, retries, shared prompts), and each repeat costs a
provider call in money and seconds. The cache answers an identical request from Redis instead. Exact match only; near
duplicates are a later PR.

## What is cached

- Only a request with an explicit `temperature: 0` (an absent temperature is the provider's default, not 0), unless
  `CACHE_ALLOW_NONDETERMINISTIC=true`. Never `n > 1`, `tools`/`functions`, log probabilities or audio.
- Only an answer that finished with `stop` or `length`, came from a served 2xx, and fits `CACHE_MAX_ENTRY_BYTES`.
  Errors, mid-stream errors, truncated streams, content-filtered answers and tool calls are never stored.
- Entries live `CACHE_TTL_S`. Run Redis with `maxmemory-policy volatile-lru` so cache entries (all with a TTL) are
  evicted before keys that never expire (budgets, the circuit breaker).

## The key

A SHA-256 of the request reduced to what decides the answer: the model **asked for** (not the one that served it),
the messages (a string and a single text part are the same), `temperature`, `top_p`, `seed`, `stop` (a string is a
one-element list), the output limit (`max_completion_tokens`, else `max_tokens`, else the gateway default), the
penalties (a zero is the default), `response_format`, and any other field the gateway does not know. Left out:
`stream`, `stream_options`, `user`, `metadata`, `service_tier`, `store`, so a streamed request and a non-streamed one
share an entry. Field order never matters. The key is `cache:v1:{scope}:{hash}`; `v1` changes whenever the rules do.

## Who can see an entry

The scope is the tenant id, hashed into the key, so a lookup can only ever build its own tenant's keys: there is no
check afterwards to get wrong. A tenant switched to the shared pool (`keys set-cache-sharing <tenant> on`) reads and
writes only scope `shared`, and a private tenant never reads it.

## Hits, misses and the header

Every reply that reaches the cache step carries `x-gateway-cache`: `hit`, `miss`, `bypass` (`cache-control: no-store`:
no read, no write), `refresh` (`cache-control: no-cache`: no read, the answer replaces the entry), `uncacheable`, or
`unavailable` (Redis did not answer within `CACHE_REDIS_TIMEOUT_MS`; the request goes upstream as if there were no cache).
A hit has a new `chatcmpl-cache-...` id, `x-gateway-attempts: 0` and `x-gateway-model` set to the model that served
the stored answer (a fallback may differ from the model asked for). A streamed hit is replayed as OpenAI chunks of
`CACHE_REPLAY_CHUNK_CHARS` characters (never splitting an emoji), a usage chunk only if the client asked, then `[DONE]`.
The stored answer is a plain completion, not raw SSE, so one entry serves both kinds of request.

## Billing and limits

A hit is served before the budget step, so it takes no hold and is served even to a tenant whose budget is spent. It
costs nothing: the ledger gets one row with `cached = true`, `cost_micros = 0` and `saved_micros` (the stored usage
priced at the model that served it), and `keys show-spend` prints hits and saved. The rate limiter counts the hit as
one request and gives the token estimate back in full.

## Identical misses: single-flight

For non-streamed requests, the first miss takes a lock (in-process map, then Redis `SET NX PX CACHE_LOCK_MS`) and goes
upstream. Identical requests, in this process or another, wait up to `CACHE_WAIT_MS` for its fill (a Redis pub/sub
message, plus one read right after subscribing and one at timeout) and are served as hits. If the leader fails or
never answers, nobody inherits its failure: each waiter goes upstream on its own. Streamed misses never wait and
never lead.

## Failure behaviour

Redis down or slow means no cache for that request, never a failed request. The fill is written before a
non-streamed reply is sent; a streamed answer is stored after its last byte reached the client, and only if `[DONE]`
was seen with no error event.

## Numbers

Pending quiet run (`bench/run-cache.sh`: cold, warm and stampede). See [../../BENCHMARKS.md](../../BENCHMARKS.md); no
figure is quoted here until `bench/results/pr-8/` is committed (R3).
