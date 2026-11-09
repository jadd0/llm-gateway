# PR 3 — Tenants and API keys

**CONCERN:** the gateway serves anyone who can reach it and cannot tell callers apart
(`packages/gateway/src/routes/chat.ts` has no auth), so per-tenant limits (PR 4) and budgets
(PR 5) have nothing to attach to.

**ACCEPTANCE:** tenants and keys in Postgres with keys stored hashed (never plaintext); a missing or wrong key gets 401, a valid key passes and the tenant is attached to the request; key lookup is cached so the hot path does not query Postgres per request; overhead re-measured with auth on and recorded.

**SCOPE GUARD:** authentication of machine callers by API key only. No user login, sessions or
admin UI (dashboard auth is PR 11). No limits or budgets columns (PR 4, PR 5). Key management
is a CLI script.

**BASE:** main after PR 1 merges (merge main in first; this PR edits PR 1's gateway); branch
`pr-3-api-keys` (worktree `.claude/worktrees/pr-3-api-keys`); stacked on none; migration: the
first one (drizzle-kit names it at generate time). Residuals owned by this PR: none.

## Files
| path | change |
|---|---|
| `packages/gateway/package.json` | deps `drizzle-orm@^0.45.4`, `pg@^8.23.1`, `ioredis@^6.0.0`; dev `drizzle-kit@^0.31.11`, `@types/pg`; scripts `db:generate`, `db:migrate`, `keys` |
| `package-lock.json` | updated |
| `package.json` | root scripts `db:migrate`, `keys` forwarding to the gateway workspace |
| `packages/gateway/drizzle.config.ts` | **new**. Schema path, `drizzle/` output, `DATABASE_URL` |
| `packages/gateway/drizzle/` | **new**. Generated SQL migration + drizzle meta (never hand-edited) |
| `packages/gateway/src/db/schema.ts` | **new**. `tenants`, `api_keys` tables (see Schema) |
| `packages/gateway/src/db/client.ts` | **new**. One `pg` Pool + drizzle instance; pool size from config |
| `packages/gateway/src/db/migrate.ts` | **new**. Applies migrations with drizzle's migrator; run by `db:migrate` |
| `packages/gateway/src/redis.ts` | **new**. One ioredis client from `REDIS_URL` |
| `packages/gateway/src/auth/keys.ts` | **new**. Generate a key, derive its display prefix, HMAC-SHA256 it |
| `packages/gateway/src/auth/keys.test.ts` | **new** |
| `packages/gateway/src/auth/key-store.ts` | **new**. Lookup (Redis → Postgres), cache fill, revoke with tombstone |
| `packages/gateway/src/auth/key-store.test.ts` | **new** |
| `packages/gateway/src/auth/plugin.ts` | **new**. Fastify `onRequest` hook: parse bearer key, look up, 401 or attach `request.tenant` |
| `packages/gateway/src/auth/plugin.test.ts` | **new** |
| `packages/gateway/src/cli/keys.ts` | **new**. `create-tenant`, `create-key`, `revoke-key`, `list-keys` |
| `packages/gateway/src/cli/keys.test.ts` | **new** |
| `packages/gateway/src/config.ts` | new rows (see Decisions), plus `REDIS_KEY_PREFIX` so tests namespace their Redis keys |
| `packages/gateway/src/errors.ts` | `errorBody` takes an optional `code` for the 401 body |
| `packages/gateway/src/test-env.ts` | **new**. Test helper: reads `.env.local`, random pepper and Redis prefix per run, `seedKey`, `cleanup` |
| `.product/gate-steps` | `db-migrate` step so the suite always runs against a migrated database |
| `packages/gateway/src/app.ts` | register auth plugin before routes; close db and redis on shutdown |
| `packages/gateway/src/routes/chat.test.ts` | existing tests send a valid key |
| `.env.example` | new rows |
| `.product/config.md` | `db_migrate`: `npm run db:migrate` (new worktrees get the schema) |
| `.github/workflows/ci.yml` | add Postgres (pgvector image) and Redis service containers; run `db:migrate` before tests |
| `bench/run-baseline.sh` | create a bench tenant + key, send it; `AUTH_CACHE` passed through; results dir by PR |
| `bench/k6/chat.js` | send `Authorization: Bearer $API_KEY` when set |
| `bench/results/pr-3/*.json` | **new**. Raw k6 summaries |
| `BENCHMARKS.md` | "Auth overhead (PR 3)" section |
| `docs/auth/README.md` | **new**. Plain-English: keys, hashing, cache, revocation, numbers, interview Qs |
| `docs/auth/api-key-check.html` | **new**. Archify diagram of the per-request key check incl. cache miss and tombstone |
| `docs/README.md` | add `auth/` |
| `docs/architecture/README.md` | mark auth as built |
| `docs/architecture/architecture.html` | redraw with auth built |
| `docs/gateway/README.md` | note the auth hook in the request path |
| `docs/diagrams/flows.md` | add the two flow lines below |

## Schema

```sql
create table tenants (
  id          uuid primary key default gen_random_uuid(),
  name        text not null unique,
  created_at  timestamptz not null default now()
);
create table api_keys (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references tenants(id) on delete cascade,
  key_hash    text not null unique,          -- hex HMAC-SHA256(pepper, full key)
  prefix      text not null,                 -- first 12 chars, for display and revoke-by-prefix
  name        text,
  created_at  timestamptz not null default now(),
  revoked_at  timestamptz
);
create index api_keys_tenant_idx on api_keys(tenant_id);
```
Declared in `src/db/schema.ts`; SQL generated by drizzle-kit.

## Invariants

- **Plaintext keys never persist.** Only `key_hash` and `prefix` are stored; the full key is
  printed once by `create-key` and never logged. A test greps the DB row for the key.
- **Key format:** `gw_` + 32 random bytes base64url (`crypto.randomBytes`). Hash =
  `HMAC-SHA256(API_KEY_PEPPER, key)` hex, Node's built-in `crypto` (no custom crypto).
- **Lookup order (the one seam):** `key-store.lookup(hash)`:
  1. Redis `GET apikey:<hash>` → JSON `{tenantId,tenantName}` = valid; `"revoked"` or
     `"unknown"` = 401.
  2. Miss → Postgres `select … where key_hash = $1 and revoked_at is null` joined to tenant.
  3. Fill: valid → `SET apikey:<hash> <json> EX AUTH_CACHE_TTL_S NX`; not found →
     `SET apikey:<hash> "unknown" EX AUTH_NEGATIVE_TTL_S NX`.
- **Instant revocation with no race:** `revoke-key` updates `revoked_at` in Postgres first, then
  `SET apikey:<hash> "revoked" EX AUTH_TOMBSTONE_TTL_S` (overwrite, no NX). Because fills use
  `NX`, a request that read Postgres just before the revoke cannot re-cache the key as valid
  after the tombstone is written. Tombstone TTL > cache TTL.
- **Redis unavailable → fall back to Postgres** for that request (Postgres is the source of
  truth, so revocation stays correct); one warn log per outage, not per request.
- **Client credentials never go upstream.** The incoming `authorization` header is not forwarded;
  the upstream key comes from config (already true in PR 1's `upstream.ts`; a test asserts it).
- **401 body is OpenAI-shaped:** `{error:{message,type:"invalid_request_error",code:"invalid_api_key"}}`.
  Same response for missing, malformed, unknown and revoked keys (no key-existence oracle).
- Header: `Authorization: Bearer <key>` (what OpenAI SDKs already send).

## Tests

`src/auth/keys.test.ts`:
- `generated keys are gw_-prefixed, 43+ chars and unique across 10k draws`
- `hash is deterministic per pepper and differs across peppers`

`src/auth/key-store.test.ts` (real Redis and the worktree Postgres):
- `cache miss reads Postgres then serves the next lookup from Redis` (Postgres query count = 1)
- `unknown key is negatively cached`
- `revoke takes effect on the very next lookup`
- `revoke racing a cache fill cannot leave the key cached as valid` (fill with NX after tombstone → still revoked)
- `Redis down falls back to Postgres and still rejects a revoked key`

`src/auth/plugin.test.ts`:
- `missing, malformed, unknown and revoked keys all get the same 401 body`
- `valid key reaches the route with request.tenant set`
- `client authorization header is not sent upstream` (mock records received headers)

`src/cli/keys.test.ts`:
- `create-key prints the key once and stores only its hash` (row contains no plaintext)
- `revoke-key by prefix revokes exactly one key`

## Acceptance proof

1. `docker compose up -d --wait`; `npm run db:migrate` → tables exist (`psql \d api_keys`).
2. `npm run keys -- create-tenant acme`; `npm run keys -- create-key acme` → prints `gw_…` once.
3. Gateway + mock running: curl with no key → 401; with the key → 200 (hop: `auth/plugin.ts` →
   `auth/key-store.ts` → Redis/Postgres → `routes/chat.ts`).
4. `npm run keys -- revoke-key <prefix>`; same curl → 401 immediately.
5. `bash scripts/gate.sh` → PASS.
6. Bench: PR 1's four scenarios re-run with auth on (`AUTH_CACHE=redis`), plus the realistic
   scenario with `AUTH_CACHE=none` (Postgres every request) to show what the cache buys.
   Results in `bench/results/pr-3/`; BENCHMARKS.md compares against `bench/results/pr-1/`.

## Adversarial

1. 10k requests with random invalid keys: Postgres sees each unknown hash at most once per
   negative TTL; gateway p95 for valid traffic alongside stays within 10% of the auth-on baseline.
2. Revoke during a 500 req/s run: zero 200s for that key after the revoke command returns.
3. Stop Redis mid-run: valid keys keep working (via Postgres), revoked keys stay rejected,
   gateway does not crash; restart Redis and it recovers without a restart of the gateway.
4. Search DB, logs and k6 output for any full `gw_` key: none.
5. Timing: response time for unknown vs revoked vs malformed keys is indistinguishable at p50.

## Data flows

- API key check → `docs/auth/api-key-check.html` → `packages/gateway/src/auth/{plugin.ts,key-store.ts}`
- API key management (CLI) → `docs/auth/api-key-check.html` → `packages/gateway/src/cli/keys.ts`

## Decisions

- **HMAC-SHA256 with a server pepper** (founder, D-011): keys are 256-bit random, so slow
  password hashing adds latency and no security; the pepper means a stolen DB alone cannot be
  used to check guessed keys. Lookup by hash means no plaintext comparison, so no timing attack
  on string compare.
- **Instant revocation via a Redis cache** (founder, D-012): Redis holds valid keys for 10 min,
  revocation writes a tombstone. One Redis round trip per request is the measured cost.
- **Drizzle ORM over node-postgres** (founder, D-013), migrations generated by drizzle-kit as
  plain SQL files and committed.
- **Redis client:** ioredis (BullMQ, a PR 10 candidate, uses it too).
- **`AUTH_CACHE=none`** exists only so the benchmark can show the Postgres-per-request cost;
  default `redis`.
- **Config rows** (zod, blank = unset; `.env.example` has dev values): `DATABASE_URL`,
  `DB_POOL_SIZE=20`, `REDIS_URL`, `API_KEY_PEPPER` (required, ≥ 32 chars, gateway refuses to
  start without it), `AUTH_CACHE=redis`, `AUTH_CACHE_TTL_S=600`, `AUTH_NEGATIVE_TTL_S=60`,
  `AUTH_TOMBSTONE_TTL_S=1200`.
- **Docs** per AGENT-BRIEF R2: `docs/auth/` with interview Qs incl. "why not bcrypt?", "why
  not Auth.js?" (it logs in humans to websites; this checks machines per request), "how is
  revocation instant without a race?", "what if Redis dies?".
