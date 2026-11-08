#!/usr/bin/env node
// product-kit record-pr.mjs v1 — from umbo 0f95e4fa
//
// Writes the loop-owned fields (status, commit, completed_at, notes, base_branch) of one PR's
// block in the queue doc (.product/config.md § Kit `queue_doc`, default .product/roadmap.md), in
// place. Never touches the `## PR <id> — title` heading or the `acceptance:` line.
//
// It fails loudly — exit 1 and one line naming what is missing — when the queue doc, the PR's
// block, or a field line in it is absent. A recorder that silently records nothing is the same
// failure as a test that passes while checking nothing: the queue drifts from what was built and
// nobody notices until the loop picks a merged PR again.
//
// Usage:
//   node scripts/record-pr.mjs --pr 12a --status done --commit abc1234 \
//     --completed-at 2026-11-01 --notes "what happened, single line"
import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { kitConfig } from "./kit-config.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WRITABLE_FIELDS = ["status", "commit", "completed_at", "notes", "base_branch"];
const PR_ID = /^\d+(?:[a-z](?:\d+[a-z]?)?)?$/;
const USAGE = "Usage: record-pr.mjs --pr <id> [--status s] [--commit h] [--completed-at d] [--notes n] [--base-branch b]";

function takeValue(argv, i, flag) {
  const v = argv[i + 1];
  if (v === undefined || v.startsWith("--")) throw new Error(`--${flag} requires a value.`);
  return v;
}

export function parseArgs(argv) {
  const args = { pr: null, fields: {} };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--pr") {
      args.pr = takeValue(argv, i++, "pr");
      continue;
    }
    // `--field=value` is refused rather than ignored: ignoring it once wrote nothing and exited 0.
    const eq = arg.match(/^--([a-z-]+)=/);
    if (eq) throw new Error(`--${eq[1]}=... is not supported; pass the value as the next argument.`);
    const flag = arg.match(/^--([a-z-]+)$/);
    if (!flag) throw new Error(`unexpected argument "${arg}". ${USAGE}`);
    const field = flag[1].replace(/-/g, "_");
    if (!WRITABLE_FIELDS.includes(field)) throw new Error(`unknown or non-writable field --${flag[1]}.`);
    args.fields[field] = takeValue(argv, i++, flag[1]).replace(/\r?\n/g, " / ");
  }
  if (!args.pr || !PR_ID.test(args.pr)) throw new Error(USAGE);
  if (Object.keys(args.fields).length === 0) throw new Error(`no field given. ${USAGE}`);
  return args;
}

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** @returns {string} the updated queue text; throws naming the missing block or field */
export function recordPr(text, pr, fields, docName = "the queue doc") {
  const lines = text.split("\n");
  const start = lines.findIndex((l) => new RegExp(`^## PR ${escape(pr)} —`).test(l));
  if (start === -1) throw new Error(`no "## PR ${pr} — …" block in ${docName}; add it (or regenerate with sync-roadmap) before recording.`);
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^## /.test(lines[i])) {
      end = i;
      break;
    }
  }
  for (const [field, value] of Object.entries(fields)) {
    const at = lines.slice(start + 1, end).findIndex((l) => l.startsWith(`${field}:`));
    if (at === -1) throw new Error(`PR ${pr}'s block in ${docName} has no "${field}:" line.`);
    lines[start + 1 + at] = `${field}: ${value}`;
  }
  return lines.join("\n");
}

function main() {
  try {
    const { pr, fields } = parseArgs(process.argv.slice(2));
    const rel = kitConfig(ROOT).queue_doc;
    const file = path.join(ROOT, rel);
    if (!existsSync(file)) throw new Error(`${rel} does not exist.`);
    writeFileSync(file, recordPr(readFileSync(file, "utf8"), pr, fields, rel));
    console.log(`record-pr: PR ${pr} updated in ${rel} — ${Object.keys(fields).join(", ")}.`);
    return 0;
  } catch (err) {
    console.error(`record-pr: FAILED — ${err.message}`);
    return 1;
  }
}

function isMainModule() {
  if (!process.argv[1]) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
  } catch {
    return false;
  }
}

if (isMainModule()) process.exit(main());
