# Semantic cache

Diagram: [semantic-flow.html](semantic-flow.html). Code: `packages/gateway/src/semantic/` (`context.ts`, `embedder.ts`,
`store.ts`, `lookup.ts`, `fill.ts`), the step in `cache/plugin.ts`, the table in `db/schema.ts`.

The exact cache misses the same question asked in different words. The semantic cache turns the last user message into a
vector, finds the nearest stored prompt in Postgres (pgvector), and if it is close enough serves that prompt's cached
answer. Every wrong match is a wrong answer to a customer, so the threshold comes from measurements, not taste.

## What may differ

Only the last user message. The model, system prompt, earlier turns, every parameter and any other field of that message
are hashed into a context hash, and the match must have the same hash and the same scope (tenant, or the shared pool).
Both are conditions of the SQL query, never filters applied afterwards. A request whose last message is not plain user
text (an image, several parts) is exact-only. Same cacheability rule as the exact cache: `temperature: 0`, no tools, `n` 1.

## The flow

1. The exact lookup misses. If the tenant has the semantic cache on and the request does not send
   `x-gateway-semantic: off`, the last message is embedded: Voyage `voyage-4-lite` within `SEMANTIC_VOYAGE_TIMEOUT_MS`,
   else the local `voyage-4-nano` within `SEMANTIC_LOCAL_TIMEOUT_MS`, else the step is skipped. A failed Voyage is left
   alone for 5 seconds so an outage costs one timeout, not one per request.
2. The nearest row of the same scope and context that has not expired is read. At or above `SEMANTIC_THRESHOLD` the row's
   `exact_key` is read from Redis. If that entry is gone the row is deleted and the request is a miss.
3. A hit is replayed exactly like an exact hit: `x-gateway-cache: semantic-hit`, `x-gateway-similarity: 0.973`, no provider
   call, a zero-cost ledger row with `cache_kind = 'semantic'` and the saving. `keys show-spend` splits exact and semantic.
4. After the exact cache stores a new answer, its prompt is queued to be embedded and inserted, after the response is on its
   way. The queue is bounded (`SEMANTIC_FILL_QUEUE`); a full queue drops the job and counts it in the logs. The row expires
   with the answer. Expired rows are deleted in batches every `SEMANTIC_CLEANUP_S`.

A request that opts out (`x-gateway-semantic: off`, `cache-control: no-store`, a tenant switched off with
`keys set-semantic-cache <tenant> off`) is never embedded, so its prompt is never sent to the embedding API.

## One embedding space, two models

Voyage 4 models share an embedding space, so a vector from `voyage-4-lite` (API) and one from `voyage-4-nano` (open weights,
run in Ollama from `hf.co/MongoDB/voyage-4-nano-GGUF:Q8_0`) are comparable and live in one `vector(1024)` column. Both are
asked for 1024 dimensions (nano's 2048 are cut and re-normalised by Ollama), and the gateway L2-normalises. Each row records
which model made it. `SEMANTIC_CROSS_MODEL=false` (until the evaluation says otherwise) compares a query only with vectors
from its own model. `SEMANTIC_INPUT_TYPE` chooses whether the text is embedded bare or with the model's query prompt.
Voyage pricing, read from https://docs.voyageai.com/docs/pricing on 2026-11-09: `voyage-4-lite` is $0.02 per million tokens,
and the first 200 million tokens of an account are free.

## Failure modes

- No key, slow API or Ollama down: the semantic step is skipped and the request is an ordinary miss. Nothing fails.
- Postgres slow (`SEMANTIC_PG_TIMEOUT_MS`) or down: a miss.
- A different number or made-up name barely moves an embedding: in a smoke run the local model scored "capital of Zorvania-3"
  and "capital of Zorvania-9" as near-identical. Questions that differ only in a detail the model ignores can be served
  each other's answer, which is why the threshold is chosen against labelled non-paraphrases (PAWS) and a tenant can turn the
  feature off.
- A filtered vector search can return too few rows: the query uses pgvector's iterative scan so the scan continues until it
  finds a row that passes the filter.

## Choosing the threshold

`bench/semantic/eval.ts` takes labelled pairs from Quora Question Pairs (real paraphrases; no licence file is published
with it, so it is used here for internal evaluation only) and PAWS-Wiki (the same words in another order, half of them
meaning something else; Google LLC, free for any purpose). Both are downloaded at run time against a pinned sha256 and not
committed. For each threshold from 0.80 to 0.99 it counts the paraphrases served (hit rate) and the share of served answers
that belong to a different question (wrong-answer rate), for each model and across models. The threshold is the one with the
most hits while at most 1% of served answers are wrong, chosen on a dev half and reported on a test half.

Pending quiet run: `npm run bench:semantic-eval`. No figure is quoted here until `bench/results/pr-9/` is committed (R3);
until then `SEMANTIC_THRESHOLD` is 0.95.

## Choosing the index

`bench/semantic/index-bench.ts` compares HNSW, IVFFlat and an exact scan on recall@1, p50 and p95 query time, build time and
size at 10 000 and 100 000 vectors, with the scope-and-context filter (1 context, and 1 row in 50) as well as without.
The migration builds an HNSW index provisionally; the index bench decides.

Pending quiet run: `npm run bench:vector-index`. Request latency of a semantic hit against an exact hit and a miss:
`npm run bench:semantic`. See [../../BENCHMARKS.md](../../BENCHMARKS.md).
