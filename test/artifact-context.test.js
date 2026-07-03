import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { collectArtifactContext } from "../src/artifact-context.js";
import { buildArtifactPrompt } from "../src/review.js";

// T6 / GitHub #10 — --input artifact review mode. collectArtifactContext reads
// named artifact files into a context shape-compatible with the git context, and
// buildArtifactPrompt fills an artifact-appropriate charter (not the diff template).

function withTempFiles(files, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "adv-artifact-"));
  try {
    for (const [name, body] of Object.entries(files)) {
      fs.writeFileSync(path.join(dir, name), body);
    }
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// ── AC2: collectArtifactContext ───────────────────────────────────────────────

test("AC2: reads named files into an inlined, git-context-compatible shape", () => {
  withTempFiles({ "spec.md": "# Spec\nAcceptance: none stated.\n", "ticket.md": "Do the thing." }, (dir) => {
    const ctx = collectArtifactContext(dir, ["spec.md", "ticket.md"], { maxBytes: 256 * 1024 });
    assert.equal(ctx.mode, "artifact");
    assert.equal(ctx.includeDiff, true);
    assert.equal(ctx.isEmpty, false);
    assert.deepEqual(ctx.changedFiles, ["spec.md", "ticket.md"]);
    assert.ok(ctx.content.includes("Acceptance: none stated."), "first file body inlined");
    assert.ok(ctx.content.includes("Do the thing."), "second file body inlined");
    assert.equal(ctx.fileCount, 2);
    assert.ok(typeof ctx.label === "string" && ctx.label.length > 0);
    assert.ok(typeof ctx.collectionGuidance === "string" && ctx.collectionGuidance.length > 0);
  });
});

test("AC2: all-empty inputs FAIL CLOSED (throw, never a silent empty-scope approve)", () => {
  // The user explicitly named these files; if none has reviewable content, the
  // gate must error, not approve nothing. (Regression for the AR fail-open finding.)
  withTempFiles({ "a.md": "", "b.md": "   \n" }, (dir) => {
    assert.throws(
      () => collectArtifactContext(dir, ["a.md", "b.md"], { maxBytes: 256 * 1024 }),
      /No reviewable content/
    );
  });
});

test("AC2: a binary input (NUL at byte 0) throws — never reviewed as text (no silent skip)", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "adv-artifact-bin-"));
  try {
    // NUL at index 0 specifically: guards the isProbablyText subarray(0,...) bound.
    fs.writeFileSync(path.join(dir, "bin.dat"), Buffer.from([0x00, 0x61, 0x62, 0x63]));
    assert.throws(
      () => collectArtifactContext(dir, ["bin.dat"], { maxBytes: 256 * 1024 }),
      /binary, cannot review/
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("AC2: an oversize target reached through a symlink throws (statSync follows the link, no partial drop)", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "adv-artifact-link-"));
  try {
    // Target exceeds the per-file cap; the size guard must see the TARGET, not the
    // (tiny) symlink — otherwise lstatSync would pass it through. Over-cap is a hard
    // error (not a silent skip), so a partial review can never approve.
    fs.writeFileSync(path.join(dir, "big.md"), "x".repeat(256 * 1024 + 10));
    fs.symlinkSync(path.join(dir, "big.md"), path.join(dir, "link.md"));
    assert.throws(
      () => collectArtifactContext(dir, ["link.md"], { maxBytes: 256 * 1024 }),
      /too large to review inline/
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("AC2: a missing/unreadable input file throws (fail closed, never silent-empty)", () => {
  withTempFiles({ "present.md": "hi" }, (dir) => {
    assert.throws(
      () => collectArtifactContext(dir, ["present.md", "does-not-exist.md"], { maxBytes: 256 * 1024 }),
      /does-not-exist\.md/
    );
  });
});

// ── AC3: buildArtifactPrompt uses the artifact charter, not the diff template ──

test("AC3: buildArtifactPrompt substitutes all placeholders and embeds the artifact", () => {
  withTempFiles({ "spec.md": "SENTINEL_ARTIFACT_BODY line" }, (dir) => {
    const ctx = collectArtifactContext(dir, ["spec.md"], { maxBytes: 256 * 1024 });
    const prompt = buildArtifactPrompt(ctx, "focus on the auth boundary");
    assert.ok(!/\{\{[A-Z_]+\}\}/.test(prompt), "no residual {{PLACEHOLDER}}");
    assert.ok(prompt.includes("SENTINEL_ARTIFACT_BODY"), "artifact content embedded in REVIEW_INPUT");
    assert.ok(prompt.includes("focus on the auth boundary"), "user focus substituted");
    assert.ok(/artifact/i.test(prompt), "artifact-review framing present");
  });
});

test("AC3: the artifact charter is NOT the diff template", () => {
  withTempFiles({ "spec.md": "x" }, (dir) => {
    const ctx = collectArtifactContext(dir, ["spec.md"], { maxBytes: 256 * 1024 });
    const prompt = buildArtifactPrompt(ctx, "");
    // "Map the change surface" is a diff-template-only tell (review_method step 1).
    assert.ok(!prompt.includes("Map the change surface"), "must not use the diff template's change-surface framing");
  });
});
