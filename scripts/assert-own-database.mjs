#!/usr/bin/env node
// product-kit assert-own-database.mjs v1 — from umbo 0f95e4fa
//
// Refuses to let a linked worktree run the gate against the SHARED database (installed under
// `db: postgres`, as the first line of .product/gate-steps) — the one the primary checkout, its dev
// server and any demo seed live in (.product/config.md § Kit `db_shared`, default `db_prefix`
// without its trailing underscore).
//
// scripts/worktree-setup.sh gets this right. The failure it guards is a worktree made some other
// way (a raw `git worktree add`): it has no `.env.local`, or a copied one, so every DSN resolves,
// every query succeeds, and the only symptom is damage somewhere else — a branch's migration in
// the shared schema, a running demo's data truncated. This says so at the moment it matters.
//
// The primary checkout is exempt (the shared database IS its own), and so is CI.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { kitConfig } from "./kit-config.mjs";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const git = (args) => execFileSync("git", args, { cwd: REPO, encoding: "utf8" }).trim();
const cfg = kitConfig(REPO);

if (cfg.db !== "postgres") {
  console.log("assert-own-database: db is not postgres in .product/config.md § Kit — nothing to check.");
  process.exit(0);
}
if (process.env.CI) {
  console.log("assert-own-database: CI — the service container is this run's own database.");
  process.exit(0);
}

let linked;
try {
  // In a linked worktree --git-dir is `.git/worktrees/<name>`; in the primary they are equal.
  linked = resolve(REPO, git(["rev-parse", "--git-dir"])) !== resolve(REPO, git(["rev-parse", "--git-common-dir"]));
} catch {
  console.log("assert-own-database: not a git checkout — nothing to compare.");
  process.exit(0);
}
const SHARED = cfg.db_shared;
if (!linked) {
  console.log(`assert-own-database: primary checkout — \`${SHARED}\` is its own database.`);
  process.exit(0);
}
if (!SHARED) {
  console.error("assert-own-database: set db_prefix (or db_shared) in .product/config.md § Kit.");
  process.exit(1);
}

const ENV_FILE = resolve(REPO, ".env.local");
/** From THIS worktree's own file, never process.env: an inherited value is the confusion this detects. */
function fromEnvFile(key) {
  if (!existsSync(ENV_FILE)) return undefined;
  for (const line of readFileSync(ENV_FILE, "utf8").split("\n")) {
    const t = line.trim();
    if (t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq > 0 && t.slice(0, eq) === key) return t.slice(eq + 1);
  }
  return undefined;
}
const dbOf = (dsn) => {
  const v = (dsn ?? "").trim().replace(/^["']|["']$/g, "");
  return v.slice(v.lastIndexOf("/") + 1).split("?")[0];
};

const faults = [];
if (!existsSync(ENV_FILE)) faults.push(`this worktree has no \`.env.local\`, so every DSN resolves from the root checkout's — the shared \`${SHARED}\`.`);
const testDatabase = (fromEnvFile("TEST_DATABASE") ?? "").replace(/^["']|["']$/g, "") || undefined;
if (!testDatabase) faults.push("TEST_DATABASE is unset.");
else if (testDatabase === SHARED) faults.push(`TEST_DATABASE is \`${SHARED}\` — the shared database.`);
for (const key of cfg.db_dsn_keys) {
  if (dbOf(fromEnvFile(key)) === SHARED) faults.push(`${key} points at \`${SHARED}\`; anything reading it directly (migrate, a seed, psql) writes the shared database.`);
}

if (faults.length === 0) {
  console.log(`assert-own-database: this worktree owns \`${testDatabase}\`.`);
  process.exit(0);
}
console.error("assert-own-database: refusing to run against the shared database.\n");
for (const f of faults) console.error(`  - ${f}`);
console.error(`
Give this worktree its own database:

  scripts/worktree-setup.sh <branch>      # for a NEW worktree — does all of this

For an existing one, copy a sibling's .env.local and substitute the database name in TEST_DATABASE
and ${cfg.db_dsn_keys.join(", ")}.
`);
process.exit(1);
