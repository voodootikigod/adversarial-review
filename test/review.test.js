import assert from "node:assert/strict";
import test from "node:test";
import { validateResult, assessFindings, deriveVerdict } from "../src/review.js";

function validFinding(overrides = {}) {
  return {
    severity: "high",
    category: "correctness",
    title: "Issue",
    body: "Evidence",
    exploit_scenario: "A retry duplicates the write.",
    evidence: "db.insert(row)",
    file: "src/file.js",
    line_start: 1,
    line_end: 2,
    confidence: 0.9,
    recommendation: "Fix it.",
    ...overrides
  };
}

function validResult(overrides = {}) {
  return {
    verdict: "needs-attention",
    summary: "Do not ship.",
    coverage: {
      files_examined: ["src/file.js"],
      files_skipped: []
    },
    findings: [validFinding()],
    next_steps: ["Patch and retest."],
    ...overrides
  };
}

test("validateResult accepts a schema-compliant result", () => {
  assert.deepEqual(validateResult(validResult()), []);
});

test("validateResult accepts a file-level finding (lines 0,0)", () => {
  const result = validResult({
    findings: [validFinding({ line_start: 0, line_end: 0, evidence: "" })]
  });
  assert.deepEqual(validateResult(result), []);
});

test("validateResult rejects a half-file-level line range", () => {
  const errors = validateResult(
    validResult({ findings: [validFinding({ line_start: 0, line_end: 5 })] })
  );
  assert.ok(errors.some((e) => e.includes("must both be 0")));
});

test("validateResult enforces line ranges and non-empty array items", () => {
  const errors = validateResult(
    validResult({
      findings: [validFinding({ line_start: 9, line_end: -1, recommendation: "" })],
      next_steps: [""]
    })
  );

  assert.ok(errors.includes("findings[0].line_end must be >= 0"));
  assert.ok(errors.includes("next_steps[0] must be a non-empty string"));
});

test("validateResult requires line_end >= line_start", () => {
  const errors = validateResult(
    validResult({ findings: [validFinding({ line_start: 10, line_end: 5 })] })
  );
  assert.ok(errors.includes("findings[0].line_end must be >= line_start"));
});

test("validateResult rejects additional properties", () => {
  const errors = validateResult(validResult({ extra: true }));

  assert.deepEqual(errors, ["additional property not allowed: extra"]);
});

test("validateResult rejects an unknown category", () => {
  const errors = validateResult(
    validResult({ findings: [validFinding({ category: "vibes" })] })
  );
  assert.ok(errors.some((e) => e.startsWith("findings[0].category must be one of")));
});

test("deriveVerdict gates on severity and confidence thresholds", () => {
  const result = validResult({
    findings: [
      validFinding({ severity: "low", confidence: 0.9 }),
      validFinding({ severity: "high", confidence: 0.3 })
    ]
  });

  // low severity and low-confidence high finding both fall below the gate.
  const derived = deriveVerdict(result, null, { failOn: "medium", minConfidence: 0.5 });
  assert.equal(derived.verdict, "approve");
  assert.equal(derived.gatingCount, 0);

  // Lowering the confidence floor lets the high finding gate.
  const strict = deriveVerdict(result, null, { failOn: "medium", minConfidence: 0.2 });
  assert.equal(strict.verdict, "needs-attention");
  assert.equal(strict.gatingCount, 1);
});

test("deriveVerdict ignores the model's self-reported verdict", () => {
  const result = validResult({ verdict: "approve" });
  const derived = deriveVerdict(result, null, { failOn: "medium", minConfidence: 0.5 });
  assert.equal(derived.verdict, "needs-attention");
});

test("assessFindings flags files outside the change set and halves confidence", () => {
  const result = validResult({
    findings: [validFinding({ file: "src/other.js", confidence: 0.8, evidence: "" })]
  });
  const context = { changedFiles: ["src/file.js"], includeDiff: false, content: "" };

  const assessments = assessFindings(result, context, { apiMode: true });
  assert.equal(assessments[0].notes.length, 1);
  assert.equal(assessments[0].effectiveConfidence, 0.4);

  // Local CLI reviewers can legitimately inspect untouched files.
  const cliAssessments = assessFindings(result, context, { apiMode: false });
  assert.deepEqual(cliAssessments[0].notes, []);
});

test("assessFindings flags evidence not present in the inlined context", () => {
  const result = validResult({
    findings: [validFinding({ evidence: "this code does not exist", confidence: 1 })]
  });
  const context = {
    changedFiles: ["src/file.js"],
    includeDiff: true,
    content: "## Diff\n```\ndb.insert(row)\n```"
  };

  const assessments = assessFindings(result, context, { apiMode: true });
  assert.equal(assessments[0].notes.length, 1);
  assert.equal(assessments[0].effectiveConfidence, 0.5);
});

test("assessFindings matches evidence with collapsed whitespace", () => {
  const result = validResult({
    findings: [validFinding({ evidence: "db.insert(  row )".replace(/\s+/g, " ") })]
  });
  const context = {
    changedFiles: ["src/file.js"],
    includeDiff: true,
    content: "## Diff\n```\ndb.insert( row )\n```"
  };

  const assessments = assessFindings(result, context, { apiMode: true });
  assert.deepEqual(assessments[0].notes, []);
});

test("deriveVerdict uses grounding-adjusted confidence", () => {
  const result = validResult({
    findings: [validFinding({ confidence: 0.8 })]
  });
  const assessments = [{ notes: ["ungrounded"], effectiveConfidence: 0.4 }];
  const derived = deriveVerdict(result, assessments, { failOn: "medium", minConfidence: 0.5 });
  assert.equal(derived.verdict, "approve");
});
