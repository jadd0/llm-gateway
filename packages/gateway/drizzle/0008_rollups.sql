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
CREATE TABLE "rollup_total_hour" (
	"bucket" timestamp with time zone NOT NULL,
	"requests" integer NOT NULL,
	"errors" integer NOT NULL,
	"cache_hits" integer NOT NULL,
	"semantic_hits" integer NOT NULL,
	"cost_micros" bigint NOT NULL,
	"saved_micros" bigint NOT NULL,
	"prompt_tokens" bigint NOT NULL,
	"completion_tokens" bigint NOT NULL,
	"latency_hist" integer[] NOT NULL,
	CONSTRAINT "rollup_total_hour_bucket_pk" PRIMARY KEY("bucket")
);
--> statement-breakpoint
CREATE TABLE "rollup_total_minute" (
	"bucket" timestamp with time zone NOT NULL,
	"requests" integer NOT NULL,
	"errors" integer NOT NULL,
	"cache_hits" integer NOT NULL,
	"semantic_hits" integer NOT NULL,
	"cost_micros" bigint NOT NULL,
	"saved_micros" bigint NOT NULL,
	"prompt_tokens" bigint NOT NULL,
	"completion_tokens" bigint NOT NULL,
	"latency_hist" integer[] NOT NULL,
	CONSTRAINT "rollup_total_minute_bucket_pk" PRIMARY KEY("bucket")
);
--> statement-breakpoint
CREATE INDEX "request_log_errors_recent" ON "request_log" USING btree ("created_at" DESC NULLS LAST) WHERE "request_log"."status" >= 500 OR "request_log"."error_code" = 'upstream_stream_broken';
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
GRANT SELECT ON "rollup_minute", "rollup_hour", "rollup_total_minute", "rollup_total_hour", "rollup_state" TO dashboard_reader;
--> statement-breakpoint
GRANT SELECT ("id", "name") ON "tenants" TO dashboard_reader;
--> statement-breakpoint
-- Metadata of a request, for the last-errors table: no key id, no token counts, no cost, no cache or provider detail.
GRANT SELECT ("request_id", "created_at", "tenant_id", "model", "status", "error_code", "latency_ms") ON "request_log" TO dashboard_reader;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION hist_add(integer[], integer[]) TO dashboard_reader;

