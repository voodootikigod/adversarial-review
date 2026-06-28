import assert from "node:assert/strict";
import test from "node:test";
import { validateResult, assessFindings, deriveVerdict, mergeProviderResults, deriveQuorumVerdict, renderReport, apiProvidersCannotReview } from "../src/review.js";

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

// ─── Multi-provider merge / corroboration (AC5, AC11) ───────────────────────

test("AC5: mergeProviderResults dedups shared finding + tags corroborators, keeps uniques", () => {
  const shared = { title: "SQL injection in query builder", category: "injection", file: "src/db.js", line_start: 10, line_end: 12 };
  const gptResult = validResult({
    findings: [
      validFinding(shared),
      validFinding({ title: "Unbounded retry loop", category: "correctness", file: "src/job.js", line_start: 40, line_end: 45 })
    ]
  });
  const gemResult = validResult({
    findings: [
      validFinding(shared),
      validFinding({ title: "Missing auth check on admin route", category: "auth", file: "src/api.js", line_start: 5, line_end: 7 })
    ]
  });

  const merged = mergeProviderResults([
    { provider: "gpt", result: gptResult },
    { provider: "gemini", result: gemResult }
  ]);

  assert.equal(merged.findings.length, 3, "shared finding deduped → 3 total");
  const sharedMerged = merged.findings.find((f) => f.title === "SQL injection in query builder");
  assert.deepEqual([...sharedMerged.corroborated_by].sort(), ["gemini", "gpt"], "shared tagged by both");
  const gptUnique = merged.findings.find((f) => f.title === "Unbounded retry loop");
  const gemUnique = merged.findings.find((f) => f.title === "Missing auth check on admin route");
  assert.deepEqual(gptUnique.corroborated_by, ["gpt"]);
  assert.deepEqual(gemUnique.corroborated_by, ["gemini"]);
  // Merged result is schema-valid (corroborated_by is an accepted optional field).
  assert.deepEqual(validateResult(merged), []);
});

test("apiProvidersCannotReview only blocks API providers on a non-inlinable, non-summary diff", () => {
  // An inlinable diff must NOT trigger the drop/downgrade path (the default case).
  assert.equal(apiProvidersCannotReview({ includeDiff: true }, { allowSummaryReview: false }), false);
  // Non-inlinable + no opt-in → API providers cannot review.
  assert.equal(apiProvidersCannotReview({ includeDiff: false }, { allowSummaryReview: false }), true);
  // Non-inlinable but the user accepted summary-only → allowed.
  assert.equal(apiProvidersCannotReview({ includeDiff: false }, { allowSummaryReview: true }), false);
});

test("#6: representative selection never lets a low-confidence finding mask a gating one", () => {
  const loc = { category: "concurrency", file: "src/x.js", line_start: 5, line_end: 8, title: "Race condition on shared cache" };
  const wellGrounded = validResult({ findings: [validFinding({ ...loc, severity: "medium", confidence: 0.9 })] });
  const flashy = validResult({ findings: [validFinding({ ...loc, severity: "critical", confidence: 0.1 })] });

  // Try both orderings — the representative must be the gating medium/0.9 either way.
  for (const order of [[wellGrounded, flashy], [flashy, wellGrounded]]) {
    const merged = mergeProviderResults(
      [{ provider: "gpt", result: order[0] }, { provider: "gemini", result: order[1] }],
      { failOn: "medium", minConfidence: 0.5 }
    );
    assert.equal(merged.findings.length, 1);
    assert.equal(merged.findings[0].severity, "medium");
    assert.equal(merged.findings[0].confidence, 0.9);
    assert.deepEqual([...merged.findings[0].corroborated_by].sort(), ["gemini", "gpt"]);
  }
});

test("AC11: distinct root causes at the same (file,category,range) are preserved, not collapsed", () => {
  const loc = { category: "security", file: "src/auth.js", line_start: 20, line_end: 25 };
  const gptResult = validResult({
    findings: [validFinding({ ...loc, title: "Timing-unsafe token comparison" })]
  });
  const gemResult = validResult({
    findings: [validFinding({ ...loc, title: "Hardcoded fallback signing secret" })]
  });

  const merged = mergeProviderResults([
    { provider: "gpt", result: gptResult },
    { provider: "gemini", result: gemResult }
  ]);

  assert.equal(merged.findings.length, 2, "different root causes at same location must NOT collapse");
  const titles = merged.findings.map((f) => f.title).sort();
  assert.deepEqual(titles, ["Hardcoded fallback signing secret", "Timing-unsafe token comparison"]);
  for (const f of merged.findings) assert.equal(f.corroborated_by.length, 1);
});

