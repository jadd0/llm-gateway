#!/usr/bin/env node
// product-kit check-diagrams.mjs v1 — from umbo 0f95e4fa
//
// Enforces the data-flow-diagram rule (installed under `diagrams: true`): every flow the product
// has is one line in the registry (.product/config.md § Kit `diagram_registry`, default docs/diagrams/flows.md)
// with a diagram beside it, and that diagram must not be stale against the code it describes.
//
// The registry, not the plans, is the input: old plans keep the paths they were written with, so
// after a move their globs would match nothing and the check would go quietly dead.
//
// Registry contract (every non-blank line under its `## Flows` heading):
//   - <flow name> → `docs/diagrams/<file>.html` → `<code glob>`
//   - the line must parse and the diagram file must exist;
//   - every entry of the glob (each member of a `{a,b,c}` group) must match a tracked file, so a
//     moved file cannot hide inside a group whose other members still match;
//   - the diagram must not be older than the last commit touching a file the glob matches.
//     If the repo has scripts/lib/codemod-commit.mjs (umbo's move codemod), commits that are
//     exactly the codemod's output are looked through; without it, every commit counts.
//   - `contains(<identifier>):<glob>` matches only files whose contents mention the identifier
//     (SQL comments stripped in `.sql` files), for a flow that rests on one function.
//
// Every plan in the branch's diff against main is checked against the registry:
//   - a `## Data flows` section whose first non-blank line starts with `**None` is a CLAIM: it
//     holds only when the plan's `## Schema` first line is `none` and no path cell of its
//     `## Files` table is under a `diagram_data_paths` prefix (config); otherwise
//   - every flow line under the section must be in the registry verbatim.
import { execFileSync } from "node:child_process";
import { existsSync, globSync, readFileSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { kitConfig } from "./kit-config.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PLANS_DIR = ".product/plans";
const FLOW_LINE = /^-\s+(.+?)\s+→\s+`([^`]+)`\s+→\s+`([^`]+)`\s*$/u;
export const MAX_CODEMOD_HOPS = 512;
export class HistoryWalkError extends Error {}

function extractSection(lines, heading) {
  const start = lines.findIndex((l) => l.trim() === heading);
  if (start === -1) return null;
  const out = [];
  for (let i = start + 1; i < lines.length && !/^##\s/.test(lines[i]); i++) out.push(lines[i]);
  return out;
}
const firstNonBlank = (section) => section.map((l) => l.trim()).find((l) => l.length > 0);

/** The path cell of every `## Files` row, backticks stripped; header and separator skipped. */
export function extractFilesTablePaths(section) {
  const paths = [];
  for (const raw of section) {
    const line = raw.trim();
    if (!line.startsWith("|")) continue;
    const first = line.split("|").slice(1, -1).map((c) => c.trim())[0];
    if (!first || /^:?-+:?$/.test(first) || first.toLowerCase() === "path") continue;
    paths.push(first.replace(/`/g, "").trim());
  }
  return paths;
}

/** A failure message, or null when the plan's "**None" claim holds. */
export function validateNoneClaim(text, planName, dataPaths) {
  const lines = text.split("\n");
  const schema = extractSection(lines, "## Schema");
  const schemaFirst = schema ? firstNonBlank(schema) : undefined;
  if (!schemaFirst || !/^none\b/i.test(schemaFirst)) {
    return `${planName}: claims "None" under §Data flows but §Schema's first line is not "None": "${schemaFirst ?? "(missing)"}"`;
  }
  const files = extractSection(lines, "## Files");
  if (files === null) return `${planName}: claims "None" under §Data flows but has no "## Files" section to check it against`;
  const paths = extractFilesTablePaths(files);
  if (paths.length === 0) return `${planName}: claims "None" under §Data flows but its "## Files" table has no rows`;
  for (const p of paths) {
    if (p.split(/\s*[·+]\s*/).every((part) => /\.(test|spec)\.[cm]?[jt]sx?$/.test(part))) continue;
    const hit = dataPaths.find((prefix) => p.startsWith(prefix));
    if (hit) return `${planName}: claims "None" under §Data flows but §Files lists "${p}", under "${hit}"`;
  }
  return null;
}

export function splitGlobEntries(codeGlob) {
  const t = codeGlob.trim();
  if (!(t.startsWith("{") && t.endsWith("}"))) return [t];
  const entries = [];
  let depth = 0;
  let cur = "";
  for (const ch of t.slice(1, -1)) {
    if (ch === "{") depth += 1;
    if (ch === "}") depth -= 1;
    if (ch === "," && depth === 0) {
      entries.push(cur.trim());
      cur = "";
      continue;
    }
    cur += ch;
  }
  if (cur.trim() !== "") entries.push(cur.trim());
  return entries;
}

const stripSqlComments = (sql) => sql.replace(/\/\*[\s\S]*?\*\//gu, " ").replace(/--[^\n]*/gu, " ");
// `[` and `]` are literal (Next.js dynamic-route folders), never a character class.
const literalBrackets = (glob) => glob.replace(/[[\]]/g, (c) => (c === "[" ? "[[]" : "[]]"));

export function resolveGlobEntry(entry, root = ROOT) {
  const pred = entry.match(/^contains\(([A-Za-z0-9_]+)\):(.+)$/u);
  if (!pred) return globSync(literalBrackets(entry), { cwd: root });
  const [, identifier, glob] = pred;
  return globSync(literalBrackets(glob), { cwd: root }).filter((rel) => {
    try {
      const src = readFileSync(path.join(root, rel), "utf8");
      return (rel.endsWith(".sql") ? stripSqlComments(src) : src).includes(identifier);
    } catch {
      return false;
    }
  });
}

function git(root, args) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: 256 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] });
}

function trackedFiles(root) {
  try {
    return new Set(git(root, ["ls-files", "-z", "--cached", "--others", "--exclude-standard"]).split("\0").filter(Boolean));
  } catch {
    return new Set();
  }
}

/**
 * Time (ms) of the newest commit touching `relPath` that is not a pure codemod commit, or null
 * when none touches it (a new, uncommitted file). A git failure or a walk past the hop cap throws:
 * returning null there would read as "nothing to compare" and pass a diagram nobody checked.
 */
export function lastRealCommitTime(root, relPath, history, maxHops = MAX_CODEMOD_HOPS) {
  let rev = "HEAD";
  let current = relPath;
  for (let hops = 0; hops < maxHops; hops++) {
    let out;
    try {
      out = git(root, ["log", "-1", "--format=%H %ct", rev, "--", current]).trim();
    } catch (error) {
      throw new HistoryWalkError(`git log failed for ${current} at ${rev} (${String(error.message).split("\n")[0]})`);
    }
    if (!out) return null;
    const [hash, ct] = out.split(" ");
    const codemod = history ? history.codemodCommit(hash) : null;
    if (!codemod) return Number(ct) * 1000;
    rev = `${hash}^`;
    current = codemod.sourceOf.get(current) ?? current;
  }
  throw new HistoryWalkError(`gave up after ${maxHops} codemod commits walking the history of ${relPath}`);
}

function registryLines(text) {
  const lines = text.split("\n");
  const start = lines.findIndex((l) => l.trim() === "## Flows");
  if (start === -1) return null;
  const out = [];
  for (let i = start + 1; i < lines.length && !/^##\s/.test(lines[i]); i++) {
    if (lines[i].trim().length > 0) out.push({ line: lines[i].trim(), number: i + 1 });
  }
  return out;
}

/** Every plan in the branch's diff against main (committed, staged, unstaged or untracked). */
export function newPlanFiles(root = ROOT) {
  const plans = new Set();
  for (const base of ["main", "origin/main"]) {
    let mergeBase;
    try {
      mergeBase = git(root, ["merge-base", "HEAD", base]).trim();
    } catch {
      continue;
    }
    const changed = git(root, ["diff", "--name-only", "-z", mergeBase, "--", PLANS_DIR]).split("\0");
    const untracked = git(root, ["ls-files", "-z", "--others", "--exclude-standard", "--", PLANS_DIR]).split("\0");
    for (const f of [...changed, ...untracked]) {
      if (/^\.product\/plans\/[^/]+\.md$/.test(f) && !f.endsWith("/TEMPLATE.md") && existsSync(path.join(root, f))) plans.add(f);
    }
    break;
  }
  return [...plans].sort().map((f) => path.join(root, f));
}

export async function checkDiagrams({ root = ROOT, plans } = {}) {
  const cfg = kitConfig(root);
  const registry = cfg.diagram_registry;
  const failures = [];
  const registryFile = path.join(root, registry);
  const registryText = existsSync(registryFile) ? readFileSync(registryFile, "utf8") : null;

  // The codemod reader is optional and loaded only when present.
  let history = null;
  const codemodFile = path.join(root, "scripts/lib/codemod-commit.mjs");
  if (existsSync(codemodFile)) {
    const { codemodHistory } = await import(pathToFileURL(codemodFile).href);
    history = codemodHistory(root);
  }
  const tracked = trackedFiles(root);

  const registered = new Set();
  const entries = registryText === null ? null : registryLines(registryText);
  if (entries === null) failures.push(`${registry}: missing, or has no "## Flows" heading.`);
  for (const { line, number } of entries ?? []) {
    const where = `${registry}:${number}`;
    registered.add(line);
    const m = line.match(FLOW_LINE);
    if (!m) {
      failures.push(`${where}: malformed data-flow line: "${line}"`);
      continue;
    }
    const [, flow, diagram, codeGlob] = m;
    if (!existsSync(path.join(root, diagram))) {
      failures.push(`${where}: diagram missing for flow "${flow}": ${diagram}`);
      continue;
    }
    try {
      const empty = [];
      const matched = new Set();
      for (const entry of splitGlobEntries(codeGlob)) {
        const hits = resolveGlobEntry(entry, root).filter((rel) => tracked.has(rel));
        if (hits.length === 0) empty.push(entry);
        for (const h of hits) matched.add(h);
      }
      if (empty.length > 0) {
        failures.push(`${where}: code glob for flow "${flow}" has entries that match no tracked file: ${empty.map((e) => `\`${e}\``).join(", ")}`);
        continue;
      }
      let codeTime = null;
      for (const rel of matched) {
        const t = lastRealCommitTime(root, rel, history);
        if (t !== null && (codeTime === null || t > codeTime)) codeTime = t;
      }
      let diagramTime = lastRealCommitTime(root, diagram, history);
      if (diagramTime === null) diagramTime = statSync(path.join(root, diagram)).mtimeMs;
      if (codeTime !== null && diagramTime < codeTime) {
        failures.push(`${where}: diagram is stale for flow "${flow}": ${diagram} predates the last commit touching ${codeGlob}`);
      }
    } catch (error) {
      if (!(error instanceof HistoryWalkError)) throw error;
      failures.push(`${where}: cannot tell whether the diagram for flow "${flow}" is stale: ${error.message}`);
    }
  }

  for (const planPath of plans ?? newPlanFiles(root)) {
    const planName = path.relative(root, planPath);
    const text = readFileSync(planPath, "utf8");
    const section = extractSection(text.split("\n"), "## Data flows");
    if (section === null) {
      failures.push(`${planName}: has no "## Data flows" section.`);
      continue;
    }
    const nonBlank = section.map((l) => l.trim()).filter((l) => l.length > 0);
    if (nonBlank.length === 0) {
      failures.push(`${planName}: "## Data flows" is empty (expected "**None…" or flow lines).`);
      continue;
    }
    if (nonBlank[0].startsWith("**None")) {
      const f = validateNoneClaim(text, planName, cfg.diagram_data_paths);
      if (f) failures.push(f);
      continue;
    }
    for (const line of nonBlank) {
      if (!FLOW_LINE.test(line)) failures.push(`${planName}: malformed data-flow line: "${line}"`);
      else if (!registered.has(line)) failures.push(`${planName}: data-flow line is not in ${registry} verbatim: "${line}"`);
    }
  }
  return failures;
}

function isMainModule() {
  if (!process.argv[1]) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
  } catch {
    return false;
  }
}

if (isMainModule()) {
  const failures = await checkDiagrams();
  if (failures.length === 0) {
    console.log("check-diagrams: the registry and every new plan's data flows are satisfied.");
    process.exit(0);
  }
  console.error(`check-diagrams: ${failures.length} problem(s):`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
