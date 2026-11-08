<!-- product-kit handoff/HANDOFF.md v1 — from umbo 0f95e4fa -->
# Loop handoff — the coordinator's state

The top section is the loop's state, and the only part a resume reads. **Rewrite it** (never
prepend) after every spawn, merge and decision. At most 10 bullets; a bullet that needs more is a
`handoff/<date>-<topic>.md` brief, linked. On each rewrite, move the previous section, verbatim, to
`handoff/archive/<YYYY-MM-DD>.md` (append if that day's file exists), so this file stays small.

## Now — <YYYY-MM-DD HH:MM>, coordinator <RUNNING | STOPPED CLEAN | PAUSED (why)>

- **Caps:** <n> builders, <n> migration, merge <policy>, push never. Usage 5h=<n> 7d=<n>.
- **Running:** <branch> (<worktree>, plan <commit>) — <stage>.
- **Merged:** <PR> `<hash>` — <one line>.
- **Next:** <PR ids in order, with what each waits on>.
- **Blocked on the founder:** <item> → FOUNDER-TODO § <section>.
- **Rules learned:** <one line each; promote to AGENT-BRIEF or a script when it recurs>.
