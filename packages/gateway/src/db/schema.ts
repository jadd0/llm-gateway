import { bigint, boolean, char, check, index, integer, pgTable, primaryKey, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

export const tenants = pgTable('tenants', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull().unique(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  // Monthly spend cap in micro-USD (1 USD = 1,000,000). Null means the gateway-wide default
  // (BUDGET_DEFAULT_MONTHLY_USD).
  monthlyBudgetMicros: bigint('monthly_budget_micros', { mode: 'number' }),
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
  },
  (t) => [primaryKey({ columns: [t.tenantId, t.period] })],
);

// One row per settled request. The primary key makes recording a settle idempotent.
export const spendLedger = pgTable('spend_ledger', {
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
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

// Money held for in-flight requests. Used only on the Postgres path (Redis down); an expiry lets a
// crashed gateway's hold lapse.
export const budgetReservations = pgTable('budget_reservations', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  period: char('period', { length: 7 }).notNull(),
  amountMicros: bigint('amount_micros', { mode: 'number' }).notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
});

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
