# Auth

Diagram: [api-key-check.html](api-key-check.html). Code: `packages/gateway/src/auth/`, `src/cli/keys.ts`, `src/db/`.

Every request needs `Authorization: Bearer gw_...`. A key belongs to a tenant; the hook answers 401 or sets
`request.tenant`. Rate limits ([../rate-limiter/README.md](../rate-limiter/README.md)) hang off the key; budgets (PR 5) will hang off the tenant. This is machine-to-machine auth
only; there is no user login and no admin UI.

| File | Job |
|---|---|
| `db/schema.ts` | `tenants` and `api_keys` tables (Drizzle); SQL migration in `packages/gateway/drizzle/` |
| `auth/keys.ts` | Generate a key (`gw_` + 32 random bytes, base64url), derive its 12-char display prefix, HMAC-SHA256 it |
| `auth/key-store.ts` | `lookup(hash, ip)`: Redis, then (after the address guard) Postgres on a miss, then fill the cache. `revoke(hash)` |
| `auth/ip-limit.ts` | Per-address bucket of failed authentications: an atomic take (`ip-take.lua`) with a refund, run by the key store before a Postgres query |
| `auth/plugin.ts` | `onRequest` hook: parse the bearer key, look it up (the key store applies the address guard on a miss), 401, 429 or attach the tenant |
| `cli/keys.ts` | `create-tenant`, `create-key [--rpm --tpm]`, `set-limits <prefix> --rpm --tpm`, `revoke-key <prefix>`, `list-keys` (`npm run keys -- ...`) |

## How a request is checked

0. A valid key that is already cached is never limited. The address limit (`auth/ip-limit.ts`) applies only where a
   request would cost a Postgres query or has already failed: a token bucket in Redis (`AUTH_FAIL_LIMIT_PER_MIN`,
   30) that **failed** authentications draw from. On a key-cache miss the key store, just before the Postgres query,
   runs one atomic Redis script that takes a token, or refuses when the bucket is empty (429
   `auth_rate_limit_exceeded` with `retry-after`, no query). If the key proves valid the token is handed back, so a
   valid client is only ever charged for the moment of its lookup. A cached "unknown key" is charged to the address
   without a query; a missing or malformed key is charged too. Because the take is atomic, a flood of random keys
   at any concurrency reaches Postgres at most as often as the bucket has tokens. The cost: more cold-cache valid
   keys at once from one address than the limit (right after a restart) can be refused until tokens return. A request with no known address is never charged to a shared bucket. With `AUTH_CACHE=none` the address is charged only after Postgres finds no such key. An IPv6
   client shares one bucket per /64. The address is the socket peer's, unless the peer is in `TRUSTED_PROXIES`
   (default `127.0.0.1`), in which case `X-Forwarded-For` is believed. If Redis is down the check is skipped (fails
   open).
1. Parse `Authorization: Bearer <key>`; anything not shaped like a gateway key gets 401 without a lookup.
2. Hash the key with `HMAC-SHA256(API_KEY_PEPPER, key)` and look the hash up: Redis `GET apikey:<hash>`.
3. A cached tenant passes. `"revoked"` and `"unknown"` markers mean 401. A miss reads Postgres
   (`key_hash = $1 and revoked_at is null`) and fills Redis with `SET ... EX ... NX`.
4. Unknown hashes are negatively cached for `AUTH_NEGATIVE_TTL_S`. That protects Postgres from a
   misconfigured client repeating one bad key. A flood of distinct random keys is stopped by the per-address
   limit below.
5. Missing, malformed, unknown and revoked keys all get the same OpenAI-shaped 401
   (`code: invalid_api_key`), so the response never says which keys exist.

The key is shown once by `create-key`. Only the hash and the first 12 characters are stored.
The client's `Authorization` header is not forwarded upstream; the upstream key comes from `OPENAI_API_KEY`.

## Revocation without a race

`revoke-key` updates `revoked_at` in Postgres first, then overwrites the Redis entry with a `"revoked"`
tombstone (TTL longer than the cache TTL). Every cache fill uses `NX`, so a request that read Postgres just before the
revoke cannot write the key back as valid after the tombstone exists. A test holds a lookup between its
Postgres read and its fill, revokes, releases it, and checks the tombstone survived. If Redis is unreachable at
revoke time the CLI exits non-zero and says a cached copy can live for up to `AUTH_CACHE_TTL_S`; running the
same `revoke-key` again once Redis is up rewrites the tombstone (it is safe to repeat, and says so when the
key was already revoked). A prefix shared with old revoked keys still revokes the one active key, and a revoke
waits through a brief Redis reconnect (up to 2 s) before reporting the tombstone as failed.

## Limits on the cached entry

The cached entry carries the key's id and its `rpm_limit` / `tpm_limit` (null = the gateway default), so the rate
limiter needs no database read. `set-limits` writes Postgres, then overwrites the cache entry (not NX) unless it
is a revoke tombstone, so a limit change shows on the next request of every instance and can never undo a revoke.

## Removing a tenant

There is no delete-tenant command. To remove a tenant, revoke its keys first (`revoke-key`, one per key).
Deleting the rows with raw SQL alone leaves cached copies of its keys working for up to `AUTH_CACHE_TTL_S`
(600 s by default), because nothing writes a tombstone.

## If Redis dies

The lookup falls back to Postgres for that request, which stays correct because Postgres is the source of truth.
One warn log per outage, not per request. The client reconnects on its own with a capped back-off.

## Settings

`API_KEY_PEPPER` (required, 32+ characters; the gateway refuses to start without it), `DATABASE_URL`,
`DB_POOL_SIZE` (20), `REDIS_URL`, `REDIS_KEY_PREFIX`, `AUTH_CACHE` (`redis` or `none`; with `none` the address is charged only after Postgres finds no such key; `none` exists only so the
benchmark can show the cost of Postgres on every request), `AUTH_CACHE_TTL_S` (600), `AUTH_NEGATIVE_TTL_S` (60),
`AUTH_TOMBSTONE_TTL_S` (1200), `AUTH_FAIL_LIMIT_PER_MIN` (30; 0 turns the address limit off), `TRUSTED_PROXIES` (`127.0.0.1`; `none` trusts nobody).

The key CLI and every gateway instance must use the same `REDIS_KEY_PREFIX` (and Redis). If they differ, a
revoke writes its tombstone where the gateway never looks, and a cached key keeps working for up to
`AUTH_CACHE_TTL_S`.

## Measured (from [BENCHMARKS.md](../../BENCHMARKS.md), "Auth overhead")

Provisional: measured on a busy shared laptop; PR 12 re-runs it on a quiet machine (residual R8).

With auth and the Redis cache: 0.617 ms p50 / 0.372 ms p95 over a direct run at 1000 req/s non-streamed, and
1.054 ms p50 / 1.447 ms p95 to first streamed byte at 200 req/s. Without the cache: 0.774 ms / 0.482 ms and
1.358 ms / 1.766 ms. These come from one run each in a session whose direct baseline was noisier than in PR 1.
