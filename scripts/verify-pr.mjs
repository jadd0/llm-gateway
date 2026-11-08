#!/usr/bin/env node
// product-kit verify-pr.mjs v1 — from umbo 0f95e4fa
//
// Runs the gate, then fails if any file changed since the PR's base branch falls outside the
// plan's declared scope: the paths in its `## Files` table, plus the plan file itself (a plan
// can be corrected mid-build; it is not product code, so a change to it is never a violation),
// plus `scope_always_allowed` from .product/config.md § Kit (default `package-lock.json` under
// `stack: node`).
//
// The gate is skipped when scripts/gate-stamp.mjs holds a passing stamp for exactly this tree
// (same content, clean, same untracked inputs); --fresh runs it anyway.
//
// Usage: node scripts/verify-pr.mjs (--pr <id> | --plan <name>) [--base <branch>] [--skip-gate] [--fresh]
//   --pr <id>      the plan is .product/plans/pr-<id>.md   (ids: 12, 12a, 12a3, 12a3b)
//   --plan <name>  the plan is .product/plans/<name>.md
//   --skip-gate    scope check only; it never counts as a verify, and says so
// Run it with the worktree as the cwd: there is no path flag, and an unknown flag is refused.
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { currentFingerprint, readStamp, stampMatches } from "./gate-stamp.mjs";
import { kitConfig } from "./kit-config.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function planFileFor({ pr, plan }) {
  return plan ? `.product/plans/${plan}.md` : `.product/plans/pr-${pr}.md`;
}

/**
 * The exact paths and globs the plan's `## Files` table allows. Throws on a missing section and
 * on a row whose path cell cannot be read as paths: a row that silently matches nothing reads as
 * declared scope while the checker never looks for it, which is worse than a loud failure.
 * @returns {Set<string>}
 */
