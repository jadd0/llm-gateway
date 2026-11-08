#!/usr/bin/env node
// product-kit gate-stamp.mjs v1 — from umbo 0f95e4fa
//
// A passing gate leaves a stamp, so the same tree is never gated twice.
//
// The builder runs the full gate before handing back; the coordinator then runs verify-pr on the
// same worktree. When nothing changed in between (no commit, no edit, main not moved), the second
// gate proves nothing the first did not. verify-pr reads the stamp and skips the gate only when
// the fingerprint below matches exactly.
//
// The fingerprint is content, not history: the tree hash of HEAD (an amend that leaves the content
// identical still matches; a merge of a moved main does not), plus the untracked inputs the gate
// reads, listed in .product/config.md § Kit `gate_inputs` (default `.env.local`, plus
// `node_modules/.package-lock.json` under `stack: node`, which every install rewrites). A dirty
// working tree never produces a stamp and never matches one, so an edit made while a gate ran
// cannot be blessed by it.
//
// Usage (gate.sh only):
//   node scripts/gate-stamp.mjs begin   — removes any old stamp, records the starting fingerprint
//   node scripts/gate-stamp.mjs pass    — writes the stamp if the fingerprint is unchanged and clean
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { kitConfig } from "./kit-config.mjs";

export const LOG_DIR = "gate-logs";
export const STAMP_FILE = "pass.json";
const BEGIN_FILE = "stamp-begin.json";

function hashFile(file) {
  if (!existsSync(file)) return "absent";
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

function git(root, args) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
}

/** The current state of the worktree at `root`, as the stamp compares it. */
export function currentFingerprint(root) {
  const inputs = {};
  for (const rel of kitConfig(root).gate_inputs) inputs[rel] = hashFile(path.join(root, rel));
  return {
    tree: git(root, ["rev-parse", "HEAD^{tree}"]),
    head: git(root, ["rev-parse", "HEAD"]),
    clean: git(root, ["status", "--porcelain"]) === "",
    inputs,
  };
}

/** Whether two `inputs` maps name the same files with the same hashes; returns the first difference. */
function inputsDiffer(a, b) {
  const keys = new Set([...Object.keys(a ?? {}), ...Object.keys(b ?? {})]);
  for (const k of keys) if ((a ?? {})[k] !== (b ?? {})[k]) return k;
  return null;
}

/**
 * Whether a stamp proves the current state. Pure. `head` is reported but not compared: the tree is
 * the content, and a commit that only rewords a message leaves it alone.
 */
export function stampMatches(stamp, current) {
  if (!stamp || typeof stamp !== "object") return { ok: false, reason: "no stamp" };
  if (!current.clean) return { ok: false, reason: "the working tree has uncommitted changes" };
  if (stamp.clean !== true) return { ok: false, reason: "the stamp was cut from a dirty tree" };
  if (typeof stamp.tree !== "string" || stamp.tree !== current.tree) return { ok: false, reason: "tree changed since the passing gate" };
  const changed = inputsDiffer(stamp.inputs, current.inputs);
  if (changed) return { ok: false, reason: `${changed} changed since the passing gate` };
  return { ok: true, reason: `tree and ${Object.keys(current.inputs).join(", ") || "no untracked inputs"} match the passing gate` };
}

export function readStamp(root) {
  const file = path.join(root, LOG_DIR, STAMP_FILE);
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function sameFingerprint(a, b) {
  return a.tree === b.tree && a.clean === b.clean && inputsDiffer(a.inputs, b.inputs) === null;
}

function main(argv, root) {
  const dir = path.join(root, LOG_DIR);
  mkdirSync(dir, { recursive: true });
  const beginFile = path.join(dir, BEGIN_FILE);
  const stampFile = path.join(dir, STAMP_FILE);

  if (argv[0] === "begin") {
    rmSync(stampFile, { force: true });
    writeFileSync(beginFile, `${JSON.stringify(currentFingerprint(root), null, 2)}\n`);
    return 0;
  }
  if (argv[0] === "pass") {
    if (!existsSync(beginFile)) {
      console.log("gate-stamp: no starting fingerprint; no stamp written.");
      return 0;
    }
    const began = JSON.parse(readFileSync(beginFile, "utf8"));
    rmSync(beginFile, { force: true });
    const now = currentFingerprint(root);
    if (!began.clean || !sameFingerprint(began, now)) {
      console.log("gate-stamp: the tree was dirty or changed while the gate ran; no stamp written, the next verify re-runs the gate.");
      return 0;
    }
    writeFileSync(stampFile, `${JSON.stringify({ ...now, passedAt: new Date().toISOString() }, null, 2)}\n`);
    console.log(`gate-stamp: stamp written for tree ${now.tree.slice(0, 12)} (HEAD ${now.head.slice(0, 12)}).`);
    return 0;
  }
  console.error("Usage: node scripts/gate-stamp.mjs (begin|pass)");
  return 2;
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
  const root = git(process.cwd(), ["rev-parse", "--show-toplevel"]);
  process.exitCode = main(process.argv.slice(2), root);
}
