import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// End-to-end coverage for the bin/cli.js multi-provider orchestration glue
// (runMultiProvider): under-satisfied notice emission, the API-without-diff guard,
// and verdict→exit-code mapping. Drives the real binary with mock provider CLIs.

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const cli = path.join(root, "bin", "cli.js");
const nodeBinDir = path.dirname(process.execPath); // has node (+ codex, which we don't request)

const APPROVE = '{"verdict":"approve","summary":"ok","coverage":{"files_examined":["a"],"files_skipped":[]},"findings":[],"next_steps":[]}';
const FLAG = '{"verdict":"needs-attention","summary":"bad","coverage":{"files_examined":["a"],"files_skipped":[]},"findings":[{"severity":"high","category":"security","title":"t","body":"b","exploit_scenario":"e","evidence":"","file":"a","line_start":1,"line_end":2,"confidence":0.9,"recommendation":"r"}],"next_steps":["n"]}';

// Run bin/cli.js with a PATH containing only: our mock dir, the node bin dir, and
// system dirs for git. Notably EXCLUDES ~/.local/bin, so claude/agy are reachable
// only via the mocks we plant. Returns { status, stdout, stderr }.
function runCli(args, { mocks = {}, env = {} } = {}) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "adv-cli-"));
  try {
    for (const [name, body] of Object.entries(mocks)) {
      const binName = process.platform === "win32" ? `${name}.cmd` : name;
      const p = path.join(tempDir, binName);
      fs.writeFileSync(p, `#!/bin/sh\ncat >/dev/null\ncat <<'JSON'\n${body}\nJSON\n`);
      if (process.platform !== "win32") fs.chmodSync(p, 0o755);
    }
    const PATH = [tempDir, nodeBinDir, "/usr/bin", "/bin"].join(path.delimiter);
    const baseEnv = {
      HOME: process.env.HOME,
      PATH
    };
    const r = spawnSync(process.execPath, [cli, ...args], {
      cwd: root,
      encoding: "utf8",
      env: { ...baseEnv, ...env }
    });
    return { status: r.status, stdout: r.stdout || "", stderr: r.stderr || "" };
  } finally {
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
  }
}

test("CLI: multi-provider needs-attention maps to exit 2 (both providers reachable)", () => {
  const r = runCli(["--providers", "claude,gemini", "--scope", "working-tree", "--allow-secrets"], {
    mocks: { claude: FLAG, agy: APPROVE }
  });
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, /Multi-provider review/);
  assert.match(r.stderr, /1\/2 provider\(s\) flagged/);
});

test("CLI: under-satisfied emits a loud notice and proceeds (AC7 end-to-end)", () => {
  // Request claude+gemini, but only mock claude is present (agy not on PATH, no keys).
  const r = runCli(["--providers", "claude,gemini", "--scope", "working-tree", "--allow-secrets"], {
    mocks: { claude: FLAG }
  });
  assert.match(r.stderr, /Under-satisfied/, "loud under-satisfied notice must reach stderr");
  assert.match(r.stderr, /1 of 2/);
  assert.equal(r.status, 2, "proceeds with the reachable provider's flagging result → exit 2");
});

test("CLI: under-satisfied single approve proceeds to exit 0", () => {
  const r = runCli(["--providers", "claude,gemini", "--scope", "working-tree", "--allow-secrets"], {
    mocks: { claude: APPROVE }
  });
  assert.match(r.stderr, /Under-satisfied/);
  assert.equal(r.status, 0);
});

test("CLI: API provider without an inlinable diff is blocked (exit 1)", () => {
  // gemini API key present (no CLI needed); --max-bytes 1 forces summary mode so the
  // diff cannot be inlined → the apiWithoutDiff guard must block before any API call.
  const r = runCli(
    ["--providers", "gemini", "--scope", "working-tree", "--allow-secrets", "--max-bytes", "1"],
    { env: { GEMINI_API_KEY: "dummy" } }
  );
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /too large to inline|allow-summary-review/);
});
