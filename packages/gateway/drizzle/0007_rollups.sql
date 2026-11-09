CREATE TABLE "rollup_hour" (
	"bucket" timestamp with time zone NOT NULL,
	"tenant_id" uuid NOT NULL,
	"model" text DEFAULT '' NOT NULL,
	"requests" integer NOT NULL,
	"errors" integer NOT NULL,
	"cache_hits" integer NOT NULL,
	"semantic_hits" integer NOT NULL,
	"cost_micros" bigint NOT NULL,
	"saved_micros" bigint NOT NULL,
	"prompt_tokens" bigint NOT NULL,
	"completion_tokens" bigint NOT NULL,
	"latency_hist" integer[] NOT NULL,
	CONSTRAINT "rollup_hour_bucket_tenant_id_model_pk" PRIMARY KEY("bucket","tenant_id","model")
);
--> statement-breakpoint
CREATE TABLE "rollup_minute" (
	"bucket" timestamp with time zone NOT NULL,
	"tenant_id" uuid NOT NULL,
	"model" text DEFAULT '' NOT NULL,
	"requests" integer NOT NULL,
	"errors" integer NOT NULL,
	"cache_hits" integer NOT NULL,
	"semantic_hits" integer NOT NULL,
	"cost_micros" bigint NOT NULL,
	"saved_micros" bigint NOT NULL,
	"prompt_tokens" bigint NOT NULL,
	"completion_tokens" bigint NOT NULL,
	"latency_hist" integer[] NOT NULL,
	CONSTRAINT "rollup_minute_bucket_tenant_id_model_pk" PRIMARY KEY("bucket","tenant_id","model")
);
--> statement-breakpoint
CREATE TABLE "rollup_state" (
	"id" integer PRIMARY KEY NOT NULL,
	"folded_through" timestamp with time zone NOT NULL,
	CONSTRAINT "rollup_state_single_row" CHECK ("rollup_state"."id" = 1)
);
--> statement-breakpoint
CREATE INDEX "request_log_errors_recent" ON "request_log" USING btree ("created_at" DESC NULLS LAST) WHERE "request_log"."status" >= 500;
--> statement-breakpoint
-- Hand-written (drizzle-kit does not emit functions, roles or grants).
-- Element-wise sum of two histograms; the shorter one counts as zeros.
CREATE FUNCTION hist_add(a integer[], b integer[]) RETURNS integer[]
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT coalesce(array_agg(coalesce(a[i], 0) + coalesce(b[i], 0) ORDER BY i), '{}'::integer[])
  FROM generate_series(1, greatest(coalesce(array_length(a, 1), 0), coalesce(array_length(b, 1), 0))) AS i
$$;
--> statement-breakpoint
CREATE AGGREGATE hist_sum(integer[]) (SFUNC = hist_add, STYPE = integer[], INITCOND = '{}');
--> statement-breakpoint
INSERT INTO "rollup_state" ("id", "folded_through") VALUES (1, 'epoch');
--> statement-breakpoint
-- The dashboard's role. Roles belong to the cluster, not the database, so it is created only once; the grants are per database.
DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'dashboard_reader') THEN
    CREATE ROLE dashboard_reader NOLOGIN;
  END IF;
END $$;
--> statement-breakpoint
GRANT SELECT ON "rollup_minute", "rollup_hour", "rollup_state" TO dashboard_reader;
--> statement-breakpoint
GRANT SELECT ("id", "name") ON "tenants" TO dashboard_reader;
--> statement-breakpoint
-- Metadata of a request, for the last-errors table: no key id, no token counts, no cost, no cache or provider detail.
GRANT SELECT ("request_id", "created_at", "tenant_id", "model", "status", "error_code", "latency_ms") ON "request_log" TO dashboard_reader;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION hist_add(integer[], integer[]) TO dashboard_reader;