--> statement-breakpoint
-- Backfill. Log rows that existed before this migration have no rollups. The fold mark is set where a running worker
-- would have it (the last whole hour that ended 90 minutes ago, ROLLUP_FOLD_AFTER_MIN's default); rows before it go to the
-- hour tables, rows from a day before it on also to the minute tables (what the worker does with a late row), in step with
-- what the worker writes from now on. Latency buckets are the worker's (histogram.ts BOUNDS, 241 bounds and an open-ended
-- bucket): width_bucket counts the bounds at or below its operand, and a bound is the largest latency its bucket holds, so a
-- hair is taken off the latency to count the bounds strictly below it.
UPDATE "rollup_state" SET "folded_through" = date_trunc('hour', now() - interval '90 minutes', 'UTC') WHERE "id" = 1;
--> statement-breakpoint
CREATE TEMPORARY TABLE rollup_backfill AS
SELECT created_at, coalesce(tenant_id, '00000000-0000-0000-0000-000000000000'::uuid) AS tenant_id, coalesce(served_model, model, '') AS model,
       coalesce(status >= 500 OR error_code = 'upstream_stream_broken', false)::integer AS err, coalesce(cache = 'hit', false)::integer AS hit, coalesce(cache = 'semantic-hit', false)::integer AS sem,
       cost_micros, saved_micros, coalesce(prompt_tokens, 0)::bigint AS prompt, coalesce(completion_tokens, 0)::bigint AS completion,
       width_bucket(latency_ms::float8 - 1e-9, ARRAY[1.0, 1.05, 1.1025, 1.1576250000000001, 1.2155062500000002, 1.2762815625000004, 1.3400956406250004, 1.4071004226562505, 1.477455443789063, 1.5513282159785162, 1.628894626777442, 1.7103393581163142, 1.79585632602213, 1.8856491423232367, 1.9799315994393987, 2.0789281794113688, 2.1828745883819374, 2.2920183178010345, 2.406619233691086, 2.5269501953756404, 2.6532977051444226, 2.785962590401644, 2.9252607199217264, 3.071523755917813, 3.225099943713704, 3.386354940899389, 3.5556726879443583, 3.7334563223415764, 3.9201291384586554, 4.116135595381588, 4.321942375150668, 4.538039493908202, 4.764941468603612, 5.003188542033793, 5.253347969135483, 5.516015367592257, 5.791816135971871, 6.081406942770465, 6.385477289908988, 6.704751154404438, 7.03998871212466, 7.391988147730893, 7.761587555117438, 8.149666932873311, 8.557150279516977, 8.985007793492827, 9.434258183167469, 9.905971092325842, 10.401269646942135, 10.921333129289241, 11.467399785753704, 12.04076977504139, 12.64280826379346, 13.274948676983135, 13.938696110832291, 14.635630916373906, 15.367412462192602, 16.135783085302233, 16.942572239567344, 17.78970085154571, 18.679185894123, 19.613145188829147, 20.593802448270605, 21.623492570684135, 22.704667199218342, 23.83990055917926, 25.031895587138223, 26.283490366495137, 27.597664884819896, 28.977548129060892, 30.42642553551394, 31.947746812289637, 33.54513415290412, 35.222390860549325, 36.983510403576794, 38.83268592375563, 40.77432021994342, 42.81303623094059, 44.95368804248762, 47.201372444612005, 49.561441066842605, 52.039513120184736, 54.641488776193974, 57.37356321500368, 60.24224137575386, 63.25435344454156, 66.41707111676864, 69.73792467260708, 73.22482090623744, 76.88606195154931, 80.73036504912677, 84.76688330158312, 89.00522746666228, 93.4554888399954, 98.12826328199517, 103.03467644609493, 108.18641026839968, 113.59573078181967, 119.27551732091065, 125.23929318695619, 131.50125784630401, 138.07632073861922, 144.9801367755502, 152.2291436143277, 159.8406007950441, 167.83263083479633, 176.22426237653616, 185.035475495363, 194.28724927013116, 204.00161173363773, 214.20169232031964, 224.91177693633563, 236.15736578315241, 247.96523407231004, 260.36349577592557, 273.38167056472184, 287.05075409295796, 301.40329179760585, 316.4734563874861, 332.29712920686046, 348.9119856672035, 366.3575849505637, 384.6754641980919, 403.9092374079965, 424.10469927839637, 445.3099342423162, 467.575430954432, 490.95420250215363, 515.5019126272614, 541.2770082586245, 568.3408586715558, 596.7579016051336, 626.5957966853903, 657.9255865196598, 690.8218658456428, 725.362959137925, 761.6311070948213, 799.7126624495625, 839.6982955720406, 881.6832103506426, 925.7673708681748, 972.0557394115835, 1020.6585263821628, 1071.691452701271, 1125.2760253363344, 1181.5398266031511, 1240.6168179333088, 1302.6476588299743, 1367.780041771473, 1436.1690438600467, 1507.9774960530492, 1583.3763708557017, 1662.5451893984869, 1745.6724488684113, 1832.956071311832, 1924.6038748774236, 2020.8340686212948, 2121.8757720523595, 2227.9695606549776, 2339.3680386877268, 2456.336440622113, 2579.153262653219, 2708.1109257858798, 2843.516472075174, 2985.692295678933, 3134.97691046288, 3291.725755986024, 3456.3120437853254, 3629.127645974592, 3810.5840282733216, 4001.113229686988, 4201.168891171337, 4411.227335729905, 4631.7887025164, 4863.37813764222, 5106.547044524332, 5361.874396750549, 5629.968116588077, 5911.4665224174805, 6207.039848538355, 6517.391840965272, 6843.261433013537, 7185.424504664214, 7544.695729897425, 7921.930516392296, 8318.027042211912, 8733.928394322507, 9170.624814038632, 9629.156054740564, 10110.613857477592, 10616.144550351471, 11146.951777869046, 11704.2993667625, 12289.514335100625, 12903.990051855657, 13549.18955444844, 14226.649032170862, 14937.981483779406, 15684.880557968376, 16469.124585866793, 17292.580815160134, 18157.209855918143, 19065.070348714053, 20018.323866149756, 21019.240059457246, 22070.20206243011, 23173.712165551617, 24332.397773829198, 25549.01766252066, 26826.468545646694, 28167.79197292903, 29576.181571575482, 31054.990650154257, 32607.74018266197, 34238.12719179507, 35950.033551384826, 37747.53522895407, 39634.91199040177, 41616.65758992186, 43697.49046941796, 45882.364992888855, 48176.4832425333, 50585.307404659965, 53114.572774892964, 55770.301413637615, 58558.8164843195, 61486.757308535474, 64561.095173962254, 67789.14993266037, 71178.60742929339, 74737.53780075806, 78474.41469079597, 82398.13542533577, 86518.04219660256, 90843.94430643269, 95386.14152175433, 100155.44859784204, 105163.22102773415, 110421.38207912086, 115942.4511830769, 121739.57374223076]::float8[]) AS idx
