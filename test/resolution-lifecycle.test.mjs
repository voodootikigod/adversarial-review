import assert from "node:assert/strict";
import test from "node:test";
import { isStaleResolutionFailure } from "../src/resolution-lifecycle.js";

test("isStaleResolutionFailure: auth statuses are stale (401/403)", () => {
  assert.equal(isStaleResolutionFailure({ status: 401 }), true);
  assert.equal(isStaleResolutionFailure({ status: 403 }), true);
});

test("isStaleResolutionFailure: invalid/retired-model failures are stale (T24)", () => {
  // 404 not-found (retired model / bad endpoint) → stale.
  assert.equal(isStaleResolutionFailure({ status: 404 }), true);
  // 400 that NAMES a model problem → stale.
  assert.equal(isStaleResolutionFailure({ status: 400, message: "OpenAI API error (400): the model `gpt-5` does not exist" }), true);
  // Text-only (CLI) model errors → stale.
  assert.equal(isStaleResolutionFailure({ message: "error: model gpt-5 is retired" }), true);
  assert.equal(isStaleResolutionFailure({ stderr: "no such model: claude-x" }), true);
});

test("isStaleResolutionFailure: transient / non-model failures are NOT stale (keep the cache)", () => {
  // 400 that does NOT name a model problem → transient/bad-request, keep cache.
  assert.equal(isStaleResolutionFailure({ status: 400, message: "bad request: malformed json" }), false);
  assert.equal(isStaleResolutionFailure({ status: 429 }), false);
  assert.equal(isStaleResolutionFailure({ status: 500 }), false);
  assert.equal(isStaleResolutionFailure({ message: "connection reset by peer" }), false);
  assert.equal(isStaleResolutionFailure({}), false);
});

test("isStaleResolutionFailure: CLI auth/session text is stale", () => {
  assert.equal(isStaleResolutionFailure({ message: "error: not logged in; run: login" }), true);
  assert.equal(isStaleResolutionFailure({ stderr: "session expired, please login" }), true);
});
