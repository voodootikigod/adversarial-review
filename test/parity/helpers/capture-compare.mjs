#!/usr/bin/env node
// capture-compare: the parity behavior-diff tool (T50 item 11; AP1, AP2, AP3, AP5).
//
// USAGE
//   capture-compare.mjs <baseDir> <headDir> [--delta <n>]
//                       [--allow <id,id,...> --allow-reason "<text>"]
//                       [--no-normalize <n1,...>]          (TEST-ONLY switch)
//   capture-compare.mjs --cross-node --field <field> [--require-row <id>]... <node24Dir> <legDir>
//   capture-compare.mjs --print-normalized <capture.json>
// With NO arguments (as `node --test` discovery runs it) it exits 0 silently.
// Any other malformed argument list exits 2 with a usage line on stderr.
//
// EXIT CODES: 0 every row present in both trees matches (or is allowed /
// tagged / envelope-only); 1 at least one row differs or a BASE row is missing
// from HEAD; 2 usage error, invalid manifests in either tree's `_manifests/`
// (9d checks, each tree with its own `_manifests/landed.json`), a capture
// without a `node` field, a Node-MAJOR mismatch between paired BASE and HEAD
// captures (waived only by --cross-node), an unknown envelope kind, or an
// --allow that is missing --allow-reason or names a row tagged for --delta.
//
// COMPARED FIELDS: argv, code, stdout, stderr, gitState, calls, prompts,
// requests. Metadata never compared: roots, ports, envKeys, preResolution, node.
// Captures pair by (rowId, n). A row only in HEAD is reported `NEW row <id>`
// and allowed; a row only in BASE fails (`REMOVED row <id>`) unless --allow'd.
//
// NORMALIZATION (applied here at compare time, with each capture's OWN roots
// and ports; captures store raw values). n1-n5 apply to every string leaf of
// argv, stdout, stderr, gitState, prompts and requests; n6 to top-level stderr.
//   n1  each recorded temp root (repo, mocks, sysbin, home, xdg, tmp,
//       configDir) -> <repo> <mocks> <sysbin> <home> <xdg> <tmp> <configDir>;
//       a path that is not one of THAT run's roots stays raw.
//   n2  the stub port, where it follows a colon -> <port>
//   n3  adversarial-review-loop-<digits> -> adversarial-review-loop-<ts>
//   n4  /(<<<(?:UNTRUSTED|END|DIRECTIVE|END_DIRECTIVE):[A-Z_]+:)[A-Za-z0-9_-]{12}(>>>)/g
//       -> $1<nonce>$2 (anywhere on a line, only directly after a fence token
//       and label)
//   n5  adversarial-review-raw-<pid>-<ms>.txt -> adversarial-review-raw-<pid>-<ts>.txt
//   n6  removes the stderr line `(node:<pid>) ExperimentalWarning: The Fetch API
//       is an experimental feature. This feature could change at any time` and
//       the next line only if it starts with "(Use `node --trace-warnings"
//       (Node 18/20). No other warning line is removed.
//   n7  (AP7 sweep rule) the fix-prompt finding fence nonce:
//       /(<<<(?:UNTRUSTED|END):FINDING_[0-9]+:)[A-Za-z0-9_-]{12}(>>>)/g
//       -> $1<nonce>$2. buildFixPrompt (src/loop.js) labels its fences
//       FINDING_<i>, which n4's [A-Z_]+ label class does not match; the fixer's
//       stdin is a compared `prompts` field, so without n7 every loop row that
//       runs a fixer would differ run to run.
//   n8  (AP7 sweep rule) the findings-ledger timestamp, in gitState string
//       leaves only: /"ts":"\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z"/g -> "ts":"<ts>".
//       toLedgerEntries (src/findings-ledger.js) stamps each entry with
//       new Date().toISOString(), and the default --findings-ledger path
//       (.adlc/findings.jsonl) is inside the reviewed repo, so it lands in
//       gitState.files.
//   n9  the codex private temp dir (callCodexCli mkdtemp, 6-character
//       [A-Za-z0-9] suffix observed on 2.11.1, e.g. adv-review-codex-5yWoVm):
//       /adv-review-codex-[A-Za-z0-9]{6}(?![A-Za-z0-9])/g -> adv-review-codex-<rand>,
//       in argv, stdout, stderr and prompts (the codex reviewer's own argv,
//       --output-last-message/--output-schema, is recorded in prompts[].argv).
// Nothing else is normalized. `--no-normalize n3,n4` (TEST-ONLY) disables the
// named rules, which is possible because captures keep raw values.
//
// STDOUT: a stdout that parses whole as JSON is compared whole. Otherwise NDJSON
// events (lines that parse to an object with a string `type`) pair by (type,
// ordinal within type) and are reported `INSERTED <type>#<k>`, `REMOVED
// <type>#<k>` or `DIFF <type>#<k>`, plus `DIFF event order` when the common
// events change order; other lines pair by index among themselves.
//
// --delta <n>: a row is TAGGED for n when its BASE manifest lists n, HEAD's
// `_manifests/landed.json` contains n, and its HEAD manifest no longer lists n.
// The envelope of n (DELTAS in deltas.mjs) is stripped first; a tagged row may
// then differ ONLY in delta n's `fields`, and the normalized unified diff of
// every differing field is printed for the P5 reviewer. Tags grant nothing
// without --delta. Envelopes: added-event-key (34 meta.thrash any value, 35
// meta.rotation exactly null) on paired loop_summary events; added-stderr-line
// (36) removes exactly one HEAD stderr line containing `adversarial-review
// setup` on a detecting run (argv not exempt, no preResolution) when BASE has no
// such line.
//
// --cross-node: a row present in only one tree prints `MISSING <rowId> in
// <BASE|HEAD>` and exits 1, and a run that compared zero rows prints
// `cross-node compared 0 rows` and exits 1, so an empty or misnamed capture
// can never pass. --require-row <id> (repeatable, any mode) exits 1 with
// `MISSING <id> in <BASE|HEAD>` unless the row is present in both trees.
//
// --allow <ids> requires --allow-reason (one reason covers all ids), prints
// `ALLOWED <rowId>: <reason>` for each allowed differing row, and is refused
// (exit 2) for a row tagged for the active --delta.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const USAGE =
  "usage: capture-compare <baseDir> <headDir> [--delta <n>] [--allow <ids> --allow-reason <text>] [--no-normalize <rules>]\n" +
  "       capture-compare --cross-node --field <field> [--require-row <id>]... <baseDir> <headDir>\n" +
  "       capture-compare --print-normalized <capture.json>";

