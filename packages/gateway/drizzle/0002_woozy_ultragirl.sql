CREATE TABLE "budget_epoch" (
	"id" integer PRIMARY KEY NOT NULL,
	"epoch" bigint NOT NULL,
	CONSTRAINT "budget_epoch_single_row" CHECK ("budget_epoch"."id" = 1)
);
--> statement-breakpoint
CREATE TABLE "budget_reservations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"period" char(7) NOT NULL,
	"amount_micros" bigint NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "spend_ledger" (
	"request_id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"period" char(7) NOT NULL,
	"model" text NOT NULL,
	"prompt_tokens" integer NOT NULL,
	"completion_tokens" integer NOT NULL,
	"cost_micros" bigint NOT NULL,
	"estimated" boolean NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tenant_spend" (
	"tenant_id" uuid NOT NULL,
	"period" char(7) NOT NULL,
	"spent_micros" bigint DEFAULT 0 NOT NULL,
	"charges" bigint DEFAULT 0 NOT NULL,
	CONSTRAINT "tenant_spend_tenant_id_period_pk" PRIMARY KEY("tenant_id","period")
);
--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "monthly_budget_micros" bigint;--> statement-breakpoint
ALTER TABLE "budget_reservations" ADD CONSTRAINT "budget_reservations_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "spend_ledger" ADD CONSTRAINT "spend_ledger_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenant_spend" ADD CONSTRAINT "tenant_spend_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "budget_reservations_tenant_period_idx" ON "budget_reservations" USING btree ("tenant_id","period");--> statement-breakpoint
CREATE INDEX "budget_reservations_expires_idx" ON "budget_reservations" USING btree ("expires_at");