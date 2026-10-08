// Shared leak sweep and mutant-ran marker (T50 Amendment A1, AP10; semantics of
// T53 spec AP2 and R3).
//
// assertNoTokenLeak(run, token, { allowStubBody, allowStdout, allowFixerStdin })
// searches, in four forms (raw, JSON-escaped, base64 in all three byte
// alignments, URL-encoded), every surface a secret could leave through:
//   argv, stdout, stderr, prompts.argv, prompts.stdin, requests.body  (capture fields)
//   env.<mock>.<NAME>   the recorded child env (ctx.records(name)[i].env)
//   ledger              the --findings-ledger file named by argv (default
//                       .adlc/findings.jsonl in the repo)
//   file:<root>/<rel>   every file under the run's temp HOME, repo, mocksDir and
//                       TMPDIR that is NEW or CHANGED versus the (path, sha256)
//                       snapshot runCli took before spawning (so planted inputs
//                       are excluded); the whole .git directory is excluded.
// It throws `token leaked: surface=<surface> form=<form>` on the first hit.
//   allowStubBody    skips requests.body (every other surface is still checked,
//                    so the token may appear ONLY in stub request bodies);
//   allowStdout      skips stdout (--prompt-only prints the raw prompt by design);
//   allowFixerStdin  skips the stdin of fixer invocations (a stdin that starts
//                    with buildFixPrompt's fixed first line).
//
// assertMutantRan(run, negId) asserts `PARITY-MUTANT-RAN:<negId>` is on stderr.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { countAssertion } from "./rows.mjs";
import { listMocks, readMockRecords } from "./mock-cli.mjs";

export const SWEPT_ROOTS = Object.freeze(["home", "repo", "mocks", "tmp"]);
const FIX_PROMPT_START = "You are a code fixer.";

// The substrings to search for. base64-<k> is the part of base64(<k bytes> +
// token) determined by the token bytes alone, so it matches the token at any
// byte offset k (mod 3) inside a larger encoded blob.
export function tokenForms(token) {
  const bytes = Buffer.from(String(token), "utf8");
  if (bytes.length < 6) throw new Error("assertNoTokenLeak: token must be at least 6 bytes");
  const forms = {
    raw: String(token),
    "json-escaped": JSON.stringify(String(token)).slice(1, -1)
  };
  for (const k of [0, 1, 2]) {
    const enc = Buffer.concat([Buffer.alloc(k), bytes]).toString("base64");
    const len = k + bytes.length;
    forms[`base64-${k}`] = enc.slice(Math.ceil((8 * k) / 6), Math.floor((8 * len) / 6));
  }
  forms["url-encoded"] = encodeURIComponent(String(token));
  return forms;
}

function walk(root, rel, out) {
  let ents;
  try { ents = fs.readdirSync(path.join(root, rel), { withFileTypes: true }); } catch { return out; }
  for (const ent of ents) {
    if (ent.name === ".git") continue;
    const r = rel ? `${rel}/${ent.name}` : ent.name;
    if (ent.isDirectory()) walk(root, r, out);
    else if (ent.isFile()) out.set(r, crypto.createHash("sha256").update(fs.readFileSync(path.join(root, r))).digest("hex"));
  }
  return out;
}

// { rootName: Map(relPath -> sha256) } for the swept roots of a run.
export function snapshotRoots(roots) {
  const snap = {};
  for (const name of SWEPT_ROOTS) if (roots[name]) snap[name] = walk(roots[name], "", new Map());
  return snap;
}

function ledgerPath(run) {
  const args = run.args ?? [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--findings-ledger") {
      const next = args[i + 1];
      return next && !next.startsWith("-") ? next : ".adlc/findings.jsonl";
    }
    if (a.startsWith("--findings-ledger=")) return a.slice("--findings-ledger=".length) || ".adlc/findings.jsonl";
  }
  return null;
}

function* surfaces(run, opts) {
  for (const a of run.args ?? []) yield ["argv", a];
  if (!opts.allowStdout) yield ["stdout", run.stdout ?? ""];
  yield ["stderr", run.stderr ?? ""];
  for (const p of run.prompts ?? []) {
    for (const a of p.argv ?? []) yield ["prompts.argv", a];
    const isFix = String(p.stdin ?? "").startsWith(FIX_PROMPT_START);
    if (!(opts.allowFixerStdin && isFix)) yield ["prompts.stdin", p.stdin ?? ""];
  }
  if (!opts.allowStubBody) for (const r of run.requests ?? []) yield ["requests.body", typeof r.body === "string" ? r.body : JSON.stringify(r.body)];
  const ctx = run.ctx;
  if (ctx?.recordsDir) {
    for (const name of listMocks(ctx.recordsDir)) {
      for (const rec of readMockRecords(ctx.recordsDir, name)) {
        for (const [k, v] of Object.entries(rec.env)) yield [`env.${name}.${k}`, v];
      }
    }
  }
  const lp = ledgerPath(run);
  if (lp) {
    const abs = path.isAbsolute(lp) ? lp : path.join(run.roots?.repo ?? ".", lp);
    if (fs.existsSync(abs)) yield ["ledger", fs.readFileSync(abs, "latin1") + "\n" + fs.readFileSync(abs, "utf8")];
  }
  const before = run.leakSnapshot;
  if (before && run.roots) {
    for (const name of SWEPT_ROOTS) {
      const root = run.roots[name];
      if (!root) continue;
      const after = walk(root, "", new Map());
      for (const [rel, sha] of after) {
        if (before[name]?.get(rel) === sha) continue;
        const buf = fs.readFileSync(path.join(root, rel));
        yield [`file:${name}/${rel}`, buf.toString("utf8") + "\n" + buf.toString("latin1")];
      }
    }
  }
}

export function assertNoTokenLeak(run, token, opts = {}) {
  countAssertion();
  if (!run.leakSnapshot) throw new Error("assertNoTokenLeak: run has no pre-run snapshot (use runCli)");
  const forms = Object.entries(tokenForms(token));
  for (const [surface, text] of surfaces(run, opts)) {
    for (const [form, needle] of forms) {
      if (String(text).includes(needle)) throw new Error(`token leaked: surface=${surface} form=${form}`);
    }
  }
}

export function assertMutantRan(run, negId) {
  countAssertion();
  const marker = `PARITY-MUTANT-RAN:${negId}`;
  const re = new RegExp(`${marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![A-Za-z0-9_-])`);
  if (!re.test(run.stderr ?? "")) throw new Error(`mutant did not run: ${marker} is not on stderr`);
}
