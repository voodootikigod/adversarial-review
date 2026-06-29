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

test("parseArgs parses gating, verification, and payload flags", () => {
  const args = parseArgs([
    "node",
    "cli",
    "--fail-on=high",
    "--min-confidence=0.7",
    "--passes=3",
    "--verify",
    "--fail-on-empty",
    "--include-files",
    "--allow-secrets",
    "--context-lines=20",
    "--timeout=300"
  ]);

  assert.equal(args.failOn, "high");
  assert.equal(args.minConfidence, 0.7);
  assert.equal(args.passes, 3);
  assert.equal(args.verify, true);
  assert.equal(args.failOnEmpty, true);
  assert.equal(args.includeFiles, true);
  assert.equal(args.allowSecrets, true);
  assert.equal(args.contextLines, 20);
  assert.equal(args.timeout, 300);
  assert.deepEqual(args.errors, []);
});

test("parseArgs rejects invalid gating values", () => {
  const args = parseArgs([
    "node",
    "cli",
    "--fail-on=urgent",
    "--min-confidence=2",
    "--passes=0",
    "--timeout=0"
  ]);

  assert.deepEqual(args.errors, [
    "--fail-on must be one of: critical, high, medium, low.",
    "--min-confidence must be a number between 0 and 1.",
    "--passes must be a positive integer.",
    "--timeout must be a positive integer."
  ]);
});

test("parseArgs defaults match the documented gate", () => {
  const args = parseArgs(["node", "cli"]);

  assert.equal(args.failOn, "medium");
  assert.equal(args.minConfidence, 0.5);
  assert.equal(args.passes, 1);
  assert.equal(args.contextLines, 10);
  assert.equal(args.timeout, 120);
  assert.equal(args.verify, false);
  assert.equal(args.includeFiles, false);
  assert.equal(args.failOnEmpty, false);
  assert.equal(args.allowSecrets, false);
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


test("parseArgs parses --providers as a comma-separated list and --quorum", () => {
  const args = parseArgs(["node", "cli", "--providers", "gpt,gemini,claude", "--quorum", "2"]);
  assert.deepEqual(args.providers, ["gpt", "gemini", "claude"]);
  assert.equal(args.quorum, 2);
  assert.deepEqual(args.errors, []);
});

test("parseArgs accepts --providers=auto sentinel and defaults quorum to 1", () => {
  const args = parseArgs(["node", "cli", "--providers=auto"]);
  assert.equal(args.providers, "auto");
  assert.equal(args.quorum, 1);
  assert.deepEqual(args.errors, []);
});

test("parseArgs trims and drops empty --providers entries", () => {
  const args = parseArgs(["node", "cli", "--providers", " gpt , , gemini "]);
  assert.deepEqual(args.providers, ["gpt", "gemini"]);
});

test("parseArgs rejects an empty --providers list", () => {
  const args = parseArgs(["node", "cli", "--providers", ","]);
  assert.ok(args.errors.some((e) => /--providers/.test(e)));
});

test("parseArgs rejects --providers combined with --provider", () => {
  const args = parseArgs(["node", "cli", "--provider", "openai", "--providers", "gpt,gemini"]);
  assert.ok(args.errors.some((e) => /--providers.*--provider|--provider.*--providers/.test(e)));
});

test("parseArgs defaults: providers null, quorum 1", () => {
  const args = parseArgs(["node", "cli"]);
  assert.equal(args.providers, null);
  assert.equal(args.quorum, 1);
});

test("parseArgs rejects --model combined with --providers", () => {
  const args = parseArgs(["node", "cli", "--providers", "gpt,gemini", "--model", "gpt-4o"]);
  assert.ok(args.errors.some((e) => /--model.*--providers|--providers.*--model/.test(e)));
});

test("parseArgs --findings-ledger: optional value with default path", () => {
  // no value → default ledger path
  assert.equal(parseArgs(["node", "cli", "--findings-ledger"]).findingsLedger, ".adlc/findings.jsonl");
  // explicit value (space form)
  assert.equal(parseArgs(["node", "cli", "--findings-ledger", "out/f.jsonl"]).findingsLedger, "out/f.jsonl");
  // explicit value (= form)
  assert.equal(parseArgs(["node", "cli", "--findings-ledger=out/f.jsonl"]).findingsLedger, "out/f.jsonl");
  // empty = form → default
  assert.equal(parseArgs(["node", "cli", "--findings-ledger="]).findingsLedger, ".adlc/findings.jsonl");
  // absent → null
  assert.equal(parseArgs(["node", "cli"]).findingsLedger, null);
  // a following flag is NOT consumed as the value
  assert.equal(parseArgs(["node", "cli", "--findings-ledger", "--json"]).findingsLedger, ".adlc/findings.jsonl");
  assert.equal(parseArgs(["node", "cli", "--findings-ledger", "--json"]).json, true);
  // after consuming an explicit value, the NEXT flag is still parsed (no index skip)
  const a = parseArgs(["node", "cli", "--findings-ledger", "p.jsonl", "--json"]);
  assert.equal(a.findingsLedger, "p.jsonl");
  assert.equal(a.json, true, "the flag after an explicit ledger value must still be parsed");
});
