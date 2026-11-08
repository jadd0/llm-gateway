#!/usr/bin/env node
// product-kit codemap.mjs v1 — from umbo 0f95e4fa
//
// Writes `.codemap/` — a generated map of the codebase for builder agents, so a builder finds the
// file it needs with one `grep` instead of reading its way around the tree. Measured on umbo,
// reading code to orient was 50–75% of a builder's tool output, and nothing it reads leaves its
// context. One line per file: purpose (its leading comment), what it defines (tables, routes),
// its exports, and which tests import it.
//
// Generated, never committed (`.codemap/` is gitignored); scripts/worktree-setup.sh runs it for
// every new worktree. Areas come from .product/config.md § Kit `codemap_areas`, as
// `key=prefix` pairs (`routes=app/, schema=db/`); unset, there is one area per top-level folder.
// Tests are always claimed first, and top-level files go to `root`.
//
// Usage: node scripts/codemap.mjs [<repo-root>]
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, posix, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { kitConfig } from "./kit-config.mjs";

const ROOT = resolve(process.argv[2] ?? join(dirname(fileURLToPath(import.meta.url)), ".."));
const OUT = join(ROOT, ".codemap");
const SOURCE = /\.(ts|tsx|js|jsx|mjs|cjs|sh|sql|py)$/;
const isTest = (p) => /(^|\/)(tests?|__tests__)\//.test(p) || /\.(test|spec)\.[cm]?[jt]sx?$/.test(p) || /(^|\/)test_[^/]+\.py$/.test(p);

