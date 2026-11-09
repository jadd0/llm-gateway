ALTER TABLE "spend_ledger" ADD COLUMN "cached" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "spend_ledger" ADD COLUMN "saved_micros" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "cache_shared" boolean DEFAULT false NOT NULL;