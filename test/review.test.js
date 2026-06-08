import assert from "node:assert/strict";
import test from "node:test";
import { validateResult } from "../src/review.js";

function validResult(overrides = {}) {
  return {
    verdict: "needs-attention",
    summary: "Do not ship.",
    findings: [
      {
        severity: "high",
        title: "Issue",
        body: "Evidence",
        file: "src/file.js",
        line_start: 1,
        line_end: 2,
        confidence: 0.9,
        recommendation: "Fix it."
      }
    ],
    next_steps: ["Patch and retest."],
    ...overrides
  };
}

test("validateResult accepts a schema-compliant result", () => {
  assert.deepEqual(validateResult(validResult()), []);
});

test("validateResult enforces line ranges and non-empty arrays items", () => {
  const errors = validateResult(
    validResult({
      findings: [
        {
          severity: "low",
          title: "Issue",
          body: "Evidence",
          file: "src/file.js",
          line_start: 0,
          line_end: -1,
          confidence: 0.2,
          recommendation: ""
        }
      ],
      next_steps: [""]
    })
  );

  assert.ok(errors.includes("findings[0].line_start must be >= 1"));
  assert.ok(errors.includes("findings[0].line_end must be >= 1"));
  assert.ok(errors.includes("next_steps[0] must be a non-empty string"));
});

test("validateResult rejects additional properties", () => {
  const errors = validateResult(validResult({ extra: true }));

  assert.deepEqual(errors, ["additional property not allowed: extra"]);
});
