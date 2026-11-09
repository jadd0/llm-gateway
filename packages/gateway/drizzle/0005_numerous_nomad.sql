CREATE TABLE "request_log" (
	"request_id" uuid PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"tenant_id" uuid,
	"key_id" uuid,
	"model" text,
	"served_model" text,
	"provider" text,
	"status" smallint NOT NULL,
	"error_code" text,
	"stream" boolean NOT NULL,
	"prompt_tokens" integer,
	"completion_tokens" integer,
	"cost_micros" bigint DEFAULT 0 NOT NULL,
	"saved_micros" bigint DEFAULT 0 NOT NULL,
	"cache" text,
	"attempts" smallint DEFAULT 0 NOT NULL,
	"fallback_used" boolean DEFAULT false NOT NULL,
	"latency_ms" integer NOT NULL,
	"ttfb_ms" integer,
	"upstream_ms" integer
);
--> statement-breakpoint
CREATE INDEX "request_log_created_brin" ON "request_log" USING brin ("created_at");--> statement-breakpoint
CREATE INDEX "request_log_tenant_time" ON "request_log" USING btree ("tenant_id","created_at");