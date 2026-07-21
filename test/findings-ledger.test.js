import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { toLedgerEntries, appendLedger } from "../src/findings-ledger.js";
import { deriveVerdict } from "../src/review.js";

function finding(overrides = {}) {
  return {
    severity: "high", category: "security", title: "SQL injection in builder",
    body: "b", exploit_scenario: "e", evidence: "", file: "src/db.js",
    line_start: 10, line_end: 12, confidence: 0.9, recommendation: "fix",
    ...overrides
  };
}
function result(findings) {
  return {
    verdict: "needs-attention", summary: "s",
    coverage: { files_examined: [], files_skipped: [] },
    findings, next_steps: []
  };
}

test("AC2: toLedgerEntries records only gating findings, with the canonical fields", () => {
  const r = result([
    finding({ severity: "high", confidence: 0.9, title: "Gating one" }),       // gates
    finding({ severity: "low", confidence: 0.9, title: "Below severity" }),     // below --fail-on
    finding({ severity: "high", confidence: 0.2, title: "Below confidence" })   // below --min-confidence
  ]);
  const entries = toLedgerEntries(r, null, { failOn: "medium", minConfidence: 0.5, ts: "2026-01-01T00:00:00.000Z" });

  assert.equal(entries.length, 1, "only the gating finding is recorded");
  assert.deepEqual(entries[0], {
    ts: "2026-01-01T00:00:00.000Z",
    tool: "adversarial-review",
    file: "src/db.js",
    line: 10,
    category: "security",
    severity: "high",
    desc: "Gating one"
  });
});

test("AC2: grounded effectiveConfidence (assessments) is used, not raw confidence", () => {
  const r = result([finding({ severity: "high", confidence: 0.9, title: "Ungrounded" })]);
  const assessments = [{ notes: ["ungrounded"], effectiveConfidence: 0.4 }]; // halved below floor
  const entries = toLedgerEntries(r, assessments, { failOn: "medium", minConfidence: 0.5, ts: "T" });
  assert.equal(entries.length, 0, "ungrounded finding (effectiveConfidence below floor) is not recorded");
});

test("AC8: the ledger set equals the gate set (shared predicate, R1)", () => {
  const r = result([
    finding({ severity: "critical", confidence: 0.95, title: "A" }),
    finding({ severity: "medium", confidence: 0.6, title: "B" }),
    finding({ severity: "low", confidence: 0.99, title: "C" }),
    finding({ severity: "high", confidence: 0.3, title: "D" })
  ]);
  const opts = { failOn: "medium", minConfidence: 0.5 };
  const ledgerTitles = toLedgerEntries(r, null, { ...opts, ts: "T" }).map((e) => e.desc).sort();
  const gateCount = deriveVerdict(r, null, opts).gatingCount;
  assert.equal(ledgerTitles.length, gateCount, "ledger entry count == gating count");
  assert.deepEqual(ledgerTitles, ["A", "B"], "exactly the findings that gate");
});

test("toLedgerEntries returns [] for an all-approve result", () => {
  const r = result([finding({ severity: "low", confidence: 0.9 })]);
  assert.deepEqual(toLedgerEntries(r, null, { failOn: "medium", minConfidence: 0.5, ts: "T" }), []);
});

test("confidence exactly at the floor GATES (>= boundary, in both gate and ledger)", () => {
  // Pins the `>=` boundary so a regression to `>` (which would silently drop
  // boundary findings from BOTH the exit code and the ledger) is caught.
  const r = result([finding({ severity: "high", confidence: 0.5, title: "Boundary" })]);
  const opts = { failOn: "medium", minConfidence: 0.5 };
  assert.equal(deriveVerdict(r, null, opts).gatingCount, 1, "0.5 >= 0.5 must gate");
  const entries = toLedgerEntries(r, null, { ...opts, ts: "T" });
  assert.equal(entries.length, 1, "boundary finding must be recorded");
  assert.equal(entries[0].desc, "Boundary");
});