export const COMPARED_FIELDS = ["argv", "code", "stdout", "stderr", "gitState", "calls", "prompts", "requests"];
const RULES = ["n1", "n2", "n3", "n4", "n5", "n6", "n7", "n8", "n9"];

class UsageError extends Error {}
class FatalError extends Error {}

// ─── normalization ───────────────────────────────────────────────────────────

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function makeStringNormalizer(cap, disabled) {
  const roots = Object.entries(cap.roots ?? {})
    .filter(([, p]) => typeof p === "string" && p.length > 1)
    .sort((a, b) => b[1].length - a[1].length)
    .map(([name, p]) => [new RegExp(escapeRe(p) + "(?![A-Za-z0-9_-])", "g"), `<${name}>`]);
  const ports = (cap.ports ?? []).map((p) => new RegExp(`(?<=:)${p}(?![0-9])`, "g"));
  return (s) => {
    let out = s;
    if (!disabled.has("n1")) for (const [re, tok] of roots) out = out.replace(re, tok);
    if (!disabled.has("n2")) for (const re of ports) out = out.replace(re, "<port>");
    if (!disabled.has("n3")) out = out.replace(/adversarial-review-loop-\d+/g, "adversarial-review-loop-<ts>");
    if (!disabled.has("n4")) out = out.replace(/(<<<(?:UNTRUSTED|END|DIRECTIVE|END_DIRECTIVE):[A-Z_]+:)[A-Za-z0-9_-]{12}(>>>)/g, "$1<nonce>$2");
    if (!disabled.has("n7")) out = out.replace(/(<<<(?:UNTRUSTED|END):FINDING_[0-9]+:)[A-Za-z0-9_-]{12}(>>>)/g, "$1<nonce>$2");
    if (!disabled.has("n5")) out = out.replace(/adversarial-review-raw-\d+-\d+\.txt/g, "adversarial-review-raw-<pid>-<ts>.txt");
    return out;
  };
}

