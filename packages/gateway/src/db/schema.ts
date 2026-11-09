import { bigint, bigserial, boolean, char, check, index, integer, pgTable, primaryKey, text, timestamp, unique, uuid, vector } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

export const tenants = pgTable('tenants', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull().unique(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  // Monthly spend cap in micro-USD (1 USD = 1,000,000). Null means the gateway-wide default
  // (BUDGET_DEFAULT_MONTHLY_USD).
  monthlyBudgetMicros: bigint('monthly_budget_micros', { mode: 'number' }),
  // True when the tenant reads and writes the shared response-cache pool instead of its own (keys set-cache-sharing).
  cacheShared: boolean('cache_shared').notNull().default(false),
  // False when the tenant wants exact-match caching only (keys set-semantic-cache).
  semanticCache: boolean('semantic_cache').notNull().default(true),
});

export const apiKeys = pgTable(
  'api_keys',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    // Hex HMAC-SHA256(pepper, full key). The key itself is never stored.
    keyHash: text('key_hash').notNull().unique(),
    // First 12 characters of the key: enough to recognise and revoke it, useless to use it.
    prefix: text('prefix').notNull(),
    name: text('name'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    // Per-minute limits for this key. Null means the gateway-wide default (RATE_LIMIT_DEFAULT_RPM / _TPM).
    rpmLimit: integer('rpm_limit'),
    tpmLimit: integer('tpm_limit'),
  },
  (t) => [index('api_keys_tenant_idx').on(t.tenantId)],
);

// Settled spend per tenant per UTC calendar month ('YYYY-MM'). The Redis balance is rebuilt from here.
export const tenantSpend = pgTable(
  'tenant_spend',
  {
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    period: char('period', { length: 7 }).notNull(),
    spentMicros: bigint('spent_micros', { mode: 'number' }).notNull().default(0),
    // How many charges have been added to spent_micros. Each charge is applied under this row's lock, so
    // the count orders the charges; the Redis balance uses it to tell which charges it already holds.
    charges: bigint('charges', { mode: 'number' }).notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.tenantId, t.period] })],
);

// One row per settled request. The primary key makes recording a settle idempotent.
export const spendLedger = pgTable(
  'spend_ledger',
  {
    requestId: uuid('request_id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    period: char('period', { length: 7 }).notNull(),
    model: text('model').notNull(),
    promptTokens: integer('prompt_tokens').notNull(),
    completionTokens: integer('completion_tokens').notNull(),
    costMicros: bigint('cost_micros', { mode: 'number' }).notNull(),
    // True when no usage was seen and the reserved estimate was charged instead.
    estimated: boolean('estimated').notNull(),
    // True for a response served from the cache: no provider work, cost_micros is 0.
    cached: boolean('cached').notNull().default(false),
    // For a cached row, what the same usage would have cost at the model that first served it.
    savedMicros: bigint('saved_micros', { mode: 'number' }).notNull().default(0),
    // For a cached row, which cache served it; null for a row that was not a hit.
    cacheKind: text('cache_kind'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  // The month's spend and savings are summed per tenant and period.
  (t) => [
    index('spend_ledger_tenant_period_idx').on(t.tenantId, t.period),
    check('spend_ledger_cache_kind_check', sql`${t.cacheKind} IN ('exact', 'semantic')`),
  ],
);

// Money held for in-flight requests: every hold, whichever store decided it. The Postgres path counts
// these, and a rebuilt Redis balance starts from them. An expiry lets a crashed gateway's hold lapse.
export const budgetReservations = pgTable(
  'budget_reservations',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    period: char('period', { length: 7 }).notNull(),
    amountMicros: bigint('amount_micros', { mode: 'number' }).notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    index('budget_reservations_tenant_period_idx').on(t.tenantId, t.period),
    // The sweep of lapsed holds finds them by expiry.
    index('budget_reservations_expires_idx').on(t.expiresAt),
  ],
);

// A single row. Redis balance keys include the epoch; it moves when an instance falls back to
// Postgres, so the Redis balance is rebuilt from Postgres instead of trusting one that missed spend.
export const budgetEpoch = pgTable(
  'budget_epoch',
  {
    id: integer('id').primaryKey(),
    epoch: bigint('epoch', { mode: 'number' }).notNull(),
  },
  (t) => [check('budget_epoch_single_row', sql`${t.id} = 1`)],
);

// The prompt of every cached answer, as a vector, so a differently worded question can find the answer. The
// answer itself stays in the response cache (Redis); `exact_key` names it. Scope and context hash decide who
// may be matched with whom (see semantic/context.ts); the vector only ranks the candidates inside them.
export const semanticCache = pgTable(
  'semantic_cache',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    // A tenant id, or 'shared' (the response cache's scope rule).
    scope: text('scope').notNull(),
    // Everything about the request except its last user message.
    contextHash: char('context_hash', { length: 64 }).notNull(),
    // The response-cache key holding the answer.
    exactKey: text('exact_key').notNull(),
    // L2-normalised, SEMANTIC_DIMENSIONS long.
    embedding: vector('embedding', { dimensions: 1024 }).notNull(),
    // Which model made the vector: 'voyage-4-lite' or 'voyage-4-nano'.
    embedder: text('embedder').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    unique('semantic_cache_scope_exact_key_unique').on(t.scope, t.exactKey),
    index('semantic_cache_scope_context_idx').on(t.scope, t.contextHash),
    // The expiry sweep finds rows by expiry.
    index('semantic_cache_expires_idx').on(t.expiresAt),
    // HNSW provisionally; docs/semantic-cache/README.md has the index bench that decides.
    index('semantic_cache_embedding_idx').using('hnsw', t.embedding.op('vector_cosine_ops')),
  ],
);