export function extractAllowedPaths(planText) {
  const lines = planText.split("\n");
  const start = lines.findIndex((l) => l.trim() === "## Files");
  if (start === -1) throw new Error('plan has no "## Files" section.');
  const allowed = new Set();
  for (let i = start + 1; i < lines.length; i++) {
    if (/^##\s/.test(lines[i])) break;
    const line = lines[i].trim();
    if (!line.startsWith("|")) continue;
    const first = line.split("|").slice(1, -1).map((c) => c.trim())[0];
    if (!first || /^:?-+:?$/.test(first) || first.toLowerCase() === "path") continue;
    // When the cell backticks its paths, the backticked tokens ARE the paths and any prose around
    // them is ignored; joined with " + " so a later bare name still inherits the first's directory.
    const ticked = [...first.matchAll(/`([^`]+)`/g)].map((m) => m[1].trim());
    const cell = ticked.length > 0 ? ticked.join(" + ") : first;
    const before = allowed.size;
    addCellPaths(cell, allowed, `line ${i + 1}`);
    if (allowed.size === before) throw new Error(`plan §Files line ${i + 1}: no path in "${first}".`);
  }
  return allowed;
}

/**
 * Adds every path in one cell. "·" or "+" separates several paths; a later part with no directory
 * of its own is also tried under the first part's directory, and a later part that starts with "."
 * is also tried as a suffix swapped for the first part's extension (`x.html + .json`). A spurious
 * extra entry is the safe direction: a checker too narrow is silently useless.
 */
function addCellPaths(cell, allowed, where) {
  const parts = splitMultiPath(cell);
  if (parts.length === 0) return;
  for (const part of parts) {
    if (/\s/.test(part)) throw new Error(`plan §Files ${where}: "${part}" is not a path (contains whitespace) — backtick each path in the cell.`);
  }
  const firstSlash = parts[0].lastIndexOf("/");
  const baseDir = firstSlash === -1 ? "" : parts[0].slice(0, firstSlash + 1);
  for (const [i, part] of parts.entries()) {
    if (i > 0 && part.startsWith(".") && !part.includes("/")) {
      for (const head of expandBraces(parts[0])) {
        const dot = head.lastIndexOf(".");
        if (dot > head.lastIndexOf("/")) allowed.add(head.slice(0, dot) + part);
      }
    }
    const candidates = i > 0 && baseDir ? [part, baseDir + part] : [part];
    for (const c of candidates) for (const e of expandBraces(c)) allowed.add(e);
  }
}

export function splitMultiPath(cell) {
  return cell.split(/[·+]/).map((s) => s.trim()).filter(Boolean);
}

/** `a-{1280,390}.png` -> `a-1280.png`, `a-390.png`; nested and multiple groups; unbalanced is left as is. */
export function expandBraces(pattern) {
  const open = pattern.indexOf("{");
  if (open === -1) return [pattern];
  let depth = 0;
  let close = -1;
  for (let i = open; i < pattern.length; i++) {
    if (pattern[i] === "{") depth += 1;
    else if (pattern[i] === "}" && --depth === 0) {
      close = i;
      break;
    }
  }
  if (close === -1) return [pattern];
  const before = pattern.slice(0, open);
  const after = pattern.slice(close + 1);
  const options = [];
  let current = "";
  let nested = 0;
  for (const ch of pattern.slice(open + 1, close)) {
    if (ch === "{") nested += 1;
    else if (ch === "}") nested -= 1;
    if (ch === "," && nested === 0) {
      options.push(current);
      current = "";
    } else current += ch;
  }
  options.push(current);
  return options.flatMap((o) => expandBraces(`${before}${o.trim()}${after}`));
}

/** "*" stays within one path segment, "**" crosses them. */
export function globToRegExp(pattern) {
  let re = "";
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === "*" && pattern[i + 1] === "*") {
      re += ".*";
      i += 1;
    } else if (ch === "*") re += "[^/]*";
    else re += ch.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`);
}

export function isAllowed(file, allowedPaths, planFile, alwaysAllowed = []) {
  if (file === planFile || alwaysAllowed.includes(file)) return true;
  for (const p of allowedPaths) {
    if (p.endsWith("/*") && !p.slice(0, -2).includes("*")) {
      if (file.startsWith(p.slice(0, -1))) return true;
    } else if (p === file) return true;
    else if (p.includes("*") && globToRegExp(p).test(file)) return true;
  }
  return false;
}

/**
 * What "this PR's changes" are measured from. Once `base` is an ancestor of HEAD (the branch has
 * merged it in, which is how a stacked branch is squared up), the two-dot diff is exact. Otherwise
 * the three-dot (merge-base) form, which on a stacked branch with several merge bases can count an
 * already-merged PR's files; that case is warned about, never chosen silently.
 */
export function diffAnchor(root, base) {
  const git = (args) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  try {
    git(["rev-parse", "--verify", "--quiet", `${base}^{commit}`]);
  } catch {
    throw new Error(`unknown base ref ${base}`);
  }
  let ancestor = true;
  try {
    git(["merge-base", "--is-ancestor", base, "HEAD"]);
  } catch {
    ancestor = false;
  }
  let bases = [];
  try {
    bases = git(["merge-base", "--all", base, "HEAD"]).split("\n").map((l) => l.trim()).filter(Boolean);
  } catch (err) {
    const stderr = String(err.stderr ?? "").trim();
    if (stderr) throw new Error(`git merge-base ${base} HEAD failed: ${stderr}`);
  }
  if (bases.length === 0) throw new Error(`no merge base between ${base} and HEAD — verify-pr cannot run`);
  return { ancestor, bases, range: ancestor ? `${base}..HEAD` : `${base}...HEAD` };
}

function changedFiles(root, base, anchor) {
  if (anchor.ancestor) {
    console.log(`verify-pr: comparing ${anchor.range} (${base} is an ancestor of HEAD, so this diff is exact).`);
  } else {
    console.log(`verify-pr: comparing ${anchor.range} (merge-base diff).`);
    if (anchor.bases.length > 1) {
      console.error(`verify-pr: WARNING — ${base} and HEAD have ${anchor.bases.length} merge bases, so git picked one.`);
      console.error(`  This is what a stacked branch looks like. Run \`git merge ${base}\` and re-run;`);
      console.error("  until then the list below may include the files of a PR that already merged.");
    }
  }
  const out = execFileSync("git", ["diff", "--name-only", anchor.range], { cwd: root, encoding: "utf8" });
  return out.split("\n").map((s) => s.trim()).filter(Boolean);
}

export const PR_ID_PATTERN = /^\d+(?:[a-z](?:\d+[a-z]?)?)?$/;
export const PLAN_NAME_PATTERN = /^[a-z0-9][a-z0-9-]*$/;
const USAGE = "Usage: verify-pr.mjs (--pr <id> | --plan <name>) [--base <branch>] [--skip-gate] [--fresh]";

export function parseArgs(argv) {
  const args = { pr: null, plan: null, base: "main", skipGate: false, fresh: false };
  const value = (i, flag) => {
    const v = argv[i];
    if (v === undefined || v.startsWith("--")) throw new Error(`verify-pr.mjs: ${flag} needs a value. ${USAGE}`);
    return v;
  };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--pr") args.pr = value(++i, "--pr");
    else if (argv[i] === "--plan") args.plan = value(++i, "--plan");
    else if (argv[i] === "--base") args.base = value(++i, "--base");
    else if (argv[i] === "--skip-gate") args.skipGate = true;
    else if (argv[i] === "--fresh") args.fresh = true;
    // Refused, never ignored: a silently dropped `--worktree <path>` once queued the gate in the
    // root checkout, against a database the gate truncates.
    else throw new Error(`verify-pr.mjs: unknown argument "${argv[i]}" — run it from inside the worktree; there is no path flag. ${USAGE}`);
  }
  if (args.pr !== null && args.plan !== null) throw new Error("verify-pr.mjs: --pr and --plan are mutually exclusive.");
  if (args.plan !== null) {
    if (!PLAN_NAME_PATTERN.test(args.plan)) throw new Error(`verify-pr.mjs: --plan "${args.plan}" is not a plan name (lowercase letters, digits, hyphens).`);
    return args;
  }
  if (!args.pr || !PR_ID_PATTERN.test(args.pr)) throw new Error(USAGE);
  return args;
}

