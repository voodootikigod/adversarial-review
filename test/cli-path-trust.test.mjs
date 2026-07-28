import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveTrustedCli, isTrustedCliInstalled } from "../src/llm.js";
import { isInsideTrustRoot } from "../src/trust-root.js";

test("isInsideTrustRoot flags paths inside the trust root, with an explicit root", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tr-root-"));
  try {
    assert.equal(isInsideTrustRoot(path.join(root, "node_modules", ".bin", "codex"), { root }), true);
    assert.equal(isInsideTrustRoot(root, { root }), true);
    assert.equal(isInsideTrustRoot("/usr/local/bin/codex", { root }), false);
    assert.equal(isInsideTrustRoot(path.join(os.tmpdir(), "elsewhere-codex"), { root }), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("isInsideTrustRoot uses the GIT WORKTREE root, not cwd — nested-dir invocation stays protected", () => {
  // A path at the repo root must be flagged even when measured from a nested dir,
  // because the trust root is the worktree top level (this repo, resolved via git).
  const repoRootBin = path.join(process.cwd(), "node_modules", ".bin", "codex");
  assert.equal(isInsideTrustRoot(repoRootBin), true);
});

import { writeSimpleMockBin } from "./helpers/mock-bin.mjs";

test("resolveTrustedCli REFUSES a repository-local executable (T22: node_modules/.bin shim)", () => {
  // Simulate a repo-local shim: an executable that resolves to a path inside the
  // current working tree, exposed first on PATH (as npm/npx would do).
  const repoLocalDir = fs.mkdtempSync(path.join(process.cwd(), ".t22trust-"));
  const savedPath = process.env.PATH;
  try {
    writeSimpleMockBin(repoLocalDir, "codex");
    process.env.PATH = repoLocalDir; // only the repo-local shim is on PATH
    assert.equal(resolveTrustedCli("codex"), null, "a repo-local codex must not be trusted");
    assert.equal(isTrustedCliInstalled("codex"), false);
  } finally {
    process.env.PATH = savedPath;
    fs.rmSync(repoLocalDir, { recursive: true, force: true });
  }
});

test("resolveTrustedCli ACCEPTS an executable outside the working tree and returns its canonical path", () => {
  const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "t22-outside-"));
  const savedPath = process.env.PATH;
  try {
    writeSimpleMockBin(outsideDir, "codex");
    const binName = process.platform === "win32" ? "codex.cmd" : "codex";
    const bin = path.join(outsideDir, binName);
    process.env.PATH = outsideDir;
    const trusted = resolveTrustedCli("codex");
    assert.ok(trusted, "an out-of-tree codex should be trusted");
    // Canonical (symlinks resolved) and absolute.
    assert.equal(trusted, fs.realpathSync(bin));
    assert.equal(path.isAbsolute(trusted), true);
  } finally {
    process.env.PATH = savedPath;
    fs.rmSync(outsideDir, { recursive: true, force: true });
  }
});
