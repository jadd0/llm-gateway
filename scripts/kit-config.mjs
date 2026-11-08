#!/usr/bin/env node
// product-kit kit-config.mjs v1 — from umbo 0f95e4fa
//
// Reads `.product/config.md` § Kit, so every kit script takes its repo-specific values from one
// place and none of them forks per repo. A line under `## Kit` looks like
//
//   - `db_prefix`: myapp_          (a trailing " (…)" or " # …" is a comment and is dropped)
//
// Lists are comma-separated. A key that is absent falls back to the default below, which is
// derived from the other flags where that is safe (`gate_inputs` adds the installed npm tree only
// under `stack: node`).
//
// Usage from bash:  node scripts/kit-config.mjs get <key>     (prints the value, empty if unset)
import { existsSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Parses every `- \`key\`: value` line under `## <section>` of a config.md text. */
export function parseSection(text, section) {
  const out = {};
  let inside = false;
  for (const line of text.split("\n")) {
    if (/^##\s/.test(line)) {
      inside = line.replace(/^##\s+/, "").trim().toLowerCase() === section.toLowerCase();
      continue;
    }
    if (!inside) continue;
    const m = line.match(/^\s*-\s+`?([a-z_][a-z0-9_]*)`?\s*:\s*(.*)$/i);
    if (!m) continue;
    // A value ends at the first " (" or " #": umbo's own config annotates values in prose.
    let value = m[2].replace(/(^|\s+)\(.*$/, "").replace(/(^|\s+)#.*$/, "").trim();
    value = value.replace(/^`(.*)`$/, "$1");
    out[m[1]] = value;
  }
  return out;
}

const list = (v) => (v ? v.split(",").map((s) => s.trim()).filter(Boolean) : []);

/** The § Kit values with defaults applied. */
export function kitConfig(root = ROOT) {
  const file = path.join(root, ".product/config.md");
  const text = existsSync(file) ? readFileSync(file, "utf8") : "";
  const raw = parseSection(text, "Kit");
  // `queue_doc` is a coordinator key; § Kit may override it, else § Coordinator's value holds.
  const coordinator = parseSection(text, "Coordinator");
  const stack = raw.stack || "node";
  const db = raw.db || "none";
  const prefix = raw.db_prefix || "";
  return {
    stack,
    db,
    ui: raw.ui === "true",
    diagrams: raw.diagrams === "true",
    db_prefix: prefix,
    // The database the primary checkout, main and CI share; never a worktree's own.
    db_shared: raw.db_shared || prefix.replace(/_+$/, ""),
    db_dsn_keys: list(raw.db_dsn_keys || "DATABASE_URL"),
    db_superuser_key: raw.db_superuser_key || "",
    db_create: (raw.db_create || "true") === "true",
    db_migrate: raw.db_migrate || "",
    gate_env: raw.gate_env || "",
    gate_inputs: list(raw.gate_inputs || (stack === "node" ? ".env.local, node_modules/.package-lock.json" : ".env.local")),
    scope_always_allowed: list(raw.scope_always_allowed || (stack === "node" ? "package-lock.json" : "")),
    queue_doc: raw.queue_doc || coordinator.queue_doc || ".product/roadmap.md",
    diagram_registry: raw.diagram_registry || "docs/diagrams/flows.md",
    diagram_data_paths: list(raw.diagram_data_paths || "db/, migrations/, app/api/, pages/api/, api/, server/, jobs/, actions/"),
    codemap_areas: list(raw.codemap_areas || ""),
  };
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
  const [cmd, key] = process.argv.slice(2);
  const cfg = kitConfig();
  if (cmd !== "get" || !key || !(key in cfg)) {
    console.error(`usage: kit-config.mjs get <${Object.keys(cfg).join("|")}>`);
    process.exit(2);
  }
  const v = cfg[key];
  console.log(Array.isArray(v) ? v.join(",") : String(v));
}
