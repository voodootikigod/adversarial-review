import assert from "node:assert/strict";
import test from "node:test";
import { toLedgerEntries } from "../src/findings-ledger.js";
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
