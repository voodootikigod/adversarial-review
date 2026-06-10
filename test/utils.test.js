import assert from "node:assert/strict";
import test from "node:test";
import { parseArgs } from "../src/utils.js";

test("parseArgs rejects missing values and invalid integers", () => {
  const args = parseArgs(["node", "cli", "--base", "--max-files=abc", "--unknown"]);

  assert.equal(args.base, null);
  assert.deepEqual(args.errors, [
    "--base requires a value.",
    "--max-files must be a non-negative integer.",
    'Unknown option "--unknown".'
  ]);
});

test("parseArgs accepts explicit summary-review opt in", () => {
  const args = parseArgs(["node", "cli", "--allow-summary-review", "--max-files=0"]);

  assert.equal(args.allowSummaryReview, true);
  assert.equal(args.maxFiles, 0);
  assert.deepEqual(args.errors, []);
});

test("parseArgs parses --api-base, --api-key, and --headers", () => {
  const args = parseArgs([
    "node",
    "cli",
    "--api-base",
    "https://gateway.ai.vercel.com/v1/providers/openai",
    "--api-key",
    "test-key",
    "--headers",
    '{"x-custom":"val"}'
  ]);

  assert.equal(args.apiBase, "https://gateway.ai.vercel.com/v1/providers/openai");
  assert.equal(args.apiKey, "test-key");
  assert.equal(args.headers, '{"x-custom":"val"}');
  assert.deepEqual(args.errors, []);
});

test("parseArgs parses equals format for --api-base, --api-key, and --headers", () => {
  const args = parseArgs([
    "node",
    "cli",
    "--api-base=https://gateway.ai.vercel.com/v1/providers/openai",
    "--api-key=test-key",
    "--headers={\"x-custom\":\"val\"}"
  ]);

  assert.equal(args.apiBase, "https://gateway.ai.vercel.com/v1/providers/openai");
  assert.equal(args.apiKey, "test-key");
  assert.equal(args.headers, '{"x-custom":"val"}');
  assert.deepEqual(args.errors, []);
});