/** The passing gate this exact state already has, or null; says why either way. */
export function reusableGate(root) {
  const stamp = readStamp(root);
  if (!stamp) return null;
  const verdict = stampMatches(stamp, currentFingerprint(root));
  if (!verdict.ok) {
    console.log(`verify-pr: earlier gate stamp not reused (${verdict.reason}); running the gate.`);
    return null;
  }
  console.log(
    `verify-pr: gate: PASS (reused) — ${verdict.reason}: tree ${stamp.tree.slice(0, 12)}, HEAD ${String(stamp.head).slice(0, 12)}, passed ${stamp.passedAt}. Use --fresh to run it again.`,
  );
  return stamp;
}

function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(err.message);
    return 2;
  }
  const { pr, plan, base, skipGate, fresh } = args;
  const label = plan ? `plan ${plan}` : `PR ${pr}`;
  const planFile = planFileFor({ pr, plan });

  let planText;
  try {
    planText = readFileSync(path.join(ROOT, planFile), "utf8");
  } catch {
    console.error(`verify-pr: ${planFile} not found.`);
    return 1;
  }
  let allowed;
  let anchor;
  try {
    allowed = extractAllowedPaths(planText);
    anchor = diffAnchor(ROOT, base);
  } catch (err) {
    console.error(`verify-pr: ${err.message}`);
    return 1;
  }

  const reuse = skipGate || fresh ? null : reusableGate(ROOT);
  const gate = skipGate
    ? (console.error("verify-pr: --skip-gate — scope check only; this is NOT a verify."), { status: 0 })
    : reuse
      ? { status: 0 }
      : spawnSync("bash", ["scripts/gate.sh"], { cwd: ROOT, stdio: "inherit" });
  if (gate.status !== 0) {
    console.error("verify-pr: gate failed; the scope check did not run.");
    return gate.status ?? 1;
  }

  const always = kitConfig(ROOT).scope_always_allowed;
  const files = changedFiles(ROOT, base, anchor);
  const outside = files.filter((f) => !isAllowed(f, allowed, planFile, always));
  if (outside.length > 0) {
    console.error(`verify-pr: ${outside.length} file(s) outside ${label}'s §Files table:`);
    for (const f of outside) console.error(`  - ${f}`);
    return 1;
  }
  console.log(`verify-pr: ${skipGate ? "scope only (gate skipped)" : "gate passed"} and all ${files.length} changed file(s) are within ${label}'s scope.`);
  return 0;
}

function isMainModule() {
  // import.meta.url is percent-encoded and symlink-resolved; argv[1] is neither (a space in the
  // path, or macOS /tmp -> /private/tmp). Resolve argv[1] the same way before comparing.
  if (!process.argv[1]) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
  } catch {
    return false;
  }
}

if (isMainModule()) process.exit(main());
