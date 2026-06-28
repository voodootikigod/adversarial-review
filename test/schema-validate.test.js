import assert from "node:assert/strict";
import test from "node:test";
import { validateAgainstSchema, sanitizeSchemaForProvider } from "../src/schema-validate.js";
import { loadSchema } from "../src/review.js";

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["name", "count"],
  properties: {
    name: { type: "string", minLength: 1 },
    count: { type: "integer", minimum: 0, maximum: 10 },
    ratio: { type: "number", minimum: 0, maximum: 1 },
    kind: { type: "string", enum: ["a", "b"] },
    tags: { type: "array", items: { type: "string", minLength: 1 } }
  }
};

test("validateAgainstSchema accepts a conforming object", () => {
  assert.deepEqual(
    validateAgainstSchema(SCHEMA, { name: "x", count: 3, ratio: 0.5, kind: "a", tags: ["t"] }),
    []
  );
});

test("validateAgainstSchema reports missing required, bad enum, range, and extra keys", () => {
  const errors = validateAgainstSchema(SCHEMA, {
    count: 11,
    ratio: 2,
    kind: "c",
    tags: [""],
    bogus: 1
  });
  assert.ok(errors.includes("name is required"));
  assert.ok(errors.includes("count must be <= 10"));
  assert.ok(errors.includes("ratio must be <= 1"));
  assert.ok(errors.some((e) => e.startsWith("kind must be one of")));
  assert.ok(errors.includes("tags[0] must be a non-empty string"));
  assert.ok(errors.includes("additional property not allowed: bogus"));
});

test("validateAgainstSchema distinguishes integer from number", () => {
  const errors = validateAgainstSchema(SCHEMA, { name: "x", count: 1.5 });
  assert.ok(errors.some((e) => e.includes("count must be of type integer")));

  // Integers satisfy "number" typed fields.
  assert.deepEqual(validateAgainstSchema(SCHEMA, { name: "x", count: 1, ratio: 1 }), []);
});

test("validateAgainstSchema rejects non-object roots", () => {
  assert.deepEqual(validateAgainstSchema(SCHEMA, null), ["result is not an object"]);
  assert.deepEqual(validateAgainstSchema(SCHEMA, []), ["result is not an object"]);
});

test("sanitizeSchemaForProvider strips metadata and constraint keywords", () => {
  const schema = loadSchema();
  const sanitized = sanitizeSchemaForProvider(schema);
  const text = JSON.stringify(sanitized);
  assert.ok(!text.includes("$schema"));
  assert.ok(!text.includes("$comment"));
  assert.ok(!text.includes("minLength"));
  assert.ok(!text.includes("\"minimum\""));
  // Structural keywords survive.
  assert.ok(text.includes("additionalProperties"));
  assert.ok(text.includes("required"));
});

test("sanitizeSchemaForProvider keepConstraints retains numeric bounds", () => {
  const sanitized = sanitizeSchemaForProvider(loadSchema(), { keepConstraints: true });
  assert.ok(JSON.stringify(sanitized).includes("\"minimum\""));
});

test("sanitizeSchemaForProvider extraDrop removes additionalProperties for Gemini", () => {
  const sanitized = sanitizeSchemaForProvider(loadSchema(), { extraDrop: ["additionalProperties"] });
  assert.ok(!JSON.stringify(sanitized).includes("additionalProperties"));
});

test("schema.json finding accepts optional corroborated_by (merged-result validation)", () => {
  const schema = loadSchema();
  const finding = schema.properties.findings.items;
  // corroborated_by is an optional property (present, but not required).
  assert.ok("corroborated_by" in finding.properties, "corroborated_by must be a declared property");
  assert.ok(!finding.required.includes("corroborated_by"), "corroborated_by must NOT be required");

  const result = {
    verdict: "needs-attention",
    summary: "Two providers agree.",
    coverage: { files_examined: ["a.js"], files_skipped: [] },
    findings: [{
      severity: "high", category: "security", title: "t", body: "b",
      exploit_scenario: "x", evidence: "", file: "a.js", line_start: 1, line_end: 2,
      confidence: 0.9, recommendation: "fix", corroborated_by: ["gpt", "gemini"]
    }],
    next_steps: []
  };
  assert.deepEqual(validateAgainstSchema(schema, result), []);
});

test("AC10: provider-facing schema excludes corroborated_by (R2)", () => {
  // The schema sent to providers must not contain corroborated_by — OpenAI strict
  // json_schema requires every property be required, and providers never produce it.
  const schema = loadSchema();
  assert.ok("corroborated_by" in schema.properties.findings.items.properties,
    "precondition: corroborated_by present in the source schema");
  const sanitized = sanitizeSchemaForProvider(schema);
  assert.ok(!JSON.stringify(sanitized).includes("corroborated_by"),
    "corroborated_by must be stripped from the provider-facing schema");
  // Gemini path (extraDrop additionalProperties) also excludes it.
  const gemini = sanitizeSchemaForProvider(schema, { extraDrop: ["additionalProperties"] });
  assert.ok(!JSON.stringify(gemini).includes("corroborated_by"));
});

test("shipped schema.json validates with the local walker (round trip)", () => {
  const schema = loadSchema();
  const result = {
    verdict: "approve",
    summary: "Safe to ship.",
    coverage: { files_examined: ["a.js"], files_skipped: [] },
    findings: [],
    next_steps: []
  };
  assert.deepEqual(validateAgainstSchema(schema, result), []);
});