const tracked = execFileSync("git", ["-C", ROOT, "ls-files"], { encoding: "utf8" })
  .split("\n")
  .filter((p) => p && SOURCE.test(p) && !p.startsWith(".") && !/(^|\/)migrations\//.test(p));

const configured = kitConfig(ROOT).codemap_areas
  .map((pair) => pair.split("=").map((s) => s.trim()))
  .filter(([k, v]) => k && v)
  .map(([key, prefix]) => ({ key, match: (p) => p.startsWith(prefix), about: `Files under \`${prefix}\`.` }));
const tops = [...new Set(tracked.filter((p) => p.includes("/")).map((p) => p.split("/")[0]))].sort();
const AREAS = [
  { key: "tests", match: isTest, about: "Tests and test helpers (every `*.test.*`/`*.spec.*`, and `test/`, `tests/`, `__tests__/`)." },
  ...(configured.length ? configured : tops.map((t) => ({ key: t.replace(/[^a-z0-9-]/gi, "_"), match: (p) => p.startsWith(`${t}/`), about: `Files under \`${t}/\`.` }))),
  { key: "other", match: (p) => p.includes("/"), about: "Files outside every configured area." },
  { key: "root", match: () => true, about: "Top-level files." },
];

const read = (p) => {
  try {
    return readFileSync(join(ROOT, p), "utf8");
  } catch {
    return "";
  }
};

/** The first sentence of the file's leading comment. */
function purpose(src) {
  const m =
    src.match(/^(?:\s*(?:"use [a-z]+";?|import[^\n]*|#![^\n]*)\n)*\s*\/\*\*?([\s\S]*?)\*\//) ??
    src.match(/^(?:\s*(?:"use [a-z]+";?|#![^\n]*)\n)*((?:\s*(?:\/\/|#)[^\n]*\n)+)/);
  if (!m) return "";
  let t = m[1]
    .split("\n")
    .map((l) => l.replace(/^\s*(\*|\/\/|#)\s?/, "").trim())
    .filter((l) => l && !l.startsWith("eslint") && !l.startsWith("@") && !l.startsWith("product-kit "))
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  const end = t.search(/[.!?](\s|$)/);
  if (end > 20) t = t.slice(0, end + 1);
  return t.length > 140 ? t.slice(0, 137) + "…" : t;
}

function exportsOf(src) {
  const names = new Set();
  for (const m of src.matchAll(/^export\s+(?:default\s+)?(?:async\s+)?(?:function\*?|const|let|class|type|interface|enum)\s+([A-Za-z_$][\w$]*)/gm)) names.add(m[1]);
  for (const m of src.matchAll(/^export\s*\{([^}]*)\}/gm))
    for (const n of m[1].split(",")) {
      const name = n.trim().split(/\s+as\s+/).pop();
      if (name && name !== "type") names.add(name.replace(/^type\s+/, ""));
    }
  return [...names];
}

function defines(p, src) {
  const out = [];
  const tables = [...src.matchAll(/(?:pgTable|sqliteTable|mysqlTable)\(\s*"([a-z0-9_]+)"/g)].map((m) => m[1]);
  if (tables.length) out.push(`tables: ${tables.join(", ")}`);
  const enums = [...src.matchAll(/pgEnum\(\s*"([a-z0-9_]+)"/g)].map((m) => m[1]);
  if (enums.length) out.push(`enums: ${enums.join(", ")}`);
  // Next.js App Router: `app/(group)/k/[token]/page.tsx` → `page /k/[token]`.
  const r = p.match(/^app\/(.*?)\/?(page|route|layout|actions|loading|error|not-found)\.[jt]sx?$/);
  if (r) {
    const url = "/" + r[1].split("/").filter((s) => s && !/^\(.*\)$/.test(s) && !s.startsWith("_")).join("/");
    out.push(`${r[2]} ${url.replace(/\/$/, "") || "/"}`);
  }
  return out;
}

// Which tests import each source file, by the `@/…` alias or a relative path.
const stem = (p) => p.replace(/\.[cm]?[jt]sx?$/, "").replace(/\/index$/, "");
const testedBy = new Map();
for (const t of tracked.filter(isTest)) {
  for (const m of read(t).matchAll(/(?:from\s+|import\s*\(?\s*|require\(\s*)["']([^"']+)["']/g)) {
    const spec = m[1];
    let target = null;
    if (spec.startsWith("@/")) target = spec.slice(2);
    else if (spec.startsWith(".")) target = posix.normalize(posix.join(posix.dirname(t), spec));
    if (!target) continue;
    const key = stem(target);
    if (!testedBy.has(key)) testedBy.set(key, new Set());
    testedBy.get(key).add(t);
  }
}

const cap = (list, n) => (list.length > n ? `${list.slice(0, n).join(", ")} +${list.length - n}` : list.join(", "));
const lines = new Map(AREAS.map((a) => [a.key, []]));
const dirCounts = new Map();
for (const p of tracked) {
  const area = AREAS.find((a) => a.match(p));
  const src = read(p);
  const parts = [];
  const what = purpose(src);
  if (what) parts.push(what);
  const defs = defines(p, src);
  if (defs.length) parts.push(`[${defs.join("; ")}]`);
  const ex = exportsOf(src);
  if (ex.length && !isTest(p)) parts.push(`exports: ${cap(ex, 10)}`);
  const tests = testedBy.get(stem(p));
  if (tests && !isTest(p)) parts.push(`tests: ${cap([...tests].sort(), 4)}`);
  if (area.key === "tests" && !what) {
    const d = src.match(/describe\(\s*["'`]([^"'`]{3,100})/);
    if (d) parts.unshift(`describe: ${d[1]}`);
  }
  lines.get(area.key).push(`${p} — ${parts.join(" · ") || "(no header, no exports)"}`);
  const segs = p.split("/").slice(0, -1);
  const dir = segs.length ? segs.slice(0, 2).join("/") : ".";
  dirCounts.set(dir, (dirCounts.get(dir) ?? 0) + 1);
}

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
const used = AREAS.filter((a) => lines.get(a.key).length > 0);
const index = [
  "# Codemap — generated by `scripts/codemap.mjs`; never edit, never commit",
  "",
  "Find code with grep, not by reading: `grep -i <term> .codemap/*.md` (a concept, table, URL or",
  "export). Each hit is one file: purpose · [tables/URL] · exports · the tests that import it.",
  "Then read only the ranges you need (`grep -n` → `sed -n`). Never read an area file whole.",
  "Regenerate after adding files: `node scripts/codemap.mjs`.",
  "",
  "## Areas",
  "",
  ...used.map((a) => `- \`.codemap/${a.key}.md\` (${lines.get(a.key).length} files) — ${a.about}`),
  "",
  "## Tree — folder (files): subfolder files, …",
  "",
];
const tree = new Map();
for (const [d, n] of [...dirCounts.entries()].sort()) {
  const top = d === "." ? "(root)" : d.split("/")[0];
  const sub = d === "." ? "" : d.slice(top.length + 1);
  if (!tree.has(top)) tree.set(top, { total: 0, subs: [] });
  const t = tree.get(top);
  t.total += n;
  t.subs.push(sub ? `${sub} ${n}` : `(own) ${n}`);
}
for (const [top, t] of tree) index.push(`- **${top}/** (${t.total}): ${t.subs.join(", ")}`);
index.push("");
writeFileSync(join(OUT, "INDEX.md"), index.join("\n"));
for (const a of used) writeFileSync(join(OUT, `${a.key}.md`), `# ${a.key} — ${a.about}\n\n${lines.get(a.key).sort().join("\n")}\n`);
console.log(`codemap: ${tracked.length} files → .codemap/ (INDEX.md + ${used.length} areas)`);
