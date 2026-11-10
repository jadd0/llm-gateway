# Semantic cache

Diagram: [semantic-flow.html](semantic-flow.html). Code: `packages/gateway/src/semantic/` (`context.ts`, `embedder.ts`,
`store.ts`, `lookup.ts`, `fill.ts`), the step in `cache/plugin.ts`, the table in `db/schema.ts`.

The exact cache misses the same question asked in different words. The semantic cache turns the last user message into a
vector, finds the nearest stored prompt in Postgres (pgvector), and if it is close enough and passes the guards serves that
prompt's cached answer. Every wrong match is a wrong answer to a customer, so the threshold and the guards come from
measurements, not taste.

**It is off for every tenant until the tenant opts in** (`npm run keys -- set-semantic-cache <tenant> on`). An embedding
ranks prompts by meaning, and the meaning it ranks by blurs exactly what separates two answers: an early evaluation served
the answer for order 1235 to a request about order 1234 at similarity 0.982, and served a large share of non-paraphrases at
0.95. Exact-match caching, which has none of that risk, stays on for everyone. `SEMANTIC_ENABLED=false` switches the feature
off for the whole gateway whatever the tenants say.

**Requires Postgres with the pgvector extension** (0.8 or later preferred). `docker-compose.yml` runs the pinned
`pgvector/pgvector` image. Migration 0007 runs `CREATE EXTENSION vector`; on a Postgres without it `npm run db:migrate` stops
with a message that says so, and the gateway refuses to start with `SEMANTIC_ENABLED=true` until the extension is there.
The same version check picks the query: from 0.8 the index scan keeps going until a filtered query has its row
(`hnsw.iterative_scan`); before 0.8 the index is not used for a large scope and context, which are sorted exactly instead.

**Migration.** 0007 is new in this change (numbered after the request log's 0005 and 0006): it creates the extension, the `semantic_cache` table, the `semantic_nearest`
function the lookup calls, `spend_ledger.cache_kind` (existing cached rows become `exact`) and `tenants.semantic_cache` (default false, so no tenant changes
behaviour until `keys set-semantic-cache <tenant> on`). A semantic hit is logged with `request_log.cache = 'semantic-hit'`, and its ledger row, written by the log worker from the spend stream, carries `cache_kind = 'semantic'`.

## What may differ

Only the last user message. The model, system prompt, earlier turns, every parameter and any other field of that message
are hashed into a context hash, and the match must have the same hash and the same scope (tenant, or the shared pool).
Both are conditions of the SQL query, never filters applied afterwards. A request whose last message is not plain user
text (an image, several parts) is exact-only. Same cacheability rule as the exact cache: `temperature: 0`, no tools, `n` 1.

## The flow

1. The exact lookup misses. If the tenant has opted in and the request does not send `x-gateway-semantic: off`, the burst's
   leader (see step 5) embeds the last message: Voyage `voyage-4-lite` within `SEMANTIC_VOYAGE_TIMEOUT_MS`,
   else the local `voyage-4-nano` within `SEMANTIC_LOCAL_TIMEOUT_MS`, else the step is skipped. A failed Voyage is left
   alone for 5 seconds so an outage costs one timeout, not one per request.
2. The nearest row of the same scope and context that has not expired is read. At or above `SEMANTIC_THRESHOLD` it must pass
   the guards (below) before the row's `exact_key` is read from Redis. A guard that refuses is a miss, and the response
   carries `x-gateway-semantic-guard: numbers|quotes|names|negation|tokens`. If the answer is gone from Redis the row is
   deleted in the background and the request is a miss.
3. A hit is replayed exactly like an exact hit: `x-gateway-cache: semantic-hit`, `x-gateway-similarity: 0.973`, no provider
   call, a zero-cost ledger row with `cache_kind = 'semantic'` and the saving. `keys show-spend` splits exact and semantic.
4. After the exact cache stores a new answer, its prompt is queued to be embedded and inserted, after the response is on its
   way. The queue is bounded (`SEMANTIC_FILL_QUEUE`); a full queue drops the job and counts it in the logs. The row expires
   with the answer. Expired rows are deleted in batches every `SEMANTIC_CLEANUP_S`.
5. The lookup runs inside the exact cache's single-flight. If the leader is served by a similar prompt it hands its
   followers a reference to that entry (kept in Redis for a few seconds, so followers in other processes get it too), and they
   are served without asking. A follower that opted out, or whose tenant is off, goes upstream instead, and nothing is
   written under the exact key, where such a request would read it as an exact answer. A follower that is not handed
   an answer (the leader failed, gave up, or its lookup found nothing and the answer could not be cached) looks for itself
   before going upstream, so a similar answer is never passed over.

A request that opts out (`x-gateway-semantic: off`, `cache-control: no-store`, a tenant that has not opted in or was switched
off with `keys set-semantic-cache <tenant> off`) is never embedded, so its prompt is never sent to the embedding API.

## Guards

A vector is close for prompts that mean different things to a customer, so the stored prompt and the request must also agree
on what the vector cannot see. Each is checked on the nearest row, after the threshold; the first that fails refuses it.

| rule | header value | passes when |
|---|---|---|
| numbers and IDs | `numbers` | the digit sequences (`1234`, `3.5`, `A-123`, `#77`) are the same, as multisets |
| quoted strings | `quotes` | the `'...'`, `"..."`, backtick and curly-quoted strings are the same, as multisets |
| names | `names` | the capitalised words that do not start a sentence are the same set |
| negation | `negation` | the count of `not`, `no`, `never`, `without`, `cannot`, `n't` ... is the same |
| content words | `tokens` | the sets of content words (lowercased, stop words removed) differ by at most `SEMANTIC_GUARD_MAX_DIFF` (2) words in total; off with `SEMANTIC_GUARD_TOKENSET=false` |

The row keeps a *signature* of its prompt, not the prompt: every element is a truncated hash, so Postgres holds no prompt text
(the vector is already a lossy encoding of it) and the guards still get equality and set difference, which is all they use.
A row whose signature version this code does not know is never served. The guards only make the cache serve less; what they cannot see is
word order ("A beat B" against "B beat A" has the same names, words and numbers), and a related-but-different question
(same topic, same names) passes them.

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
  each other's answer, which is why the guards compare numbers, names and quotes exactly, the threshold is chosen against labelled
  non-paraphrases (PAWS), and the feature is off until a tenant opts in.
- The query's time budget is enforced by Postgres: a lookup is one statement (the `semantic_nearest` function counts, picks
  the path and ranks), and the lookup pool is opened with `statement_timeout = SEMANTIC_PG_TIMEOUT_MS`, so a slow query is
  cancelled with its connection freed and no transaction is left behind when the caller stops waiting. Lookups use a pool of
  their own (`SEMANTIC_PG_POOL`, connections kept warm, up to 2 s to open one: opening a connection is not the query), and
  fills, removals and the sweep another (`SEMANTIC_PG_FILL_POOL`), so a burst of fills never takes a lookup's connection and
  neither queues behind authentication or the budget.
