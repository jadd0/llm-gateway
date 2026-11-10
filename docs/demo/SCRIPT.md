# Demo script: 60 seconds

For the founder to record. One screen: a terminal split in two (left: gateway log, right: a shell for `curl`), the
dashboard in a browser tab for the last shot. No voiceover is required; the captions below are the on-screen text.
After recording, link the video from the "Demo video" line in the top-level [README](../../README.md).

## Before recording (not on camera)

Redis and Postgres up and migrated (see the README quick start), then two mocks and the log worker started in a hidden terminal:

```
docker compose up -d --wait redis postgres
npm run db:migrate
npm run dev:mock &                          # primary mock on :9000
MOCK_PORT=9001 npm run dev:mock &           # fallback mock on :9001
npm run worker &
```

Three tenants and their keys. `create-key` prints a line of text and then the key, once, so keep only the last line:

```
npm run keys -- create-tenant demo
export KEY=$(npm run --silent keys -- create-key demo main | tail -1)
npm run keys -- create-tenant tight
npm run keys -- set-budget tight --monthly-usd 0.001
export TIGHT=$(npm run --silent keys -- create-key tight | tail -1)
npm run keys -- create-tenant slow
export SLOW=$(npm run --silent keys -- create-key slow limited --rpm 2 | tail -1)
```

The dashboard, in its own terminal and a browser tab already logged in at `http://localhost:3200`
(set `DASHBOARD_TOKEN` and `DASHBOARD_SESSION_SECRET`, each at least 32 characters, and `DASHBOARD_DATABASE_URL` in `.env.local` first;
see [../dashboard/README.md](../dashboard/README.md), then run `npm run db:migrate` again so the read-only login exists):

```
npm run dashboard
```

The gateway is the one process started on camera, with the fallback chain turned on:

```
MOCK_ANTHROPIC_BASE_URL=http://127.0.0.1:9001 MODEL_FALLBACKS='mock-openai-1>mock-anthropic-1' npm run dev:gateway
```

Send one warm-up request and clear the terminal before recording, so the first shot is not a cold start.

## Shots

| Time | Shot | Command (right pane) | On screen |
|---|---|---|---|
| 0:00 to 0:05 | Title card or the README architecture image | none | "One OpenAI-compatible endpoint. Limits, budgets, failover, caching." |
| 0:05 to 0:14 | A streamed answer | `curl -N localhost:8080/v1/chat/completions -H 'content-type: application/json' -H "authorization: Bearer $KEY" -d '{"model":"mock-openai-1","stream":true,"messages":[{"role":"user","content":"hi"}]}'` | The chunks arrive one by one and end with `data: [DONE]` |
| 0:14 to 0:22 | The `x-gateway-*` headers and a cache hit | Run twice: `curl -si localhost:8080/v1/chat/completions -H 'content-type: application/json' -H "authorization: Bearer $KEY" -d '{"model":"mock-openai-1","temperature":0,"messages":[{"role":"user","content":"hello"}]}' \| grep -iE '^(HTTP\|x-gateway\|x-budget)'` | First run `x-gateway-cache: miss`, about 200 ms. Second run `x-gateway-cache: hit`, `x-gateway-attempts: 0`, instant |
| 0:22 to 0:28 | A 429 | Three times: `curl -si localhost:8080/v1/chat/completions -H 'content-type: application/json' -H "authorization: Bearer $SLOW" -d '{"model":"mock-openai-1","messages":[{"role":"user","content":"hi"}]}' \| head -1` | `HTTP/1.1 200`, `200`, then `429` (the key's limit is 2 requests a minute) |
| 0:28 to 0:34 | A 402 | `curl -s localhost:8080/v1/chat/completions -H 'content-type: application/json' -H "authorization: Bearer $TIGHT" -d '{"model":"mock-openai-1","messages":[{"role":"user","content":"hi"}]}'` | A 402 body: the tenant's budget (0.001 USD) cannot cover the worst case of the call |
| 0:34 to 0:48 | Failover | Start a request loop in the right pane: `while true; do curl -s -o /dev/null -w '%{http_code} ' localhost:8080/v1/chat/completions -H 'content-type: application/json' -H "authorization: Bearer $KEY" -d '{"model":"mock-openai-1","messages":[{"role":"user","content":"hi '$RANDOM'"}]}'; done`. In the hidden terminal kill the primary: `lsof -ti :9000 \| xargs kill`. Stop the loop with Ctrl-C | A row of `200`s that never turns into errors while the primary dies; add `-D -` and `grep x-gateway-model` once to show `mock-anthropic-1` answering |
| 0:48 to 0:58 | The dashboard | Switch to the browser tab, refresh, pick "1 hour" | Latency, spend by tenant, cache hit rate and error rate, with the traffic just generated |
| 0:58 to 1:00 | End card | none | The repo URL and "measured on one laptop: see BENCHMARKS.md" |

## Notes for the take

- The random number in the loop's prompt keeps every request a cache miss so each one reaches a provider.
- After killing the primary, the first few requests take about 1 second while the breaker counts failures, then answers come straight from the fallback
  ([../resilience/README.md](../resilience/README.md)). That pause is real; do not cut it.
- The dashboard reads rollups the log worker writes with each batch, so the traffic from the last few seconds appears after the worker's next batch (up to a second).
- Restart the primary afterwards (`npm run dev:mock &`) before a second take.
