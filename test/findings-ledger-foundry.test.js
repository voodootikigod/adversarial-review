// AC5 — the produced ledger round-trips through the REAL downstream consumer
// (`adlc lesson-foundry`) without malformed-line skips, and similar findings
// cluster while dissimilar ones do not.
//
// Why this test exists when AC2/AC4/AC8 already cover the ledger: those tests
// assert OUR OWN schema understanding (field names, the gating set). They cannot
// catch a drift between what we write and what lesson-foundry actually parses and
// clusters — neither a format change on our side nor a version change on the
// consumer's side. This is the only test that feeds the production writer's
// output into the real binary, so it is an external-contract canary, not a
// substitute for the unit coverage above.
//
// adversarial-review is a standalone npm package: its CI does NOT install the
// ADLC toolkit. So this test invokes the real `adlc` binary when it is present
// (a developer machine, the ADLC pipeline, the release gate) and SKIPS — never
// fails — when `adlc` is not on PATH. Where it runs, it is fully load-bearing:
// it pins cluster membership (not just count), with a dissimilar negative control
// proving the cluster forms BECAUSE OF desc similarity, so a regression that
// dropped or renamed the `desc` clustering key fails it.
import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { toLedgerEntries, appendLedger } from "../src/findings-ledger.js";

function finding(overrides = {}) {
  return {
    severity: "high", category: "correctness", title: "t",
    body: "b", exploit_scenario: "e", evidence: "", file: "src/a.js",
    line_start: 1, line_end: 2, confidence: 0.9, recommendation: "fix",
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

// Run `adlc lesson-foundry --json` in `cwd`. Returns the parsed JSON, or null
// when the `adlc` binary is not installed (spawn ENOENT) so the caller can skip.
// A non-zero exit with output (the binary ran) is NOT treated as "absent"; a
// non-zero exit with no output rethrows so a real consumer break fails the test.
function runLessonFoundry(cwd) {
  try {
    const out = execFileSync(
      "adlc",
      ["lesson-foundry", "--ledger", "findings", "--min", "2", "--json"],
      { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }
    );
    return JSON.parse(out);
  } catch (err) {
    if (err && err.code === "ENOENT") return null; // adlc not installed
    if (err && typeof err.stdout === "string" && err.stdout.trim()) {
      return JSON.parse(err.stdout);
    }
    throw err;
  }
}

test("AC5: ledger written by the production path round-trips through real lesson-foundry", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "adv-foundry-"));
  try {
    // Three gating findings, all the same category. Entries 0 and 1 have
    // near-identical descs (they must cluster); entry 2's desc is genuinely
    // dissimilar (it must NOT join their cluster). Entry 2 is the negative
    // control: without it, ANY two parseable lines satisfy `size === 2`, even
    // ones with an empty/absent desc, so the desc clustering key would go
    // untested. With it, membership must be exactly {0,1} — which only holds
    // when clustering keys on `desc` as we expect.
    const r = result([
      finding({ category: "correctness", file: "src/auth.js", line_start: 42, title: "Missing null check on token refresh response" }),
      finding({ category: "correctness", file: "src/session.js", line_start: 17, title: "Missing null check on token refresh handler" }),
      finding({ category: "correctness", file: "src/cache.js", line_start: 88, title: "Race condition in cache eviction under concurrent writes" })
    ]);
    const entries = toLedgerEntries(r, null, { failOn: "medium", minConfidence: 0.5, ts: "2026-06-29T00:00:00.000Z" });
    assert.equal(entries.length, 3, "all three gating findings recorded (test precondition)");

    // Write via the production writer to the path lesson-foundry reads by
    // default: <cwd>/.adlc/findings.jsonl (its --ledger default is "findings").
    const ledger = path.join(dir, ".adlc", "findings.jsonl");
    appendLedger(ledger, entries);

    const out = runLessonFoundry(dir);
    if (out === null) {
      t.skip("adlc not installed — real-consumer round-trip not exercised here");
      return;
    }

    assert.equal(out.skippedMalformed, 0, "lesson-foundry skipped no lines as malformed — our JSONL is consumable");

    // Exactly one cluster (min size 2), and its members are precisely the two
    // similar findings (indices 0 and 1) — NOT the dissimilar entry 2. Pinning
    // membership (not just `size === 2`) is what makes a desc-key drift fail:
    // if `desc` were dropped/renamed, all three empty-desc entries would cluster
    // together (size 3, indices [0,1,2]) and this assertion would go RED.
    assert.equal(out.clusters.length, 1, "exactly one cluster forms from the two similar findings");
    assert.equal(out.clusters[0].size, 2, "the cluster has both similar findings and no others");
    assert.deepEqual(out.clusters[0].indices, [0, 1], "cluster membership is exactly the two desc-similar findings; the dissimilar entry 2 is excluded");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
