import assert from "node:assert/strict";
import test from "node:test";
import { parseArgs } from "../src/utils.js";

// Arg-boundary rails for the --loop + --providers capability (T-ar9).
//
// The bug being fixed: `--loop --providers a,b` used to silently run a
// SINGLE-provider loop (the loop dispatch ran before the multi-provider branch
// and src/loop.js never read args.providers). The fix HONORS the request — so at
// the argument layer the combination must be VALID (no reject guard), while the
// pre-existing --providers/--provider and --providers/--model guards stay intact.

test("parseArgs: --loop is a valid combination with --providers (no silent-drop reject guard)", () => {
  const args = parseArgs(["node", "cli", "--loop", "--providers", "gpt,gemini", "--scope", "working-tree"]);
  assert.deepEqual(args.errors, [], `unexpected parse errors: ${args.errors.join("; ")}`);
  assert.equal(args.loop, true);
  assert.deepEqual(args.providers, ["gpt", "gemini"]);
  assert.equal(args.quorum, 1, "quorum defaults to 1 (any one provider's material finding gates)");
});

test("parseArgs: --loop --providers=auto sentinel is valid", () => {
  const args = parseArgs(["node", "cli", "--loop", "--providers=auto"]);
  assert.deepEqual(args.errors, [], `unexpected parse errors: ${args.errors.join("; ")}`);
  assert.equal(args.loop, true);
  assert.equal(args.providers, "auto");
});

test("parseArgs: --loop --providers still honors --quorum", () => {
  const args = parseArgs(["node", "cli", "--loop", "--providers", "gpt,gemini", "--quorum", "2"]);
  assert.deepEqual(args.errors, []);
  assert.equal(args.quorum, 2);
});

// The capability must NOT loosen the existing mutually-exclusive guards.
test("parseArgs: --providers + --provider is still rejected even with --loop", () => {
  const args = parseArgs(["node", "cli", "--loop", "--providers", "gpt,gemini", "--provider", "openai"]);
  assert.ok(
    args.errors.some((e) => /--providers.*--provider|--provider.*--providers/.test(e)),
    "combining --providers with --provider must still error"
  );
});

test("parseArgs: --providers + --model is still rejected even with --loop", () => {
  const args = parseArgs(["node", "cli", "--loop", "--providers", "gpt,gemini", "--model", "gpt-4o"]);
  assert.ok(
    args.errors.some((e) => /--model.*--providers|--providers.*--model/.test(e)),
    "combining --providers with --model must still error"
  );
});