function mapStrings(v, f) {
  if (typeof v === "string") return f(v);
  if (Array.isArray(v)) return v.map((x) => mapStrings(x, f));
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, mapStrings(x, f)]));
  return v;
}

const N6_WARNING = /^\(node:\d+\) ExperimentalWarning: The Fetch API is an experimental feature\. This feature could change at any time$/;

function applyN6(stderr) {
  const lines = stderr.split("\n");
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    if (N6_WARNING.test(lines[i])) {
      if (i + 1 < lines.length && lines[i + 1].startsWith("(Use `node --trace-warnings")) i++;
      continue;
    }
    out.push(lines[i]);
  }
  return out.join("\n");
}

export function normalizeCapture(cap, disabled = new Set()) {
  const f = makeStringNormalizer(cap, disabled);
  const out = { ...cap };
  for (const k of ["argv", "stdout", "stderr", "gitState", "prompts", "requests"]) {
    if (k in cap) out[k] = mapStrings(cap[k], f);
  }
  if (typeof out.stderr === "string" && !disabled.has("n6")) out.stderr = applyN6(out.stderr);
  if (!disabled.has("n9")) {
    const n9 = (v) => v.replace(/adv-review-codex-[A-Za-z0-9]{6}(?![A-Za-z0-9])/g, "adv-review-codex-<rand>");
    for (const k of ["argv", "stdout", "stderr", "prompts"]) if (k in out) out[k] = mapStrings(out[k], n9);
  }
  if (out.gitState && !disabled.has("n8")) {
    out.gitState = mapStrings(out.gitState, (v) => v.replace(/"ts":"\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z"/g, '"ts":"<ts>"'));
  }
  return out;
}

// ─── field comparison ────────────────────────────────────────────────────────

function exemptByArgv(argv = []) {
  if (argv[0] === "setup") return true;
  return argv.includes("--prompt-only") && !argv.includes("--loop");
}

function parseEvent(line) {
  try {
    const v = JSON.parse(line);
    if (v && typeof v === "object" && !Array.isArray(v) && typeof v.type === "string") return v;
  } catch { /* not an event */ }
  return null;
}

function getPath(obj, dotted) {
  let cur = obj;
  for (const part of dotted.split(".")) {
    if (!cur || typeof cur !== "object" || !(part in cur)) return { found: false };
    cur = cur[part];
  }
  return { found: true, value: cur };
}

function deletePath(obj, dotted) {
  const parts = dotted.split(".");
  const clone = structuredClone(obj);
  const stack = [clone];
  let cur = clone;
  for (const p of parts.slice(0, -1)) { cur = cur[p]; stack.push(cur); }
  delete cur[parts.at(-1)];
  // Drop containers the envelope key leaves empty.
  for (let i = parts.length - 2; i >= 0; i--) {
    const parent = stack[i];
    const key = parts[i];
    if (parent[key] && typeof parent[key] === "object" && Object.keys(parent[key]).length === 0) delete parent[key];
    else break;
  }
  return clone;
}

