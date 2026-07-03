import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// T6 / GitHub #10 — end-to-end --input artifact review mode against the real
// bin/cli.js. Artifact mode skips git entirely, so the harness is just a temp dir
// with the artifact file + a mock reviewer CLI on PATH.

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const cli = path.join(root, "bin", "cli.js");
const nodeBinDir = path.dirname(process.execPath);

const APPROVE = '{"verdict":"approve","summary":"ok","coverage":{"files_examined":["spec.md"],"files_skipped":[]},"findings":[],"next_steps":[]}';
const FLAG = '{"verdict":"needs-attention","summary":"gap","coverage":{"files_examined":["spec.md"],"files_skipped":[]},"findings":[{"severity":"high","category":"other","title":"missing acceptance criteria","body":"the spec states no testable acceptance criteria","exploit_scenario":"an implementer ships something that does not match intent and no check catches it","evidence":"","file":"spec.md","line_start":0,"line_end":0,"confidence":0.9,"recommendation":"add concrete, testable acceptance criteria"}],"next_steps":["add ACs"]}';

const staticMock = (body) => `#!/bin/sh\ncat >/dev/null\ncat <<'JSON'\n${body}\nJSON\n`;

function runCli(args, { mocks = {}, artifact = "# Spec\n\nBuild the widget.\n" } = {}) {
  const mocksDir = fs.mkdtempSync(path.join(os.tmpdir(), "adv-input-mocks-"));
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "adv-input-work-"));
  try {
    for (const [name, body] of Object.entries(mocks)) {
      const binName = process.platform === "win32" ? `${name}.cmd` : name;
      const p = path.join(mocksDir, binName);
      fs.writeFileSync(p, body);
      if (process.platform !== "win32") fs.chmodSync(p, 0o755);
    }
    fs.writeFileSync(path.join(workDir, "spec.md"), artifact);
    const PATH = [mocksDir, nodeBinDir, "/usr/bin", "/bin"].join(path.delimiter);
    const r = spawnSync(process.execPath, [cli, ...args], {
      cwd: workDir,
      encoding: "utf8",
      env: { HOME: process.env.HOME, PATH }
    });
    return { status: r.status, stdout: r.stdout || "", stderr: r.stderr || "" };
  } finally {
    try { fs.rmSync(mocksDir, { recursive: true, force: true }); } catch {}
    try { fs.rmSync(workDir, { recursive: true, force: true }); } catch {}
  }
}

// ── AC4: end-to-end review of an artifact + deterministic exit code ────────────

test("AC4: --input flagged artifact → schema-valid JSON, exit 2", () => {
  const r = runCli(["--input", "spec.md", "--provider", "claude", "--json"], {
    mocks: { claude: staticMock(FLAG) }
  });
  assert.equal(r.status, 2, r.stderr);
  const result = JSON.parse(r.stdout);
  assert.equal(result.verdict, "needs-attention");
  assert.equal(result.findings.length, 1);
  assert.equal(result.findings[0].file, "spec.md");
});

test("AC4: --input clean artifact → exit 0", () => {
  const r = runCli(["--input", "spec.md", "--provider", "claude", "--json"], {
    mocks: { claude: staticMock(APPROVE) }
  });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).verdict, "approve");
});

// ── AC5: --input composes with --prompt-only (no LLM call) ─────────────────────

test("AC5: --input --prompt-only prints the artifact prompt, exit 0, no LLM call", () => {
  // No mock reviewer at all — proves no provider is invoked.
  const r = runCli(["--input", "spec.md", "--prompt-only"], {
    artifact: "# Spec\n\nSENTINEL_ARTIFACT_CONTENT here.\n"
  });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(/artifact/i.test(r.stdout), "artifact framing present in the printed prompt");
  assert.ok(r.stdout.includes("SENTINEL_ARTIFACT_CONTENT"), "artifact content embedded in the prompt");
});

// ── Fail closed: an empty artifact must never approve (exit 1, not a silent 0) ─

test("--input empty artifact fails closed with exit 1, does not approve", () => {
  // A mock reviewer is present but must NOT be reached — collection fails first.
  const r = runCli(["--input", "spec.md", "--provider", "claude", "--json"], {
    artifact: "",
    mocks: { claude: staticMock(APPROVE) }
  });
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /No reviewable content/);
});

// ── Mutual exclusion is a hard error (guards R4) ───────────────────────────────

test("--input combined with --loop is rejected", () => {
  const r = runCli(["--input", "spec.md", "--loop"], {});
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /--input/);
});
