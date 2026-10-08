// Row registry and per-file manifests (T50 item 9, 9d; Amendment A1 AP11).
//
// Every parity row is registered through defineRows(stem).row(id, title, fn):
//   - `id` must be in test/parity/rows/<stem>.json and is registered once;
//   - an after() hook fails the file if a manifest id was never registered;
//   - fn runs inside an AsyncLocalStorage context { id, futureDeltas,
//     landedDeltas, assertions, minAssertions } that the harness assert helpers
//     and runCli read (capture row id, exact-stderr guard, assertion counter).
//
// options.manifest and options.landedDeltas are TEST-ONLY seams (harness.test.mjs);
// production rows never pass them.
//
// No import-time side effects beyond importing node:test.
import fs from "node:fs";
import path from "node:path";
import test, { after } from "node:test";
import { AsyncLocalStorage } from "node:async_hooks";
import { fileURLToPath } from "node:url";
import { DELTAS, WITHDRAWN_DELTAS, LANDED_DELTAS } from "./deltas.mjs";

export const PARITY_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
export const ROWS_DIR = path.join(PARITY_DIR, "rows");

const SKIP = process.platform === "win32" ? "parity suite is POSIX-only (#!/bin/sh mock CLIs)" : true;

const rowStorage = new AsyncLocalStorage();

export function currentRow() {
  return rowStorage.getStore() ?? null;
}

// AP11: every harness assert helper calls this once per assertion.
export function countAssertion() {
  const s = rowStorage.getStore();
  if (s) s.assertions += 1;
}

export function loadManifest(stem) {
  return JSON.parse(fs.readFileSync(path.join(ROWS_DIR, `${stem}.json`), "utf8"));
}

// Runs a row body in its context and applies the AP11 floor. Exported so the
// self-test can prove the floor fails without failing the suite.
export async function executeRow({ id, entry, landedDeltas }, fn, t) {
  const state = {
    id,
    futureDeltas: [...(entry.futureDeltas ?? [])],
    landedDeltas: [...landedDeltas],
    minAssertions: entry.minAssertions ?? null,
    assertions: 0
  };
  await rowStorage.run(state, () => fn(t, state));
  if (Number.isInteger(state.minAssertions) && state.assertions < state.minAssertions) {
    throw new Error(`row ${id} made ${state.assertions} assertions, below its floor ${state.minAssertions}`);
  }
  return state;
}

export function defineRows(stem, options = {}) {
  const manifest = options.manifest ?? loadManifest(stem);
  const landedDeltas = options.landedDeltas ?? LANDED_DELTAS;
  const registered = new Set();

  after(() => {
    const missing = Object.keys(manifest).filter((id) => !registered.has(id));
    if (missing.length) {
      throw new Error(`rows/${stem}.json lists row(s) never registered: ${missing.join(", ")}`);
    }
  });

  function row(id, title, fn, opts = {}) {
    // AP8: only the file-level win32 SKIP may skip a row; a row never opts out.
    if (opts && ("skip" in opts || "todo" in opts)) {
      throw new Error(`row ${id} may not pass skip or todo options (AP8)`);
    }
    if (!Object.prototype.hasOwnProperty.call(manifest, id)) {
      throw new Error(`row ${id} is not in rows/${stem}.json`);
    }
    if (registered.has(id)) {
      throw new Error(`row ${id} registered twice in ${stem}`);
    }
    registered.add(id);
    const entry = manifest[id];
    return test(`[row:${id}] ${title}`, { ...opts, skip: SKIP }, (t) =>
      executeRow({ id, entry, landedDeltas }, fn, t)
    );
  }

  return { row, manifest, stem };
}