test("appendLedger is a no-op for an empty entry list (creates nothing)", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "adv-ledger-empty-"));
  const ledger = path.join(dir, "nested", "findings.jsonl");
  try {
    appendLedger(ledger, []);
    assert.equal(fs.existsSync(ledger), false, "no file written");
    assert.equal(fs.existsSync(path.dirname(ledger)), false, "no parent dir created for zero entries");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("appendLedger creates a missing nested parent directory (mkdir -p)", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "adv-ledger-mkdir-"));
  const ledger = path.join(dir, "deep", "nested", "findings.jsonl");
  try {
    appendLedger(ledger, [{ ts: "T", tool: "adversarial-review", file: "a", line: 1, category: "security", severity: "high", desc: "x" }]);
    assert.equal(fs.existsSync(ledger), true, "ledger created in a freshly-made nested dir");
    assert.equal(fs.readFileSync(ledger, "utf8").trim().split("\n").length, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("T14 AC8: the ledger dir is created 0700 and the file 0600", { skip: process.platform === "win32" }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "adv-ledger-mode-"));
  try {
    const ledger = path.join(root, "nested", "findings.jsonl");
    appendLedger(ledger, [{ id: "a" }]);
    assert.equal(fs.statSync(path.dirname(ledger)).mode & 0o777, 0o700, "directory must be owner-only");
    assert.equal(fs.statSync(ledger).mode & 0o777, 0o600, "file must be owner-only");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("T14 AC9: appending again does not loosen the mode", { skip: process.platform === "win32" }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "adv-ledger-mode2-"));
  try {
    const ledger = path.join(root, "findings.jsonl");
    appendLedger(ledger, [{ id: "a" }]);
    appendLedger(ledger, [{ id: "b" }]);
    assert.equal(fs.statSync(ledger).mode & 0o777, 0o600);
    assert.equal(fs.readFileSync(ledger, "utf8").trim().split("\n").length, 2, "both entries present");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("T14: an existing permissive ledger is hardened on the next append", { skip: process.platform === "win32" }, () => {
  // { mode } is honored only at creation, so a ledger written before this
  // change keeps its umask default (commonly 0644) forever — and those are
  // exactly the ones already holding quoted repository source.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "adv-ledger-legacy-"));
  try {
    const ledger = path.join(root, "findings.jsonl");
    fs.writeFileSync(ledger, "", { mode: 0o644 });
    fs.chmodSync(ledger, 0o644);
    assert.equal(fs.statSync(ledger).mode & 0o777, 0o644, "precondition: permissive");
    appendLedger(ledger, [{ id: "a" }]);
    assert.equal(fs.statSync(ledger).mode & 0o777, 0o600, "must be tightened, not left as found");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("T14: a symlinked ledger path is refused, not written through", { skip: process.platform === "win32" }, () => {
  // The default ledger lives INSIDE the reviewed repository, so its final
  // component is attacker-controlled. Path-based append + chmod follow
  // symlinks: a repo pre-creating .adlc/findings.jsonl as a symlink got our
  // JSON appended to the target AND that target chmod-ed to 0600 — an arbitrary
  // write plus a permission change on a file we never meant to touch. The
  // hardening made it worse before this fix, since it added the chmod.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "adv-ledger-symlink-"));
  try {
    const victim = path.join(root, "victim.txt");
    fs.writeFileSync(victim, "important\n");
    fs.chmodSync(victim, 0o644);
    const ledger = path.join(root, "findings.jsonl");
    fs.symlinkSync(victim, ledger);

    assert.throws(() => appendLedger(ledger, [{ id: "x" }]), /symbolic link/i);
    assert.equal(fs.readFileSync(victim, "utf8"), "important\n", "victim must not be written");
    assert.equal(fs.statSync(victim).mode & 0o777, 0o644, "victim mode must not be changed");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("T14: a symlinked ledger LEAF is refused on every platform (not just via O_NOFOLLOW)", () => {
  // O_NOFOLLOW guards the leaf on POSIX but is unavailable (0) on Windows, so
  // the portable lstat leaf-check must catch it regardless of platform.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "adv-ledger-leaf-"));
  const realRoot = fs.realpathSync(root);
  const cwd = process.cwd();
  try {
    process.chdir(realRoot);
    const victim = path.join(realRoot, "victim.txt");
    fs.writeFileSync(victim, "important\n");
    const ledger = path.join(realRoot, ".adlc", "findings.jsonl");
    fs.mkdirSync(path.dirname(ledger), { recursive: true });
    fs.symlinkSync(victim, ledger);
    assert.throws(() => appendLedger(ledger, [{ id: "x" }]), /symbolic link/i);
    assert.equal(fs.readFileSync(victim, "utf8"), "important\n", "victim untouched");
  } finally {
    process.chdir(cwd);
    fs.rmSync(root, { recursive: true, force: true });
  }
});