function stripEventEnvelope(baseEv, headEv, env) {
  if (!env || env.kind !== "added-event-key" || headEv.type !== env.event) return headEv;
  const inHead = getPath(headEv, env.key);
  if (!inHead.found || getPath(baseEv, env.key).found) return headEv;
  if (env.value !== "any" && JSON.stringify(inHead.value) !== JSON.stringify(env.value)) return headEv;
  return deletePath(headEv, env.key);
}

function splitLines(s) {
  return s.split("\n");
}

function compareStdout(bs, hs, env) {
  if (bs === hs) return [];
  const whole = (s) => { try { JSON.parse(s); return true; } catch { return false; } };
  if (whole(bs) || whole(hs)) return ["DIFF stdout"];
  const index = (s) => {
    const events = new Map();
    const order = [];
    const plain = [];
    const counts = {};
    for (const line of splitLines(s)) {
      const ev = parseEvent(line);
      if (ev) {
        counts[ev.type] = (counts[ev.type] ?? 0) + 1;
        const key = `${ev.type}#${counts[ev.type]}`;
        events.set(key, { ev, line });
        order.push(key);
      } else {
        plain.push(line);
      }
    }
    return { events, order, plain };
  };
  const b = index(bs);
  const h = index(hs);
  const findings = [];
  const keys = [...b.order, ...h.order.filter((k) => !b.events.has(k))];
  for (const key of keys) {
    const be = b.events.get(key);
    const he = h.events.get(key);
    if (be && !he) { findings.push(`REMOVED ${key}`); continue; }
    if (!be && he) { findings.push(`INSERTED ${key}`); continue; }
    if (be.line === he.line) continue;
    const stripped = stripEventEnvelope(be.ev, he.ev, env);
    if (stripped !== he.ev && JSON.stringify(stripped) === JSON.stringify(be.ev)) continue;
    findings.push(`DIFF ${key}`);
  }
  const common = (o, other) => o.filter((k) => other.events.has(k));
  if (JSON.stringify(common(b.order, h)) !== JSON.stringify(common(h.order, b))) findings.push("DIFF event order");
  const n = Math.max(b.plain.length, h.plain.length);
  for (let i = 0; i < n; i++) {
    if (i >= h.plain.length) findings.push(`REMOVED line#${i + 1}`);
    else if (i >= b.plain.length) findings.push(`INSERTED line#${i + 1}`);
    else if (b.plain[i] !== h.plain[i]) findings.push(`DIFF line#${i + 1}`);
  }
  return findings;
}

function compareStderr(bCap, hCap, env) {
  let bs = bCap.stderr ?? "";
  let hs = hCap.stderr ?? "";
  if (env && env.kind === "added-stderr-line") {
    const detecting = !exemptByArgv(hCap.argv) && !hCap.preResolution && !bCap.preResolution;
    if (detecting || !env.detectingOnly) {
      const bl = splitLines(bs);
      const hl = splitLines(hs);
      const hits = hl.map((l, i) => (l.includes(env.contains) ? i : -1)).filter((i) => i >= 0);
      if (!bl.some((l) => l.includes(env.contains)) && hits.length >= 1 && hits.length <= env.maxLines) {
        hs = hl.filter((_, i) => !hits.includes(i)).join("\n");
      }
    }
  }
  return bs === hs ? [] : ["DIFF stderr"];
}

function fieldText(cap, field) {
  const v = cap[field];
  if (typeof v === "string") return v;
  return JSON.stringify(v ?? null, null, 2);
}

// Minimal LCS line diff; prints only changed lines.
function unifiedDiff(a, b) {
  const x = a.split("\n");
  const y = b.split("\n");
  const m = x.length;
  const n = y.length;
  if (m * n > 4_000_000) return [...x.map((l) => `-${l}`), ...y.map((l) => `+${l}`)];
  const dp = Array.from({ length: m + 1 }, () => new Uint32Array(n + 1));
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) dp[i][j] = x[i] === y[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  }
  const out = [];
  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    if (x[i] === y[j]) { i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) out.push(`-${x[i++]}`);
    else out.push(`+${y[j++]}`);
  }
  while (i < m) out.push(`-${x[i++]}`);
  while (j < n) out.push(`+${y[j++]}`);
  return out;
}

