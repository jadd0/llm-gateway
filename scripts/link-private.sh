#!/usr/bin/env bash
# Links the primary checkout's private, gitignored files into a worktree, so the product loop's
# scripts (which read .product/) and builders (who add to INTERVIEW_QUESTIONS.md) see the one copy.
# Usage: scripts/link-private.sh <worktree-path>     (run after scripts/worktree-setup.sh)
set -euo pipefail
WT="${1:?Usage: scripts/link-private.sh <worktree-path>}"
PRIMARY="$(dirname "$(git rev-parse --path-format=absolute --git-common-dir)")"
for name in .product INTERVIEW_QUESTIONS.md; do
  [ -e "$PRIMARY/$name" ] || { echo "link-private: $PRIMARY/$name is missing" >&2; exit 1; }
  if [ -L "$WT/$name" ]; then continue; fi
  if [ -e "$WT/$name" ]; then
    # A tracked copy from an older branch: drop it from the index; the primary copy is the one kept.
    git -C "$WT" rm -r -q --cached --ignore-unmatch "$name"
    rm -rf "${WT:?}/$name"
  fi
  ln -s "$PRIMARY/$name" "$WT/$name"
  echo "linked $WT/$name -> $PRIMARY/$name"
done
