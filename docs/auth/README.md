# Auth

Diagram: [api-key-check.html](api-key-check.html). Code: `packages/gateway/src/auth/`, `src/cli/keys.ts`, `src/db/`.

Every request needs `Authorization: Bearer gw_...`. A key belongs to a tenant; the hook answers 401 or sets
`request.tenant`. Limits (PR 4) and budgets (PR 5) will hang off that tenant. This is machine-to-machine auth
only; there is no user login and no admin UI.

| File | Job |
|---|---|
| `db/schema.ts` | `tenants` and `api_keys` tables (Drizzle); SQL migration in `packages/gateway/drizzle/` |
| `auth/keys.ts` | Generate a key (`gw_` + 32 random bytes, base64url), derive its 12-char display prefix, HMAC-SHA256 it |
| `auth/key-store.ts` | `lookup(hash)`: Redis, then Postgres on a miss, then fill the cache. `revoke(hash)` |
| `auth/plugin.ts` | `onRequest` hook: parse the bearer key, look it up, 401 or attach the tenant |
| `cli/keys.ts` | `create-tenant`, `create-key`, `revoke-key <prefix>`, `list-keys` (`npm run keys -- ...`) |

## How a request is checked

1. Parse `Authorization: Bearer <key>`; anything not shaped like a gateway key gets 401 without a lookup.
2. Hash the key with `HMAC-SHA256(API_KEY_PEPPER, key)` and look the hash up: Redis `GET apikey:<hash>`.
3. A cached tenant passes. `"revoked"` and `"unknown"` markers mean 401. A miss reads Postgres
   (`key_hash = $1 and revoked_at is null`) and fills Redis with `SET ... EX ... NX`.
4. Unknown hashes are negatively cached for `AUTH_NEGATIVE_TTL_S`. That protects Postgres from a
   misconfigured client repeating one bad key; it does not protect against a flood of distinct random keys, and
   per-IP limiting is out of scope here (residual R9).
5. Missing, malformed, unknown and revoked keys all get the same OpenAI-shaped 401
   (`code: invalid_api_key`), so the response never says which keys exist.

The key is shown once by `create-key`. Only the hash and the first 12 characters are stored.
The client's `Authorization` header is not forwarded upstream; the upstream key comes from `OPENAI_API_KEY`.

## Revocation without a race

`revoke-key` updates `revoked_at` in Postgres first, then overwrites the Redis entry with a `"revoked"`
tombstone (TTL longer than the cache TTL). Cache fills use `NX`, so a request that read Postgres just before the
revoke cannot write the key back as valid after the tombstone exists. A test holds a lookup between its
Postgres read and its fill, revokes, releases it, and checks the tombstone survived. If Redis is unreachable at
revoke time the CLI exits non-zero and says a cached copy can live for up to `AUTH_CACHE_TTL_S`.

## Removing a tenant

There is no delete-tenant command. To remove a tenant, revoke its keys first (`revoke-key`, one per key).
Deleting the rows with raw SQL alone leaves cached copies of its keys working for up to `AUTH_CACHE_TTL_S`
(600 s by default), because nothing writes a tombstone.

## If Redis dies

The lookup falls back to Postgres for that request, which stays correct because Postgres is the source of truth.
One warn log per outage, not per request. The client reconnects on its own with a capped back-off.

## Settings

`API_KEY_PEPPER` (required, 32+ characters; the gateway refuses to start without it), `DATABASE_URL`,
`DB_POOL_SIZE` (20), `REDIS_URL`, `REDIS_KEY_PREFIX`, `AUTH_CACHE` (`redis` or `none`; `none` exists only so the
benchmark can show the cost of Postgres on every request), `AUTH_CACHE_TTL_S` (600), `AUTH_NEGATIVE_TTL_S` (60),
`AUTH_TOMBSTONE_TTL_S` (1200).

The key CLI and every gateway instance must use the same `REDIS_KEY_PREFIX` (and Redis). If they differ, a
revoke writes its tombstone where the gateway never looks, and a cached key keeps working for up to
`AUTH_CACHE_TTL_S`.

## Measured (from [BENCHMARKS.md](../../BENCHMARKS.md), "Auth overhead")

Provisional: measured on a busy shared laptop; PR 12 re-runs it on a quiet machine (residual R8).

With auth and the Redis cache: 0.617 ms p50 / 0.372 ms p95 over a direct run at 1000 req/s non-streamed, and
1.054 ms p50 / 1.447 ms p95 to first streamed byte at 200 req/s. Without the cache: 0.774 ms / 0.482 ms and
1.358 ms / 1.766 ms. These come from one run each in a session whose direct baseline was noisier than in PR 1.

## Questions you should be able to answer

1. **Why not bcrypt for keys?** Slow hashes defend low-entropy passwords. A key is 256 random bits, so guessing
   is infeasible and a slow hash would only add latency to every request. HMAC with a server-side pepper means a
   stolen database alone cannot be used to test guesses.
2. **Why not Auth.js?** It logs humans into websites. This checks machines on every API request, with no
   sessions or cookies.
3. **How is revocation instant without a race?** Postgres first, then an overwriting tombstone in Redis, while
   cache fills use `NX` so they can never overwrite it. The cost is one Redis round trip per request.
4. **What if Redis dies?** Requests fall back to Postgres; revoked keys stay rejected. Revoking while Redis is
   down still works in Postgres, and the CLI warns that a cached copy may linger.
5. **How do you avoid a key-existence oracle?** One 401 body for every failure, and unknown routes also answer
   401 before routing. Response timing was not measured separately for unknown, revoked and malformed keys.