function compareCaptures(bRaw, hRaw, { fields, env, disabled }) {
  const b = normalizeCapture(bRaw, disabled);
  const h = normalizeCapture(hRaw, disabled);
  const diffs = {};
  for (const field of fields) {
    let findings;
    if (field === "stdout") findings = compareStdout(b.stdout ?? "", h.stdout ?? "", env);
    else if (field === "stderr") findings = compareStderr(b, h, env);
    else findings = JSON.stringify(b[field] ?? null) === JSON.stringify(h[field] ?? null) ? [] : [`DIFF ${field}`];
    if (findings.length) diffs[field] = findings;
  }
  return { diffs, b, h };
}

// ─── trees ───────────────────────────────────────────────────────────────────

function readTree(dir) {
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) throw new FatalError(`not a directory: ${dir}`);
  const rows = new Map();
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!ent.isDirectory() || ent.name === "_manifests") continue;
    const files = fs.readdirSync(path.join(dir, ent.name)).filter((f) => /^\d+\.json$/.test(f))
      .sort((a, b) => parseInt(a, 10) - parseInt(b, 10));
    const caps = files.map((f) => {
      const file = path.join(dir, ent.name, f);
      let cap;
      try { cap = JSON.parse(fs.readFileSync(file, "utf8")); } catch (err) { throw new FatalError(`unreadable capture ${file}: ${err.message}`); }
      if (typeof cap.node !== "string" || !/^v\d+/.test(cap.node)) throw new FatalError(`capture ${file} has no valid \`node\` field`);
      return { n: parseInt(f, 10), file, cap };
    });
    rows.set(ent.name, caps);
  }
  return rows;
}

async function readManifests(dir, label) {
  const mdir = path.join(dir, "_manifests");
  if (!fs.existsSync(mdir)) throw new FatalError(`${label} tree has no _manifests/ directory: ${dir}`);
  const { readManifestDir, checkManifests } = await import("./rows.mjs");
  const manifests = readManifestDir(mdir);
  const landedFile = path.join(mdir, "landed.json");
  if (!fs.existsSync(landedFile)) throw new FatalError(`${label} tree has no _manifests/landed.json`);
  const landed = JSON.parse(fs.readFileSync(landedFile, "utf8"));
  if (!Array.isArray(landed)) throw new FatalError(`${label} _manifests/landed.json must be an array`);
  const violations = checkManifests({ manifests, landedDeltas: landed });
  if (violations.length) {
    throw new FatalError(violations.map((v) =>
      `invalid manifest in ${label}: ${v.file} row ${v.rowId} value ${JSON.stringify(v.value)}: ${v.reason}`).join("\n"));
  }
  const rowEntry = (id) => {
    for (const m of Object.values(manifests)) if (m && Object.prototype.hasOwnProperty.call(m, id)) return m[id];
    return null;
  };
  return { manifests, landed, rowEntry };
}

function major(v) {
  return Number(/^v(\d+)/.exec(v)[1]);
}

