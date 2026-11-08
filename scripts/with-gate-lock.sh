#!/usr/bin/env bash
# product-kit with-gate-lock.sh v1 — from umbo 0f95e4fa
#
# The cross-worktree gate lock, in one place.
#
#   bash scripts/with-gate-lock.sh <command...>   take the lock, run the command, release it
#   source scripts/with-gate-lock.sh              define gate_lock_acquire (scripts/gate.sh does this)
#
# One gate at a time across every worktree: two concurrent suites sharing a machine, a database
# or a port collide, and a timing run that overlaps another suite measures the collision instead
# of the code. A check-then-run wait in the caller races; this lock does not. mkdir is atomic.
#
# The lock lives in the git common dir, which every worktree of the repo shares, not under
# $TMPDIR: a sandboxed agent shell can carry its own TMPDIR and so its own lock. Liveness is read
# with `ps -p`, not `kill -0`, which fails with EPERM from a sandbox that may not signal outside
# processes and would call a live owner dead. A stale lock is taken over by an atomic rename, so
# of two waiters that both see it stale only one removes it; the other's rename fails and it waits.
#
# Not re-entrant, on purpose: `gate.sh` takes this lock itself, so wrapping the gate in this
# script would leave the gate unlocked the moment its wrapper died (a timeout or a kill reaches
# only the wrapper's pid). Waiting would deadlock on its own parent. So an acquire that finds the
# lock held by one of its own ancestors refuses with exit 2. Run the gate directly; the wrapper
# is for everything else (a targeted test run that needs the shared resources).
# GATE_LOCK_DIR overrides the lock path, for tests of this file only.

# True when $1 is this process or one of its ancestors.
gate_lock_is_ancestor() {
  local want="$1" pid=$$
  while [ -n "$pid" ] && [ "$pid" -gt 1 ]; do
    [ "$pid" = "$want" ] && return 0
    pid="$(ps -o ppid= -p "$pid" 2>/dev/null | tr -d ' ')"
  done
  return 1
}

gate_lock_acquire() {
  local root common name
  root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
  common="$(cd "$root" && cd "$(git rev-parse --git-common-dir)" && pwd)"
  # Named after the primary checkout, which every worktree shares.
  name="$(basename "$(dirname "$common")")"
  GATE_LOCK="${GATE_LOCK_DIR:-$common/${name}-gate.lock}"
  local owner
  while ! mkdir "$GATE_LOCK" 2>/dev/null; do
    owner="$(cat "$GATE_LOCK/pid" 2>/dev/null || true)"
    if [ -n "$owner" ] && gate_lock_is_ancestor "$owner"; then
      echo "gate: gate.sh takes the gate lock itself and must not be run inside with-gate-lock.sh (held by its own parent, pid $owner); run it directly." >&2
      exit 2
    fi
    if [ -n "$owner" ] && ! ps -p "$owner" >/dev/null 2>&1; then
      if mv "$GATE_LOCK" "$GATE_LOCK.stale.$$" 2>/dev/null; then
        rm -rf "$GATE_LOCK.stale.$$"
      fi
      continue
    fi
    echo "gate: waiting for the gate already running (pid ${owner:-unknown})..."
    sleep 15
  done
  echo $$ >"$GATE_LOCK/pid"
  trap 'rm -rf "$GATE_LOCK"' EXIT
}

if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  if [ "$#" -eq 0 ]; then
    echo "usage: with-gate-lock.sh <command...>" >&2
    exit 2
  fi
  gate_lock_acquire
  "$@"
  exit $?
fi