test("#1(r5): distinct vulnerabilities at the same location are not collapsed by generic terms", () => {
  // Same file/category/range, titles share generic terms (injection/vulnerability/in)
  // but name DIFFERENT root causes — must stay separate.
  const loc = { category: "injection", file: "src/db.js", line_start: 5, line_end: 10 };
  const a = validResult({ findings: [validFinding({ ...loc, title: "SQL injection vulnerability in database helper" })] });
  const b = validResult({ findings: [validFinding({ ...loc, title: "Command injection vulnerability in database helper" })] });
  const merged = mergeProviderResults([{ provider: "gpt", result: a }, { provider: "gemini", result: b }]);
  assert.equal(merged.findings.length, 2, "sql vs command injection must not collapse");
});

test("#1(r5): differently-worded descriptions of the SAME defect still corroborate", () => {
  const loc = { category: "injection", file: "src/db.js", line_start: 5, line_end: 10 };
  const a = validResult({ findings: [validFinding({ ...loc, title: "SQL injection in query builder" })] });
  const b = validResult({ findings: [validFinding({ ...loc, title: "SQL injection in the query builder" })] });
  const merged = mergeProviderResults([{ provider: "gpt", result: a }, { provider: "gemini", result: b }]);
  assert.equal(merged.findings.length, 1, "same defect, trivially different wording → corroborated");
  assert.deepEqual([...merged.findings[0].corroborated_by].sort(), ["gemini", "gpt"]);
});

// ─── Quorum-aware verdict (AC6) ─────────────────────────────────────────────

test("AC6: quorum verdict — one approve + one needs-attention gates by default (quorum 1)", () => {
  const approve = validResult({ verdict: "approve", findings: [] });
  const flag = validResult({ findings: [validFinding({ severity: "high", confidence: 0.9 })] });
  const perProvider = [
    { provider: "gpt", result: approve },
    { provider: "gemini", result: flag }
  ];

  const d1 = deriveQuorumVerdict(perProvider, { failOn: "medium", minConfidence: 0.5, quorum: 1 });
  assert.equal(d1.verdict, "needs-attention");
  assert.equal(d1.flaggingCount, 1);
  // Exit-code mapping (shared with single-provider path): needs-attention → 2.
  assert.equal(d1.verdict === "needs-attention" ? 2 : 0, 2);

  const d2 = deriveQuorumVerdict(perProvider, { failOn: "medium", minConfidence: 0.5, quorum: 2 });
  assert.equal(d2.verdict, "approve", "quorum 2 not met by a single flagging provider");
  assert.equal(d2.verdict === "needs-attention" ? 2 : 0, 0);
});

test("quorum is capped to the number of providers that ran (no fail-open)", () => {
  // Only ONE provider reachable but --quorum 2: the requested quorum is
  // unsatisfiable, which must NOT silently approve. Effective quorum caps to 1.
  const flag = validResult({ findings: [validFinding({ severity: "high", confidence: 0.9 })] });
  const d = deriveQuorumVerdict([{ provider: "gemini", result: flag }], {
    failOn: "medium", minConfidence: 0.5, quorum: 2
  });
  assert.equal(d.effectiveQuorum, 1);
  assert.equal(d.verdict, "needs-attention", "a lone reachable provider's finding must still gate");
});

test("#8: renderReport surfaces ungrounded warnings when assessments are provided", () => {
  const result = validResult({ findings: [validFinding({ corroborated_by: ["gpt"] })] });
  const context = { label: "x", changedFiles: [], includeDiff: false, content: "" };
  const assessments = [{ notes: ["evidence not found in provided context"], effectiveConfidence: 0.45 }];
  const out = renderReport(result, context, assessments, { verdict: "needs-attention" });
  assert.match(out, /ungrounded/);
});
