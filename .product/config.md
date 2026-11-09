<!-- product-kit config.md v1 — from umbo 0f95e4fa -->
# Product loop config — llm-gateway

Read by `/product` (`~/.claude/skills/product/SKILL.md`), the `coordinator` agent and every kit
script. One schema in every repo: change values, never key names. A value ends at the first
` (` or ` #`, so a short reason may follow it. History belongs in git and DECISIONS.md, not here.

## Source of truth

- Queue: `.product/roadmap.md` (`queue_doc` below). One `## PR <id> — title` block per PR, with
  `status:`, `acceptance:`, `scope_notes:`, `base_branch:`, `commit:`, `completed_at:`, `notes:`.
- Spec: `.product/build-plan.md` if the repo has one (`#### PR <id> — title` blocks); the queue's
  headings and acceptance lines are then generated from it by `scripts/sync-roadmap.mjs`.
- Build contract: the repo's `CLAUDE.md` / `AGENTS.md`.

## Kit

Flags `/product init` detected or asked for. The kit scripts read this section.

- `kit_version`: v1 (umbo 0f95e4fa; settings.local.json carries no header, so its version lives here)
- `stack`: node            # node | other
- `db`: postgres                  # postgres | none
- `ui`: true                  # true | false — screens, so the render check and the founder's UI sign-off apply
- `diagrams`: true      # true | false — check-diagrams in the gate, flows.md registry
- `db_prefix`: llm_gateway_    # worktree databases are <db_prefix><branch>; the shared one is db_prefix minus its trailing _
- `db_dsn_keys`: DATABASE_URL   # .env.local keys worktree-setup repoints at the worktree database
- `db_superuser_key`:           # optional: a superuser DSN key, repointed at the `postgres` maintenance db
- `db_create`: true             # worktree-setup creates the worktree database with psql if absent
- `db_migrate`: npm run db:migrate   # new worktrees get the schema
- `gate_env`:                   # optional: env file exported into every gate step, e.g. .env.local
- `gate_inputs`: .env.local, node_modules/.package-lock.json  # untracked files the gate stamp fingerprints
- `scope_always_allowed`: package-lock.json  # files verify-pr never counts as out of scope
- `diagram_registry`: docs/diagrams/flows.md
- `diagram_data_paths`: packages/gateway/src/, packages/mock-provider/src/, docker-compose.yml  # a plan claiming "**None" data flows may not touch these
- `codemap_areas`:              # key=prefix pairs; unset = one area per top-level folder

## Coordinator

Every key from `~/.claude/agents/coordinator.md` §0, written explicitly so no default is guessed.
The founder can override any key for one session by saying so; record the override in HANDOFF,
not here.

- `gate_command`: bash scripts/gate.sh
- `verify_command`: node scripts/verify-pr.mjs --pr <n>
- `worktree_setup`: bash scripts/worktree-setup.sh <branch>
- `record_command`: node scripts/record-pr.mjs --pr <n>
- `queue_doc`: .product/roadmap.md
- `max_parallel_builders`: 3      # agents alive at once besides the coordinator; fix passes and verifiers count
- `max_migrations_in_flight`: 1
- `merge_policy`: merge-when-green   # merge-when-green (local main only) | branch-only (stop for a human)
- `push`: never
- `plan_gate`: human               # coordinator | human
- `stall_minutes`: 30
- `usage_pause_pct`: 80           # 5-hour usage: no new spawns
- `usage_stop_pct`: 90            # 5-hour usage: stop agents and wait for the reset
- `usage_weekly_pause_pct`: 86    # 7-day usage: drain — finish and merge what is in flight, then hand off
- `fix_rounds`: 2
- `autocompact_tokens`: 250000

## Budgets

Per PR, measured at the plan gate against the plan's Files table. There is no file or line
limit: size by whether the acceptance can be proven in one piece, and split only at a real seam.

| Budget | Limit |
|---|---|
| Migrations | 1 |
| Money-path crossings | 1 |

Token budgets: build ≤120k, tier-2 verify ≤60k, whole PR ≤250k. A stage that busts its budget
twice means the layer below it is broken — fix the plan or the script, never reach for a bigger model.

## Models

Aliases only, never ids: `builder: sonnet`, `verifier: sonnet`, `planner: opus`. Any model id or
SDK shape in product code follows the build contract's rule, never memory.
