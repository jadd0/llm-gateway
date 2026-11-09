CREATE EXTENSION IF NOT EXISTS vector;--> statement-breakpoint
CREATE TABLE "semantic_cache" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"scope" text NOT NULL,
	"context_hash" char(64) NOT NULL,
	"exact_key" text NOT NULL,
	"embedding" vector(1024) NOT NULL,
	"embedder" text NOT NULL,
	"guard_sig" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "semantic_cache_scope_exact_key_unique" UNIQUE("scope","exact_key")
);
--> statement-breakpoint
ALTER TABLE "spend_ledger" ADD COLUMN "cache_kind" text;--> statement-breakpoint
UPDATE "spend_ledger" SET "cache_kind" = 'exact' WHERE "cached";--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "semantic_cache" boolean DEFAULT false NOT NULL;--> statement-breakpoint
CREATE INDEX "semantic_cache_scope_context_idx" ON "semantic_cache" USING btree ("scope","context_hash");--> statement-breakpoint
CREATE INDEX "semantic_cache_expires_idx" ON "semantic_cache" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "semantic_cache_embedding_idx" ON "semantic_cache" USING hnsw ("embedding" vector_cosine_ops);--> statement-breakpoint
ALTER TABLE "spend_ledger" ADD CONSTRAINT "spend_ledger_cache_kind_check" CHECK ("spend_ledger"."cache_kind" IN ('exact', 'semantic'));
--> statement-breakpoint
CREATE FUNCTION "semantic_nearest"(p_scope text, p_context_hash char(64), p_embedding vector, p_embedder text, p_now timestamptz, p_exact_max integer, p_iterative boolean)
RETURNS TABLE ("id" bigint, "exact_key" text, "embedder" text, "guard_sig" jsonb, "distance" double precision)
LANGUAGE plpgsql AS $fn$
#variable_conflict use_column
DECLARE
	n integer;
BEGIN
	-- The whole lookup is this one statement for the caller, so a statement timeout ends all of it at once.
	-- First count (up to exact_max + 1 rows) what may be served; distances are computed only on the path chosen.
	SELECT count(*) INTO n FROM (
		SELECT 1 FROM semantic_cache c
		WHERE c.scope = p_scope AND c.context_hash = p_context_hash AND c.expires_at > p_now AND (p_embedder IS NULL OR c.embedder = p_embedder)
		LIMIT p_exact_max + 1
	) probe;
	IF n <= p_exact_max THEN
		-- Few rows: rank them exactly, without the vector index (an index scan filters after it searches and can
		-- give up before reaching the few rows that qualify).
		RETURN QUERY
		SELECT c.id, c.exact_key, c.embedder, c.guard_sig, (c.embedding <=> p_embedding)::double precision AS distance
		FROM (
			SELECT s.id, s.exact_key, s.embedder, s.guard_sig, s.embedding FROM semantic_cache s
			WHERE s.scope = p_scope AND s.context_hash = p_context_hash AND s.expires_at > p_now AND (p_embedder IS NULL OR s.embedder = p_embedder)
			LIMIT p_exact_max + 1
		) c
		ORDER BY distance LIMIT 1;
	ELSE
		-- Many rows: the vector index. From pgvector 0.8 its scan continues until the filtered query has its row
		-- (strict_order keeps the order exact); before that the index is switched off for this statement and
		-- Postgres reads the filtered set and sorts it, which is exact.
		IF p_iterative THEN
			PERFORM set_config('hnsw.iterative_scan', 'strict_order', true), set_config('hnsw.max_scan_tuples', '1000000', true);
		ELSE
			PERFORM set_config('enable_indexscan', 'off', true);
		END IF;
		RETURN QUERY
		SELECT c.id, c.exact_key, c.embedder, c.guard_sig, (c.embedding <=> p_embedding)::double precision AS distance
		FROM semantic_cache c
		WHERE c.scope = p_scope AND c.context_hash = p_context_hash AND c.expires_at > p_now AND (p_embedder IS NULL OR c.embedder = p_embedder)
		ORDER BY c.embedding <=> p_embedding LIMIT 1;
	END IF;
END
$fn$;