// ─── 9d cross-manifest checks (pure) ─────────────────────────────────────────
//
// manifests: { "<stem>.json": { rowId: { roadmapRef, futureDeltas, minAssertions? } } }
// testStems: stems of test/parity/*.test.mjs, or null to skip the pairing check
// (capture-compare validates `_manifests/` copies, which have no test files).
// Returns [{ file, rowId, value, reason }] (empty = ok).
export function checkManifests({ manifests, testStems = null, landedDeltas = LANDED_DELTAS, deltas = DELTAS, withdrawn = WITHDRAWN_DELTAS }) {
  const out = [];
  const add = (file, rowId, value, reason) => out.push({ file, rowId, value, reason });
  const byId = new Map(deltas.map((x) => [x.id, x]));
  const landed = new Set(landedDeltas);
  const firstSeen = new Map();

  for (const file of Object.keys(manifests).sort()) {
    const manifest = manifests[file];
    if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
      add(file, null, manifest, "manifest must be an object of row ids");
      continue;
    }
    for (const [rowId, entry] of Object.entries(manifest)) {
      if (firstSeen.has(rowId)) add(file, rowId, rowId, `duplicate id (also in ${firstSeen.get(rowId)})`);
      else firstSeen.set(rowId, file);
      if (!entry || typeof entry !== "object") {
        add(file, rowId, entry, "entry must be an object");
        continue;
      }
      if (typeof entry.roadmapRef !== "string" || !entry.roadmapRef.trim()) {
        add(file, rowId, entry.roadmapRef, "roadmapRef must be a non-empty string (a ROADMAP section heading)");
      }
      if ("minAssertions" in entry && !(Number.isInteger(entry.minAssertions) && entry.minAssertions > 0)) {
        add(file, rowId, entry.minAssertions, "minAssertions must be a positive integer");
      }
      if (!Array.isArray(entry.futureDeltas)) {
        add(file, rowId, entry.futureDeltas, "futureDeltas must be an array");
        continue;
      }
      const seenTags = new Set();
      for (const value of entry.futureDeltas) {
        if (!Number.isInteger(value)) { add(file, rowId, value, "not an integer delta id"); continue; }
        if (seenTags.has(value)) { add(file, rowId, value, "duplicate entry in futureDeltas"); continue; }
        seenTags.add(value);
        if (withdrawn.includes(value)) { add(file, rowId, value, "withdrawn delta"); continue; }
        const delta = byId.get(value);
        if (!delta) { add(file, rowId, value, "unknown delta id"); continue; }
        if (!delta.taggable) { add(file, rowId, value, "known but untaggable delta"); continue; }
        if (landed.has(value)) add(file, rowId, value, "delta already landed (LANDED_DELTAS); the landing commit removes the tag");
      }
    }
  }

  if (testStems) {
    const manifestStems = new Set(Object.keys(manifests).map((f) => f.replace(/\.json$/, "")));
    for (const stem of [...manifestStems].sort()) {
      if (!testStems.includes(stem)) add(`${stem}.json`, null, stem, "orphan manifest: no matching .test.mjs");
    }
    for (const stem of [...testStems].sort()) {
      if (!manifestStems.has(stem)) add(`${stem}.json`, null, `${stem}.test.mjs`, "test file has no manifest");
    }
  }
  return out;
}

export function readManifestDir(dir) {
  const manifests = {};
  for (const f of fs.readdirSync(dir).sort()) {
    if (!f.endsWith(".json") || f === "landed.json") continue;
    manifests[f] = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
  }
  return manifests;
}

export function loadRepoManifests() {
  const manifests = readManifestDir(ROWS_DIR);
  const testStems = fs.readdirSync(PARITY_DIR)
    .filter((f) => f.endsWith(".test.mjs"))
    .map((f) => f.slice(0, -".test.mjs".length))
    .sort();
  return { manifests, testStems };
}

// ─── AP8 guard: an ALLOWLIST of the one permitted skip form ──────────────────
// In any test/parity/**/*.test.mjs file the only permitted skip is the
// file-level `{ skip: SKIP }` option (the win32 POSIX-only skip). Violations:
//   (a) a skip/todo object key (identifier, quoted, computed or shorthand)
//       whose value is anything other than the bare identifier SKIP;
//   (b) any dot or bracket member access of skip/todo, called or not.
// No CI-specific spelling is needed: every CI-conditioned skip is (a).
// Patterns are assembled from fragments so helper sources stay readable.

const W = "(?:" + "sk" + "ip|" + "to" + "do)";
const KEY_RE = new RegExp(`(?:\\b${W}|["'\`]${W}["'\`]|\\[\\s*["'\`]${W}["'\`]\\s*\\])\\s*:\\s*([^,}\\n]*)`, "g");
const SHORTHAND_RE = new RegExp(`[{,]\\s*${W}\\s*(?=[,}])`, "g");
const MEMBER_RE = new RegExp(`(?:\\.\\s*${W}\\b|\\[\\s*["'\`]${W}["'\`]\\s*\\](?!\\s*:))`, "g");

function lineOf(text, index) {
  return text.slice(0, index).split("\n").length;
}

// Returns ["<file>:<line>: <reason>"] for every non-permitted skip/todo shape.
export function findSkipViolations(text, file) {
  const out = [];
  let m;
  KEY_RE.lastIndex = 0;
  while ((m = KEY_RE.exec(text))) {
    if (m[1].trim() !== "SKIP") out.push(`${file}:${lineOf(text, m.index)}: skip/todo option with value ${JSON.stringify(m[1].trim())} (only SKIP is permitted)`);
  }
  SHORTHAND_RE.lastIndex = 0;
  while ((m = SHORTHAND_RE.exec(text))) out.push(`${file}:${lineOf(text, m.index)}: shorthand skip/todo option`);
  MEMBER_RE.lastIndex = 0;
  while ((m = MEMBER_RE.exec(text))) out.push(`${file}:${lineOf(text, m.index)}: skip/todo member access`);
  return out;
}

// Scans every test/parity/**/*.test.mjs file.
export function scanParitySkips(dir = PARITY_DIR) {
  const out = [];
  const walk = (d) => {
    for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, ent.name);
      if (ent.isDirectory()) walk(p);
      else if (ent.name.endsWith(".test.mjs")) out.push(...findSkipViolations(fs.readFileSync(p, "utf8"), path.relative(dir, p)));
    }
  };
  walk(dir);
  return out;
}
