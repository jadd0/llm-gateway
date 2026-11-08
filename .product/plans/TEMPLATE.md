<!-- product-kit plans/TEMPLATE.md v1 — from umbo 0f95e4fa -->
<!-- Copy to .product/plans/pr-<n>.md ON THE PR'S BRANCH, delete these comments, aim for ~150
     lines. Cut prose, never a path. Rewrite in place on any change: a plan containing
     "superseded" or "amendment" is a bug; git history is the audit trail. -->
# PR <n> — <title>

**CONCERN:** <one sentence: what is wrong or missing today, with file:line evidence>

**ACCEPTANCE:** <verbatim from the queue>

**SCOPE GUARD:** <the contract's hard-scope rules this PR must not cross; what it does not touch>

**BASE:** main `<short hash>`; branch `<branch>` (worktree `.claude/worktrees/<branch>`); stacked on
<branch, or "none">; migration: <"none", or "next free number at generate time" — never a number>.
Residuals owned by this PR: <R-ids, each closed here or re-argued, or "none">.

## Files
| path | change |
|---|---|
| `<path>` | <what changes and why; **new** for a new file> |

## Schema

<DDL, or "none".>

## Invariants

<The seam(s) where transitions and money are enforced; one lock order per table group; every new
state names its exit and the screen that lists it.>

## Tests

<Exact test names and files. Each new capability gets a test that fires only the upstream trigger
and asserts the downstream effect ("what calls it?").>

## Acceptance proof

<The commands that demonstrate it, walked hop by hop with the file for each hop.>

## Adversarial

1. <numbered cases for tier-2 verify: money, state, concurrency, isolation>

## Data flows

**None — this PR moves no data.**
<or one line per flow, copied verbatim from docs/diagrams/flows.md:
- <flow name> → `docs/diagrams/<file>.html` → `<code glob>`>

## Decisions

<Everything settled here so the builder decides nothing. Every open question gets a landing shape:
a config row with a default, or a slot that disables the feature, with a test. A decision that
changes what a user sees or what the system allows also goes in DECISIONS.md.>