// ─── CLI ─────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const opts = { positional: [], allow: null, allowReason: null, delta: null, disabled: new Set(), crossNode: false, field: null, printNormalized: null, requireRows: [] };
  const takeValue = (i, flag) => {
    if (i + 1 >= argv.length) throw new UsageError(`${flag} needs a value`);
    return argv[i + 1];
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--delta") {
      const v = takeValue(i, a); i++;
      if (!/^\d+$/.test(v)) throw new UsageError(`--delta must be an integer, got ${v}`);
      opts.delta = Number(v);
    } else if (a === "--allow") {
      opts.allow = takeValue(i, a).split(",").map((s) => s.trim()).filter(Boolean); i++;
    } else if (a === "--allow-reason") {
      opts.allowReason = takeValue(i, a); i++;
    } else if (a === "--no-normalize") {
      for (const r of takeValue(i, a).split(",")) {
        if (!RULES.includes(r)) throw new UsageError(`unknown normalization rule ${r}`);
        opts.disabled.add(r);
      }
      i++;
    } else if (a === "--require-row") {
      opts.requireRows.push(takeValue(i, a)); i++;
    } else if (a === "--cross-node") {
      opts.crossNode = true;
    } else if (a === "--field") {
      opts.field = takeValue(i, a); i++;
    } else if (a === "--print-normalized") {
      opts.printNormalized = takeValue(i, a); i++;
    } else if (a.startsWith("--")) {
      throw new UsageError(`unknown option ${a}`);
    } else {
      opts.positional.push(a);
    }
  }
  if (opts.printNormalized) {
    if (opts.positional.length || opts.crossNode || opts.delta !== null || opts.allow) throw new UsageError("--print-normalized takes exactly one file");
    return opts;
  }
  if (opts.positional.length !== 2) throw new UsageError("expected <baseDir> <headDir>");
  if (opts.crossNode) {
    if (!COMPARED_FIELDS.includes(opts.field)) throw new UsageError("--cross-node needs --field <compared field>");
    if (opts.delta !== null || opts.allow) throw new UsageError("--cross-node takes no --delta/--allow");
  } else if (opts.field) {
    throw new UsageError("--field is only valid with --cross-node");
  }
  if (opts.allow && !opts.allowReason) throw new UsageError("--allow requires --allow-reason \"<text>\"");
  if (opts.allowReason && !opts.allow) throw new UsageError("--allow-reason requires --allow");
  return opts;
}

export async function main(argv, { out = (s) => process.stdout.write(s + "\n"), err = (s) => process.stderr.write(s + "\n") } = {}) {
  if (argv.length === 0) return 0;
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (e) {
    if (e instanceof UsageError) { err(`capture-compare: ${e.message}`); err(USAGE); return 2; }
    throw e;
  }
  try {
    if (opts.printNormalized) {
      const cap = JSON.parse(fs.readFileSync(opts.printNormalized, "utf8"));
      out(JSON.stringify(normalizeCapture(cap, opts.disabled), null, 2));
      return 0;
    }
    return await compareTrees(opts, out);
  } catch (e) {
    if (e instanceof FatalError) { err(`capture-compare: ${e.message}`); return 2; }
    throw e;
  }
}

