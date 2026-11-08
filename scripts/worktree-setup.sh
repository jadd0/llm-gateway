#!/usr/bin/env bash
# product-kit worktree-setup.sh v1 — from umbo 0f95e4fa
#
# Creates a git worktree for a PR branch, ready for a builder: dependencies linked, env copied,
# codemap written and, under `db: postgres` in .product/config.md § Kit, a database of its own.
#
# Usage: scripts/worktree-setup.sh <branch-name> [<path>] [<base-branch>]
#   scripts/worktree-setup.sh pr-2-tenancy                       # -> .claude/worktrees/pr-2-tenancy
#   scripts/worktree-setup.sh pr-17-billing '' pr-16b-retention   # stacked on another PR
#
# The third argument is for STACKING: a PR that depends on an unmerged one (above all, one whose
# migration follows the other's) branches off its predecessor, so the chain stays linear. It does
# not commit anything.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
cfg() { node "$ROOT/scripts/kit-config.mjs" get "$1"; }

BRANCH="${1:?Usage: scripts/worktree-setup.sh <branch-name> [<path>] [<base-branch>]}"
# Every worktree lands INSIDE the primary checkout, at `.claude/worktrees/<branch>` (gitignored),
# never as a sibling folder beside the repo. The anchor is the primary checkout (the parent of the
# shared git dir), so running this from a secondary worktree lands in the same place. Remove one
# with `git worktree remove <path>` once its PR merges.
PRIMARY="$(dirname "$(git rev-parse --path-format=absolute --git-common-dir)")"
WORKTREE_PATH="${2:-$PRIMARY/.claude/worktrees/${BRANCH}}"
BASE="${3:-main}"
mkdir -p "$(dirname "$WORKTREE_PATH")"

if git show-ref --verify --quiet "refs/heads/$BRANCH"; then
  git worktree add "$WORKTREE_PATH" "$BRANCH"
else
  git show-ref --verify --quiet "refs/heads/$BASE" || {
    echo "worktree-setup: no such base branch '$BASE'." >&2
    exit 1
  }
  git worktree add -b "$BRANCH" "$WORKTREE_PATH" "$BASE"
  if [ "$BASE" != "main" ]; then
    echo "NOTE: $BRANCH is STACKED on '$BASE', not main. Merge main in once '$BASE' merges;" >&2
    echo "  any migration it adds follows '$BASE''s, not main's." >&2
  fi
fi

# --- stack: node — link the dependency tree instead of re-installing it -----------------------
if [ "$(cfg stack)" = "node" ]; then
  if [ -d "node_modules" ]; then
    echo "Linking node_modules into $WORKTREE_PATH (cp -al) ..."
    cp -al node_modules "$WORKTREE_PATH/node_modules"
    echo "WARNING: node_modules is hard-linked, not copied. Run 'npm install' in at most one of" >&2
    echo "  $ROOT and $WORKTREE_PATH, or a fresh 'npm ci' in whichever tree you changed." >&2
    # The link is only as good as the root's tree: a merge that added a dependency leaves the
    # root's node_modules behind its own lockfile until someone installs there. `npm ci` replaces
    # the linked directory with the worktree's own files, so the root's tree is not written to.
    if ! (cd "$WORKTREE_PATH" && npm ls --depth=0 >/dev/null 2>&1); then
      echo "The linked node_modules does not satisfy the worktree's lockfile; running npm ci there ..." >&2
      # Never fatal: the database step below must still run.
      (cd "$WORKTREE_PATH" && npm ci) || echo "worktree-setup: npm ci failed in $WORKTREE_PATH; run it there before the gate." >&2
    fi
  else
    echo "No node_modules here yet — run npm install first, or npm ci in the worktree." >&2
  fi
fi

# --- env ----------------------------------------------------------------------------------------
if [ -f ".env.local" ]; then
  cp ".env.local" "$WORKTREE_PATH/.env.local"
  # An editor can save .env.local with no final newline; appending to that fuses the new line
  # onto the last key and leaves it unset.
  if [ -s "$WORKTREE_PATH/.env.local" ] && [ "$(tail -c 1 "$WORKTREE_PATH/.env.local" | od -An -c | tr -d ' ')" != '\n' ]; then
    printf '\n' >>"$WORKTREE_PATH/.env.local"
  fi
  echo "Copied .env.local into $WORKTREE_PATH."
fi

