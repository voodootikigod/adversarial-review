import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// End-to-end coverage for the bin/cli.js multi-provider orchestration glue
// (runMultiProvider): under-satisfied notice, the drop-API-on-uninlinable-diff
// path, JSON/exit verdict unification, and verdict→exit-code mapping. Drives the
// real binary against a SELF-CONTAINED temp git repo so the tests do not depend
// on the host working tree being dirty (a clean checkout/CI must still pass).

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const cli = path.join(root, "bin", "cli.js");
const nodeBinDir = path.dirname(process.execPath); // has node (+ codex, which we don't request)

const APPROVE = '{"verdict":"approve","summary":"ok","coverage":{"files_examined":["code.js"],"files_skipped":[]},"findings":[],"next_steps":[]}';
const FLAG = '{"verdict":"needs-attention","summary":"bad","coverage":{"files_examined":["code.js"],"files_skipped":[]},"findings":[{"severity":"high","category":"security","title":"t","body":"b","exploit_scenario":"e","evidence":"","file":"code.js","line_start":1,"line_end":1,"confidence":0.9,"recommendation":"r"}],"next_steps":["n"]}';

// Run bin/cli.js against a throwaway git repo that has a real uncommitted change,
// with PATH limited to a mock dir + node + system git (EXCLUDES ~/.local/bin, so
// claude/agy are reachable only via the mocks we plant). Returns {status,stdout,stderr}.
function runCli(args, { mocks = {}, env = {}, afterRun } = {}) {
  const mocksDir = fs.mkdtempSync(path.join(os.tmpdir(), "adv-cli-mocks-"));
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "adv-cli-repo-"));
  try {
    for (const [name, body] of Object.entries(mocks)) {
      const binName = process.platform === "win32" ? `${name}.cmd` : name;
      const p = path.join(mocksDir, binName);
      fs.writeFileSync(p, `#!/bin/sh\ncat >/dev/null\ncat <<'JSON'\n${body}\nJSON\n`);
      if (process.platform !== "win32") fs.chmodSync(p, 0o755);
    }
    const git = (a) => spawnSync("git", a, { cwd: repoDir, encoding: "utf8" });
    git(["init", "-q"]);
    git(["config", "user.email", "t@example.com"]);
    git(["config", "user.name", "Test"]);
    fs.writeFileSync(path.join(repoDir, "code.js"), "export const x = 1;\n");
    git(["add", "."]);
    git(["commit", "-qm", "init"]);
    // Uncommitted change so --scope working-tree is non-empty regardless of host state.
    fs.writeFileSync(path.join(repoDir, "code.js"), "export const x = 2; // changed\n");

    const PATH = [mocksDir, nodeBinDir, "/usr/bin", "/bin"].join(path.delimiter);
    const r = spawnSync(process.execPath, [cli, ...args], {
      cwd: repoDir,
      encoding: "utf8",
      env: { HOME: process.env.HOME, PATH, ...env }
    });
    const out = { status: r.status, stdout: r.stdout || "", stderr: r.stderr || "" };
    if (afterRun) afterRun(repoDir, out);
    return out;
  } finally {
    try { fs.rmSync(mocksDir, { recursive: true, force: true }); } catch {}
    try { fs.rmSync(repoDir, { recursive: true, force: true }); } catch {}
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
  const r = runCli(["--providers", "claude,gemini", "--scope", "working-tree", "--allow-secrets"], {
    mocks: { claude: FLAG } // agy absent, no keys → gemini unreachable
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

test("CLI #2: --json verdict matches the quorum exit verdict (no contradiction)", () => {
  // One provider flags, but --quorum 2 with two providers → effective quorum 2 not
  // met → approve/exit 0. The JSON verdict must agree (not the raw merge verdict).
  const r = runCli(
    ["--providers", "claude,gemini", "--quorum", "2", "--json", "--scope", "working-tree", "--allow-secrets"],
    { mocks: { claude: FLAG, agy: APPROVE } }
  );
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.verdict, "approve", "JSON verdict must match the exit-code (quorum) verdict");
});

test("CLI #2(r5): when quorum is not met, the JSON summary matches the approve verdict", () => {
  // claude flags, gemini approves, --quorum 2 → effective quorum 2 not met → approve.
  // The summary must NOT be the flagging provider's (no approve+problem-summary).
  const r = runCli(
    ["--providers", "claude,gemini", "--quorum", "2", "--json", "--scope", "working-tree", "--allow-secrets"],
    { mocks: { claude: FLAG, agy: APPROVE } }
  );
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.verdict, "approve");
  assert.notEqual(out.summary, "bad", "summary must not be copied from the flagging provider when approving");
  assert.match(out.summary, /approving/i, "summary reflects the approve verdict");
});

test("CLI #2(r7): a needs-attention verdict never carries an approving summary", () => {
  const r = runCli(
    ["--providers", "claude,gemini", "--json", "--scope", "working-tree", "--allow-secrets"],
    { mocks: { claude: FLAG, agy: APPROVE } }
  );
  assert.equal(r.status, 2, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.verdict, "needs-attention");
  assert.match(out.summary, /raised gating findings/, "summary must reflect the gate, not a provider's approve prose");
});

test("CLI #1(r7): a non-inlinable API provider falls back to its local CLI instead of being dropped", () => {
  const r = runCli(
    ["--providers", "gemini", "--scope", "working-tree", "--allow-secrets", "--max-bytes", "1"],
    { mocks: { agy: FLAG }, env: { GEMINI_API_KEY: "dummy" } }
  );
  assert.match(r.stderr, /using local agy/, "API gemini downgrades to the agy CLI");
  assert.equal(r.status, 2, "agy reviews the summary-mode diff and flags → exit 2");
});

test("CLI #6: an API provider on a non-inlinable diff is dropped, CLI provider proceeds", () => {
  // gemini resolves to the API (key set); --max-bytes 1 forces summary mode so it
  // cannot inspect the diff. It must be dropped (loud), and claude (CLI) proceeds.
  const r = runCli(
    ["--providers", "claude,gemini", "--scope", "working-tree", "--allow-secrets", "--max-bytes", "1"],
    { mocks: { claude: FLAG }, env: { GEMINI_API_KEY: "dummy" } }
  );
  assert.match(r.stderr, /Dropping 1 API provider/);
  assert.match(r.stderr, /gemini/);
  assert.equal(r.status, 2, "claude (CLI) still reviews and flags → exit 2");
});

test("CLI #5: grounding warnings reach stderr even with --json", () => {
  // A finding quoting evidence that does not appear in the diff must be flagged
  // ungrounded on stderr even though --json suppresses the rendered report.
  const UNGROUNDED = '{"verdict":"needs-attention","summary":"s","coverage":{"files_examined":["code.js"],"files_skipped":[]},"findings":[{"severity":"high","category":"security","title":"t","body":"b","exploit_scenario":"e","evidence":"this-string-is-not-in-the-diff-xyz","file":"code.js","line_start":1,"line_end":1,"confidence":0.9,"recommendation":"r"}],"next_steps":["n"]}';
  const r = runCli(["--providers", "claude", "--json", "--scope", "working-tree", "--allow-secrets"], {
    mocks: { claude: UNGROUNDED }
  });
  assert.match(r.stderr, /quoted evidence was not found/i, "ungrounded warning must reach stderr under --json");
  // stdout stays pure JSON.
  assert.doesNotThrow(() => JSON.parse(r.stdout));
});

test("CLI: no requested provider reachable exits 1 (operational error, not a verdict)", () => {
  // gemini requested, but no GEMINI_API_KEY and no agy on PATH → nothing reachable.
  const r = runCli(["--providers", "gemini", "--scope", "working-tree", "--allow-secrets"], { mocks: {} });
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /None of the requested providers are reachable/);
});

