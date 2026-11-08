<!-- product-kit RESIDUALS.md v1 — from umbo 0f95e4fa -->
# Residuals — known gaps, deliberately deferred, each with an owner

A residual is a gap we **found and understood** and chose not to close in the PR that found it.
It is not a TODO and not a bug backlog: every row names the PR that must close it, and that PR's
plan is not approved at its gate until every row pointing at it is closed or re-argued here.

A gap that lives only in a code comment is a gap that ships. That is what this file prevents.

New rows go in the open table, **above** "Closing a residual". Ids are `R<n>`, never reused.

| # | Gap | Found in | Owner | Why it was not closed there |
|---|-----|----------|-------|------------------------------|

## Closing a residual

Move the row to Closed in the PR that closes it, in the same commit as the code, adding the
closing PR and commit, and say so in that PR's NOTES. A residual removed without a commit that
closes it is a regression. Never add an open row below this heading.

## Closed

| # | Gap | Closed by | Commit |
|---|-----|-----------|--------|