FROM request_log;
--> statement-breakpoint
INSERT INTO rollup_hour (bucket, tenant_id, model, requests, errors, cache_hits, semantic_hits, cost_micros, saved_micros, prompt_tokens, completion_tokens, latency_hist)
SELECT bucket, tenant_id, model, sum(c)::integer, sum(e)::integer, sum(h)::integer, sum(s)::integer, sum(cost), sum(saved), sum(p), sum(co), hist_sum(array_fill(0, ARRAY[idx]) || c)
FROM (SELECT date_trunc('hour', created_at, 'UTC') AS bucket, tenant_id, model, idx, count(*)::integer AS c, sum(err)::integer AS e, sum(hit)::integer AS h, sum(sem)::integer AS s, sum(cost_micros) AS cost, sum(saved_micros) AS saved, sum(prompt) AS p, sum(completion) AS co FROM rollup_backfill WHERE created_at < (SELECT folded_through FROM rollup_state WHERE id = 1) GROUP BY 1, 2, 3, 4) g
GROUP BY 1, 2, 3;
--> statement-breakpoint
INSERT INTO rollup_total_hour (bucket, requests, errors, cache_hits, semantic_hits, cost_micros, saved_micros, prompt_tokens, completion_tokens, latency_hist)
SELECT bucket, sum(c)::integer, sum(e)::integer, sum(h)::integer, sum(s)::integer, sum(cost), sum(saved), sum(p), sum(co), hist_sum(array_fill(0, ARRAY[idx]) || c)
FROM (SELECT date_trunc('hour', created_at, 'UTC') AS bucket, idx, count(*)::integer AS c, sum(err)::integer AS e, sum(hit)::integer AS h, sum(sem)::integer AS s, sum(cost_micros) AS cost, sum(saved_micros) AS saved, sum(prompt) AS p, sum(completion) AS co FROM rollup_backfill WHERE created_at < (SELECT folded_through FROM rollup_state WHERE id = 1) GROUP BY 1, 2) g
GROUP BY 1;
--> statement-breakpoint
INSERT INTO rollup_minute (bucket, tenant_id, model, requests, errors, cache_hits, semantic_hits, cost_micros, saved_micros, prompt_tokens, completion_tokens, latency_hist)
SELECT bucket, tenant_id, model, sum(c)::integer, sum(e)::integer, sum(h)::integer, sum(s)::integer, sum(cost), sum(saved), sum(p), sum(co), hist_sum(array_fill(0, ARRAY[idx]) || c)
FROM (SELECT date_trunc('minute', created_at, 'UTC') AS bucket, tenant_id, model, idx, count(*)::integer AS c, sum(err)::integer AS e, sum(hit)::integer AS h, sum(sem)::integer AS s, sum(cost_micros) AS cost, sum(saved_micros) AS saved, sum(prompt) AS p, sum(completion) AS co FROM rollup_backfill WHERE created_at >= (SELECT folded_through FROM rollup_state WHERE id = 1) - interval '24 hours' GROUP BY 1, 2, 3, 4) g
GROUP BY 1, 2, 3;
--> statement-breakpoint
INSERT INTO rollup_total_minute (bucket, requests, errors, cache_hits, semantic_hits, cost_micros, saved_micros, prompt_tokens, completion_tokens, latency_hist)
SELECT bucket, sum(c)::integer, sum(e)::integer, sum(h)::integer, sum(s)::integer, sum(cost), sum(saved), sum(p), sum(co), hist_sum(array_fill(0, ARRAY[idx]) || c)
FROM (SELECT date_trunc('minute', created_at, 'UTC') AS bucket, idx, count(*)::integer AS c, sum(err)::integer AS e, sum(hit)::integer AS h, sum(sem)::integer AS s, sum(cost_micros) AS cost, sum(saved_micros) AS saved, sum(prompt) AS p, sum(completion) AS co FROM rollup_backfill WHERE created_at >= (SELECT folded_through FROM rollup_state WHERE id = 1) - interval '24 hours' GROUP BY 1, 2) g
GROUP BY 1;
--> statement-breakpoint
DROP TABLE rollup_backfill;