async function compareTrees(opts, out) {
  const [baseDir, headDir] = opts.positional;
  const { DELTAS, ENVELOPE_KINDS } = await import("./deltas.mjs");
  let delta = null;
  if (opts.delta !== null) {
    delta = DELTAS.find((d) => d.id === opts.delta);
    if (!delta) throw new FatalError(`--delta ${opts.delta} is not a registered delta`);
    if (delta.envelope && !ENVELOPE_KINDS.includes(delta.envelope.kind)) {
      throw new FatalError(`delta ${delta.id} declares unknown envelope kind ${delta.envelope.kind}`);
    }
  }
  const baseM = opts.crossNode ? null : await readManifests(baseDir, "BASE");
  const headM = opts.crossNode ? null : await readManifests(headDir, "HEAD");
  const base = readTree(baseDir);
  const head = readTree(headDir);

  // Node-major guard, before any row comparison.
  if (!opts.crossNode) {
    for (const [id, caps] of base) {
      const hc = head.get(id) ?? [];
      for (const { n, cap } of caps) {
        const h = hc.find((x) => x.n === n);
        if (h && major(cap.node) !== major(h.cap.node)) {
          throw new FatalError(`Node major mismatch on ${id}#${n}: BASE ${cap.node} vs HEAD ${h.cap.node}`);
        }
      }
    }
  }

  const isTagged = (id) => {
    if (!delta || !baseM) return false;
    const be = baseM.rowEntry(id);
    const he = headM.rowEntry(id);
    return !!(be && be.futureDeltas.includes(delta.id) && headM.landed.includes(delta.id) && !(he && he.futureDeltas.includes(delta.id)));
  };
  const allowed = new Set(opts.allow ?? []);
  for (const id of allowed) {
    if (isTagged(id)) throw new FatalError(`--allow refused for ${id}: it is tagged for --delta ${delta.id}`);
  }

  const fields = opts.crossNode ? [opts.field] : COMPARED_FIELDS;
  const env = delta?.envelope ?? null;
  let failed = false;
  for (const id of opts.requireRows) {
    for (const [label, tree] of [["BASE", base], ["HEAD", head]]) {
      if (!tree.has(id)) { out(`MISSING ${id} in ${label}`); failed = true; }
    }
  }
  let comparedRows = 0;
  const ids = [...new Set([...base.keys(), ...head.keys()])].sort();
  for (const id of ids) {
    const bc = base.get(id);
    const hc = head.get(id);
    if (!hc) {
      if (opts.crossNode) { if (!opts.requireRows.includes(id)) out(`MISSING ${id} in HEAD`); failed = true; continue; }
      if (allowed.has(id)) out(`ALLOWED ${id}: ${opts.allowReason}`);
      else { out(`REMOVED row ${id}`); failed = true; }
      continue;
    }
    if (!bc) {
      if (opts.crossNode) { if (!opts.requireRows.includes(id)) out(`MISSING ${id} in BASE`); failed = true; continue; }
      out(`NEW row ${id}`);
      continue;
    }
    comparedRows++;
    const rowLines = [];
    let rowDiffers = false;
    let rowFails = false;
    const tagged = isTagged(id);
    const ns = [...new Set([...bc.map((x) => x.n), ...hc.map((x) => x.n)])].sort((a, b) => a - b);
    for (const n of ns) {
      const b = bc.find((x) => x.n === n);
      const h = hc.find((x) => x.n === n);
      if (!b || !h) {
        rowDiffers = true;
        rowFails = true;
        rowLines.push(`${b ? "REMOVED" : "INSERTED"} capture ${id}#${n}`);
        continue;
      }
      const { diffs, b: nb, h: nh } = compareCaptures(b.cap, h.cap, { fields, env, disabled: opts.disabled });
      const differing = Object.keys(diffs);
      if (!differing.length) continue;
      rowDiffers = true;
      if (tagged) {
        const outside = differing.filter((f) => !delta.fields.includes(f));
        if (outside.length) {
          rowFails = true;
          rowLines.push(`FAIL ${id}#${n} fields outside delta ${delta.id} scope: ${outside.join(", ")}`);
        } else {
          rowLines.push(`TAGGED ${id}#${n} delta ${delta.id}: ${differing.join(", ")}`);
        }
      } else {
        rowFails = true;
        rowLines.push(`FAIL ${id}#${n} fields: ${differing.join(", ")}`);
      }
      for (const f of differing) for (const finding of diffs[f]) rowLines.push(`  ${finding}`);
      for (const f of differing) {
        rowLines.push(`--- BASE ${id}#${n} ${f}`);
        rowLines.push(`+++ HEAD ${id}#${n} ${f}`);
        rowLines.push(...unifiedDiff(fieldText(nb, f), fieldText(nh, f)));
      }
    }
    if (!rowDiffers) continue;
    if (rowFails && allowed.has(id)) {
      out(`ALLOWED ${id}: ${opts.allowReason}`);
      continue;
    }
    for (const l of rowLines) out(l);
    if (rowFails) failed = true;
  }
  if (opts.crossNode && comparedRows === 0) {
    out("cross-node compared 0 rows");
    failed = true;
  }
  return failed ? 1 : 0;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main(process.argv.slice(2)).then(
    (code) => { process.exitCode = code; },
    (e) => { process.stderr.write(`capture-compare: ${e.stack || e.message}\n`); process.exitCode = 2; }
  );
}
