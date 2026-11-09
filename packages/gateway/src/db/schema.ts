import { bigint, boolean, char, check, index, integer, pgTable, primaryKey, smallint, text, timestamp, uuid } from 'drizzle-orm/pg-core';
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
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  // The month's spend and savings are summed per tenant and period.
  (t) => [index('spend_ledger_tenant_period_idx').on(t.tenantId, t.period)],
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
    // True once the request was refused: the hold is not going to be used, so it counts against no cap and the
    // sweeper deletes it rather than charging its estimate. Set when dropping the row failed.
    refused: boolean('refused').notNull().default(false),
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

// One row per request, whatever its outcome: who, which model, tokens, cost, timing, cache, fallback. Metadata
// only; no prompt, completion, header or key is ever stored. Written by the log worker from the Redis stream,
// so a redelivered entry is a no-op on the primary key. The ids are not foreign keys: a log row outlives
// the tenant or key it names, and a failed lookup (null tenant) is itself a row.
export const requestLog = pgTable(
  'request_log',
  {
    requestId: uuid('request_id').primaryKey(),
    // Request start by the gateway's clock.
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    tenantId: uuid('tenant_id'),
    keyId: uuid('key_id'),
    model: text('model'),
    servedModel: text('served_model'),
    provider: text('provider'),
    status: smallint('status').notNull(),
    errorCode: text('error_code'),
    stream: boolean('stream').notNull(),
    promptTokens: integer('prompt_tokens'),
    completionTokens: integer('completion_tokens'),
    costMicros: bigint('cost_micros', { mode: 'number' }).notNull().default(0),
    savedMicros: bigint('saved_micros', { mode: 'number' }).notNull().default(0),
    // hit | miss | bypass | uncacheable | unavailable | refresh; null when the cache was not consulted.
    cache: text('cache'),
    attempts: smallint('attempts').notNull().default(0),
    fallbackUsed: boolean('fallback_used').notNull().default(false),
    // Gateway in to last byte out.
    latencyMs: integer('latency_ms').notNull(),
    ttfbMs: integer('ttfb_ms'),
    // Sum of the upstream attempt times.
    upstreamMs: integer('upstream_ms'),
  },
  (t) => [
    // Time-ordered appends: a block-range index stays tiny and answers time-window scans.
    index('request_log_created_brin').using('brin', t.createdAt),
    index('request_log_tenant_time').on(t.tenantId, t.createdAt),
    // The dashboard's "last errors" table reads the newest failures; this partial index keeps that read flat
    // however large the log grows. Its predicate is the one the rollups count errors by (see isError).
    index('request_log_errors_recent')
      .on(t.createdAt.desc())
      .where(sql`${t.status} >= 500 OR ${t.errorCode} = 'upstream_stream_broken'`),
  ],
);

/**
 * What counts as an error everywhere (rollups, the last-errors table, the partial index above): a 5xx, or a stream
 * that broke after a 200 was already sent. A client that left (499, client_closed) and refusals (4xx) are not errors.
 */
export const ERROR_STATUS_MIN = 500;
export const STREAM_BROKEN_CODE = 'upstream_stream_broken';
export const isError = (status: number, errorCode: string | null): boolean => status >= ERROR_STATUS_MIN || errorCode === STREAM_BROKEN_CODE;

/** The tenant of a request that never authenticated, so rollup keys need no null. */
export const NO_TENANT = '00000000-0000-0000-0000-000000000000';

// Pre-aggregated request-log counts per (time bucket, tenant, model), written by the log worker in the same
// transaction as the log rows they summarise. The dashboard reads only these. `rollup_minute` holds recent
// minutes, `rollup_hour` all history. Latency is a histogram (counts per fixed log-scale bucket), never a
// percentile, so any range can be merged exactly.
const rollupColumns = () => ({
  bucket: timestamp('bucket', { withTimezone: true }).notNull(),
  tenantId: uuid('tenant_id').notNull(),
  model: text('model').notNull().default(''),
  requests: integer('requests').notNull(),
  errors: integer('errors').notNull(),
  cacheHits: integer('cache_hits').notNull(),
  semanticHits: integer('semantic_hits').notNull(),
  costMicros: bigint('cost_micros', { mode: 'number' }).notNull(),
  savedMicros: bigint('saved_micros', { mode: 'number' }).notNull(),
  promptTokens: bigint('prompt_tokens', { mode: 'number' }).notNull(),
  completionTokens: bigint('completion_tokens', { mode: 'number' }).notNull(),
  latencyHist: integer('latency_hist').array().notNull(),
});

export const rollupMinute = pgTable('rollup_minute', rollupColumns(), (t) => [primaryKey({ columns: [t.bucket, t.tenantId, t.model] })]);
export const rollupHour = pgTable('rollup_hour', rollupColumns(), (t) => [primaryKey({ columns: [t.bucket, t.tenantId, t.model] })]);

// One row. Minutes before `folded_through` are in rollup_hour and no longer written to rollup_minute: a batch
// holding a row older than the mark adds it to the hour directly. The fold moves the mark forward under a row
// lock that every batch takes shared, so a minute is counted in exactly one table.
export const rollupState = pgTable(
  'rollup_state',
  {
    id: integer('id').primaryKey(),
    foldedThrough: timestamp('folded_through', { withTimezone: true }).notNull(),
  },
  (t) => [check('rollup_state_single_row', sql`${t.id} = 1`)],
);
