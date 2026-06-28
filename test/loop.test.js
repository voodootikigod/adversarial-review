import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { buildFixerCmd, FIXER_PROVIDER_MAP, detectFixer } from "../src/loop.js";

test("FIXER_PROVIDER_MAP maps agy to the gemini family and drops the legacy gemini key", () => {
  assert.equal(FIXER_PROVIDER_MAP.agy, "gemini");
  assert.equal(FIXER_PROVIDER_MAP.gemini, undefined);
  // Existing fixers are unchanged.
  assert.equal(FIXER_PROVIDER_MAP.codex, "openai");
  assert.equal(FIXER_PROVIDER_MAP.claude, "anthropic");
});

test("buildFixerCmd invokes agy with claude-style write args, not the generic stdin passthrough", () => {
  const { cmd, args } = buildFixerCmd("agy", { mode: "none" });
  assert.equal(cmd, "agy");
  assert.deepEqual(args, ["--dangerously-skip-permissions", "-p", "-"]);
});

test("buildFixerCmd still routes truly-unknown custom CLIs through bare stdin", () => {
  const { cmd, args } = buildFixerCmd("somecli", { mode: "none" });
  assert.equal(cmd, "somecli");
  assert.deepEqual(args, ["-"]);
});

test("detectFixer auto-selects agy when only agy is installed", () => {
  const oldEnv = { ...process.env };
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "adversarial-fixer-"));
  const binName = process.platform === "win32" ? "agy.cmd" : "agy";
  const binPath = path.join(tempDir, binName);
  // probeFixer runs `<cmd> --version`; make the mock succeed.
  fs.writeFileSync(binPath, "#!/bin/sh\necho 1.0.0");
  if (process.platform !== "win32") {
    fs.chmodSync(binPath, 0o755);
  }
  process.env.PATH = tempDir; // Isolate PATH so only the mock agy is available

  try {
    assert.equal(detectFixer({}), "agy");
  } finally {
    process.env = oldEnv;
    try {
      fs.unlinkSync(binPath);
      fs.rmdirSync(tempDir);
    } catch {}
  }
});