- A filtered vector search can return too few rows. A scope and context with up to 1000 rows is searched exactly (read
  through the `(scope, context_hash)` index, sorted by distance), which no index setting can make miss. A larger one uses the
  vector index with an iterative scan on pgvector 0.8 and later, and an exact sort before.
- With `SEMANTIC_CROSS_MODEL=false`, rows made by Voyage are invisible to lookups embedded locally. During a Voyage outage
  (every lookup embeds locally) the cache therefore serves only the rows the local model made, and recovers when Voyage does.
  A fill embeds patiently, but while Voyage is backing off it too goes straight to the local model.

## Choosing the threshold

`bench/semantic/eval.ts` takes labelled pairs from Quora Question Pairs (real paraphrases; no licence file is published
with it, so it is used here for internal evaluation only) and PAWS-Wiki (the same words in another order, half of them
meaning something else; Google LLC, free for any purpose). Both are downloaded at run time against a pinned sha256 and not
committed. For each threshold from 0.80 to 0.99 it counts the paraphrases served (hit rate) and the share of served answers
that belong to a different question (wrong-answer rate), for each embedding model, input type and across models, four ways:

- *pairwise*: each pair alone, the answer of the first prompt served to the second;
- *nearest neighbour*: the store holds the first prompt of every pair and each second prompt is asked of it, as the gateway
  looks up, so a prompt can be served another pair's answer. An answer is right only when the entry served is the pair's own
  first prompt of a duplicate pair; any other entry served counts as wrong;
- each of those with and without the guards.

The threshold is selected on a dev half by nearest neighbour with guards (the most right answers while at most 1% of served
answers are wrong) and reported on a test half. When no threshold meets 1% the report says so and recommends the threshold
with the lowest wrong rate among those that still serve at least `--min-hit-rate` (default 5%) of the duplicates. 1% stays
the target; the shipped `SEMANTIC_THRESHOLD` (0.95) and the opt-in default stand until the committed numbers say otherwise.

Pending quiet run: `npm run bench:semantic-eval`. No figure is quoted here until `bench/results/pr-9/` is committed (R3); the
report there is published whatever it shows.

## Choosing the index

`bench/semantic/index-bench.ts` compares HNSW, IVFFlat and an exact scan on recall@1, p50 and p95 query time, build time and
size at 10 000 and 100 000 vectors, with the scope-and-context filter (1 context, and 1 row in 50) as well as without.
The migration builds an HNSW index provisionally; the index bench decides.

Not run in the final suite: `npm run bench:vector-index`. Measured ([../../BENCHMARKS.md](../../BENCHMARKS.md)): a semantic hit answers in 37.6 ms
p50 against 443 ms for a miss. On held-out QQP and PAWS pairs no threshold keeps wrong answers under 1% with the
local embedder (best 0.88: 55.89% of served answers wrong), so the cache stays off by default and per-tenant
opt-in (D-061); the Voyage API embedder is not evaluated yet.
