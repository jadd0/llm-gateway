CREATE EXTENSION IF NOT EXISTS vector;--> statement-breakpoint
CREATE TABLE "semantic_cache" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"scope" text NOT NULL,
	"context_hash" char(64) NOT NULL,
	"exact_key" text NOT NULL,
	"embedding" vector(1024) NOT NULL,
	"embedder" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "semantic_cache_scope_exact_key_unique" UNIQUE("scope","exact_key")
);
--> statement-breakpoint
ALTER TABLE "spend_ledger" ADD COLUMN "cache_kind" text;--> statement-breakpoint
UPDATE "spend_ledger" SET "cache_kind" = 'exact' WHERE "cached";--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "semantic_cache" boolean DEFAULT true NOT NULL;--> statement-breakpoint
CREATE INDEX "semantic_cache_scope_context_idx" ON "semantic_cache" USING btree ("scope","context_hash");--> statement-breakpoint
CREATE INDEX "semantic_cache_expires_idx" ON "semantic_cache" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "semantic_cache_embedding_idx" ON "semantic_cache" USING hnsw ("embedding" vector_cosine_ops);--> statement-breakpoint
ALTER TABLE "spend_ledger" ADD CONSTRAINT "spend_ledger_cache_kind_check" CHECK ("spend_ledger"."cache_kind" IN ('exact', 'semantic'));