test("CLI #6: all-API selection on a non-inlinable diff exits 1 (nothing usable)", () => {
  const r = runCli(
    ["--providers", "gemini", "--scope", "working-tree", "--allow-secrets", "--max-bytes", "1"],
    { env: { GEMINI_API_KEY: "dummy" } }
  );
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /No usable providers/);
});

// ─── findings-ledger integration (T3) ───────────────────────────────────────

test("ledger AC3: without --findings-ledger, no .adlc/ is created and no ledger warning", () => {
  let adlcExists = true;
  const r = runCli(["--providers", "claude", "--scope", "working-tree", "--allow-secrets"], {
    mocks: { claude: FLAG },
    afterRun: (repoDir) => { adlcExists = fs.existsSync(path.join(repoDir, ".adlc")); }
  });
  assert.equal(adlcExists, false, "no flag → must not create .adlc/");
  assert.doesNotMatch(r.stderr, /findings ledger/i, "no ledger warning when the flag is absent");
});

test("ledger: records the MERGED findings (shared corroborated once + each unique), R2", () => {
  // claude: shared + onlyA ; agy: shared + onlyB. Merged = 3 distinct gating
  // findings → 3 ledger lines. This distinguishes "merged" from BOTH "per-provider
  // loop" (would give 4) and "first provider only" (would give 2).
  const f = (file, title) =>
    `{"severity":"high","category":"security","title":"${title}","body":"b","exploit_scenario":"e","evidence":"","file":"${file}","line_start":1,"line_end":1,"confidence":0.9,"recommendation":"r"}`;
  const res = (findings) =>
    `{"verdict":"needs-attention","summary":"s","coverage":{"files_examined":[],"files_skipped":[]},"findings":[${findings}],"next_steps":["n"]}`;
  const claudeOut = res([f("shared.js", "Shared issue"), f("a.js", "Only in A")].join(","));
  const agyOut = res([f("shared.js", "Shared issue"), f("b.js", "Only in B")].join(","));

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "adv-ledger-merge-"));
  const ledger = path.join(dir, "f.jsonl");
  try {
    runCli(
      ["--providers", "claude,gemini", "--scope", "working-tree", "--allow-secrets", "--findings-ledger", ledger],
      { mocks: { claude: claudeOut, agy: agyOut } }
    );
    const lines = fs.readFileSync(ledger, "utf8").trim().split("\n").filter(Boolean);
    assert.equal(lines.length, 3, "shared corroborated finding counts once; both uniques recorded");
    const descs = lines.map((l) => JSON.parse(l).desc).sort();
    assert.deepEqual(descs, ["Only in A", "Only in B", "Shared issue"]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("ledger: default single-provider path records grounded gating findings only", () => {
  // No --providers → the single-provider path (auto-detects the mock claude). The
  // finding is ungrounded (evidence absent from the diff) so its grounded
  // confidence falls below the floor → it must NOT gate and must NOT be recorded.
  // Pins that real `assessments` reach the default-path ledger write (kills the
  // `recordFindings(args, result, null)` survivor).
  const UNGROUNDED = '{"verdict":"needs-attention","summary":"s","coverage":{"files_examined":["code.js"],"files_skipped":[]},"findings":[{"severity":"high","category":"security","title":"Ungrounded high","body":"b","exploit_scenario":"e","evidence":"this-evidence-is-absent-from-the-diff-zzz","file":"code.js","line_start":1,"line_end":1,"confidence":0.9,"recommendation":"r"}],"next_steps":["n"]}';
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "adv-ledger-default-"));
  const ledger = path.join(dir, "f.jsonl");
  try {
    const r = runCli(["--findings-ledger", ledger, "--scope", "working-tree", "--allow-secrets"], {
      mocks: { claude: UNGROUNDED }
    });
    assert.equal(r.status, 0, "ungrounded finding is below the grounded floor → approve/exit 0");
    assert.equal(fs.existsSync(ledger), false, "ungrounded finding must not be recorded (ledger set == gate set)");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("ledger: default single-provider path WRITES a grounded gating finding (positive)", () => {
  // No --providers → single-provider path. The finding's evidence is present in the
  // temp repo's diff, so it stays grounded above the floor and gates. Asserts the
  // ledger IS written on the default path (kills deletion of the single-provider
  // recordFindings call — the negative-only H1 test cannot).
  const GROUNDED = '{"verdict":"needs-attention","summary":"s","coverage":{"files_examined":["code.js"],"files_skipped":[]},"findings":[{"severity":"high","category":"security","title":"Grounded high","body":"b","exploit_scenario":"e","evidence":"export const x = 2","file":"code.js","line_start":1,"line_end":1,"confidence":0.9,"recommendation":"r"}],"next_steps":["n"]}';
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "adv-ledger-default-pos-"));
  const ledger = path.join(dir, "f.jsonl");
  try {
    const r = runCli(["--findings-ledger", ledger, "--scope", "working-tree", "--allow-secrets"], {
      mocks: { claude: GROUNDED }
    });
    assert.equal(r.status, 2, "grounded high finding gates → needs-attention");
    assert.equal(fs.existsSync(ledger), true, "grounded gating finding IS recorded on the default path");
    const lines = fs.readFileSync(ledger, "utf8").trim().split("\n").filter(Boolean);
    assert.equal(lines.length, 1);
    const e = JSON.parse(lines[0]);
    assert.equal(e.tool, "adversarial-review");
    assert.equal(e.desc, "Grounded high");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("ledger AC4: --findings-ledger appends gating findings as JSONL across runs", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "adv-ledger-"));
  const ledger = path.join(dir, "findings.jsonl");
  try {
    const a = ["--providers", "claude", "--scope", "working-tree", "--allow-secrets", "--findings-ledger", ledger];
    runCli(a, { mocks: { claude: FLAG } });
    runCli(a, { mocks: { claude: FLAG } });
    const lines = fs.readFileSync(ledger, "utf8").trim().split("\n");
    assert.equal(lines.length, 2, "two runs append (not truncate) → 2 entries");
    for (const line of lines) {
      const e = JSON.parse(line);
      assert.equal(e.tool, "adversarial-review");
      assert.equal(e.severity, "high"); // FLAG's gating finding
      assert.deepEqual(Object.keys(e).sort(), ["category", "desc", "file", "line", "severity", "tool", "ts"]);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("ledger AC6: an unwritable ledger path warns but does not fail the review", () => {
  // Make the parent a FILE so mkdir of the ledger's dir fails (ENOTDIR).
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "adv-ledger-"));
  const blocker = path.join(dir, "blocker");
  fs.writeFileSync(blocker, "x");
  try {
    const r = runCli(
      ["--providers", "claude", "--scope", "working-tree", "--allow-secrets", "--findings-ledger", path.join(blocker, "sub", "f.jsonl")],
      { mocks: { claude: FLAG } }
    );
    assert.equal(r.status, 2, "review still exits on its verdict, not 1");
    assert.match(r.stderr, /Could not write findings ledger/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
