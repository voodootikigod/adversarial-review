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