# --- db: postgres — one database per worktree ---------------------------------------------------
# Two worktrees sharing one database make one PR's evidence depend on another's timing: a branch's
# migration or seed lands in the database another branch's suite is reading, and that suite goes
# red on a defect that does not exist.
if [ "$(cfg db)" = "postgres" ]; then
  PREFIX="$(cfg db_prefix)"
  if [ -z "$PREFIX" ]; then
    echo "worktree-setup: db: postgres needs db_prefix in .product/config.md § Kit." >&2
    exit 1
  fi
  ENV="$WORKTREE_PATH/.env.local"
  if [ ! -f "$ENV" ]; then
    echo "worktree-setup: no .env.local to copy, so no DSN to point at a worktree database; refusing to leave a worktree that would use the shared one." >&2
    exit 1
  fi
  # Postgres identifiers are 63 bytes; cut to 58 so a `__w<slot>` per-worker clone still fits.
  # Runs of `_` collapse, so a worktree's name never contains `__` and never equals a clone's.
  SLUG="$(printf '%s' "$BRANCH" | tr '[:upper:]' '[:lower:]' | tr -c 'a-z0-9' '_' | sed 's/__*/_/g; s/^_//; s/_$//')"
  TEST_DATABASE="$(printf '%s%s' "$PREFIX" "$SLUG" | sed 's/__*/_/g' | cut -c1-58)"

  # Replace rather than append, so a re-run leaves one line.
  if grep -q '^TEST_DATABASE=' "$ENV"; then
    sed -i '' "s|^TEST_DATABASE=.*|TEST_DATABASE=${TEST_DATABASE}|" "$ENV"
  else
    printf 'TEST_DATABASE=%s\n' "$TEST_DATABASE" >>"$ENV"
  fi
  # TEST_DATABASE alone is not enough: anything that reads a DSN straight off the environment
  # (migrate, generate, a psql one-liner, a seed) would still write the shared database.
  IFS=',' read -r -a KEYS <<<"$(cfg db_dsn_keys)"
  # The value may be quoted (KEY="postgres://…/db?x=y"); the quote and query string are kept.
  repoint() { sed -i '' "s|^\($1=\"\{0,1\}postgres[a-z]*://[^/]*\)/[A-Za-z0-9_]*\(?[^\"]*\)\{0,1\}\(\"\{0,1\}\)$|\1/$2\2\3|" "$ENV"; }
  for KEY in "${KEYS[@]}"; do
    if grep -q "^${KEY}=" "$ENV"; then
      repoint "$KEY" "$TEST_DATABASE"
      # Prove it: a DSN this could not parse would otherwise stay on the shared database.
      if ! grep "^${KEY}=" "$ENV" | grep -q "/${TEST_DATABASE}\([?\"]\|$\)"; then
        echo "worktree-setup: could not repoint ${KEY} in $ENV at ${TEST_DATABASE} (not a postgres:// DSN with a database name?); refusing to leave a worktree on the shared database." >&2
        exit 1
      fi
    fi
  done
  # A superuser DSN, if the repo has one, goes to the cluster's empty `postgres` maintenance
  # database: an ad-hoc script that reaches for it then fails loudly ("relation does not exist")
  # instead of silently writing a shared application database.
  SU="$(cfg db_superuser_key)"
  if [ -n "$SU" ] && grep -q "^${SU}=" "$ENV"; then
    repoint "$SU" postgres
  fi
  # Prove it landed as its own line rather than trusting the write.
  if ! grep -qx "TEST_DATABASE=${TEST_DATABASE}" "$ENV"; then
    echo "worktree-setup: TEST_DATABASE=${TEST_DATABASE} is not a line of $ENV; refusing to leave a worktree whose tests would hit the shared database." >&2
    exit 1
  fi
  # Create it if absent (never drops), through the first DSN key, on the maintenance database —
  # only on a local cluster. A hosted DSN (Neon, Supabase, RDS) is never written to from here:
  # creating databases in a hosted project is the founder's call, not a setup side effect.
  DSN="$(grep "^${KEYS[0]}=" "$ENV" | head -1 | cut -d= -f2- | tr -d '"')"
  HOST="$(printf '%s' "$DSN" | sed -E 's#^[a-z]+://([^@/]*@)?(\[[^]]*\]|[^:/?]*).*#\2#')"
  LOCAL=false
  case "$HOST" in localhost | 127.0.0.1 | "[::1]" | ::1) LOCAL=true ;; esac
  if [ "$LOCAL" != "true" ]; then
    echo "worktree-setup: ${KEYS[0]} is on '$HOST', not a local cluster — not creating or migrating ${TEST_DATABASE} there." >&2
  elif [ "$(cfg db_create)" = "true" ] && command -v psql >/dev/null 2>&1; then
    MAINT="$(printf '%s' "$DSN" | sed "s|/${TEST_DATABASE}|/postgres|")"
    if [ -n "$DSN" ]; then
      if [ "$(psql "$MAINT" -tAc "select 1 from pg_database where datname = '${TEST_DATABASE}'" 2>/dev/null)" != "1" ]; then
        psql "$MAINT" -qc "create database \"${TEST_DATABASE}\"" &&
          echo "Created database ${TEST_DATABASE}." ||
          echo "worktree-setup: could not create ${TEST_DATABASE}; the repo's test setup must create it." >&2
      fi
    fi
  fi
  MIGRATE="$(cfg db_migrate)"
  if [ -n "$MIGRATE" ] && [ "$LOCAL" = "true" ]; then
    (cd "$WORKTREE_PATH" && bash -c "$MIGRATE") || echo "worktree-setup: '$MIGRATE' failed in $WORKTREE_PATH." >&2
  fi
  echo "Worktree database: ${TEST_DATABASE} (TEST_DATABASE and ${KEYS[*]} in $ENV)."
fi

# The builder's map of the tree (.codemap/, gitignored), from THIS checkout's copy of the script
# with the worktree as its root, so a branch cut before the script existed still gets one.
node "$ROOT/scripts/codemap.mjs" "$WORKTREE_PATH" || echo "worktree-setup: codemap failed — builders fall back to grep." >&2

echo "Worktree ready at $WORKTREE_PATH on branch $BRANCH."
