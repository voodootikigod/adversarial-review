import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolveBranchBaseSha } from "../src/loop.js";
import { makeGit } from "./helpers/git-retry.mjs";
import { writeMockBin } from "./helpers/mock-bin.mjs";

// T7 / GitHub #12 — branch-scope --loop. Reviews <branch> vs <base>, commits fixes
// onto the FEATURE branch, resets --hard on a failed fix. The load-bearing safety
// property: the base ref (main) sha NEVER moves — the loop only writes the feature
// branch. These drive the real bin/cli.js against a throwaway repo with mock CLIs.

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const cli = path.join(root, "bin", "cli.js");
const nodeBinDir = path.dirname(process.execPath);

const APPROVE = '{"verdict":"approve","summary":"ok","coverage":{"files_examined":["code.js"],"files_skipped":[]},"findings":[],"next_steps":[]}';
const FLAG = '{"verdict":"needs-attention","summary":"bad","coverage":{"files_examined":["code.js"],"files_skipped":[]},"findings":[{"severity":"high","category":"security","title":"t","body":"b","exploit_scenario":"e","evidence":"","file":"code.js","line_start":1,"line_end":1,"confidence":0.9,"recommendation":"r"}],"next_steps":["n"]}';

// Reviewer mocks (read stdin = the prompt incl. the branch diff): static, or
// "smart" (APPROVE once the diff carries FIXED_MARKER — proves per-round re-review).
const staticMock = (body) => `
import fs from "node:fs";
process.stdin.resume();
process.stdin.on("end", () => {
  process.stdout.write(${JSON.stringify(body)});
});
`;
const smartMock = `
import fs from "node:fs";
const input = fs.readFileSync(0, "utf8");
if (input.includes("FIXED_MARKER")) {
  process.stdout.write(${JSON.stringify(APPROVE)});
} else {
  process.stdout.write(${JSON.stringify(FLAG)});
}
`;
// A reviewer that flags a DIFFERENT finding each round (line jumps by 10 per marker)
// so the gating set never repeats → the loop reaches the ceiling, not no-progress.
const varyingMock = `
import fs from "node:fs";
const input = fs.readFileSync(0, "utf8");
const count = (input.match(/FIXED_MARKER/g) || []).length;
const line = (count + 1) * 10;
const res = {
  verdict: "needs-attention",
  summary: "bad",
  coverage: { files_examined: ["code.js"], files_skipped: [] },
  findings: [{
    severity: "high", category: "security", title: "t", body: "b", exploit_scenario: "e",
    evidence: "", file: "code.js", line_start: line, line_end: line, confidence: 0.9, recommendation: "r"
  }],
  next_steps: ["n"]
};
process.stdout.write(JSON.stringify(res));
`;

// Fixer mocks: append a marker (resolves + changes the tree), no-op, or partial+fail.
const MARKER_FIXER = `
import fs from "node:fs";
fs.appendFileSync("code.js", "\\n// FIXED_MARKER\\n");
process.exit(0);
`;
const NOOP_FIXER = `
process.exit(0);
`;
const ERR_FIXER = `
import fs from "node:fs";
fs.appendFileSync("code.js", "\\n// partial\\n");
process.exit(1);
`;

// ── resolveBranchBaseSha unit tests (kills the base-resolution hollow survivors:
//    the pin's VALUE, the invalid-ref guard, and the develop/master fallback) ────

function makeRepo(defaultBranch) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "adv-bl-unit-"));
  const git = makeGit(dir);
  git(["init", "-q", "-b", defaultBranch]);
  git(["config", "user.email", "t@example.com"]);
  git(["config", "user.name", "Test"]);
  git(["config", "commit.gpgsign", "false"]);
  fs.writeFileSync(path.join(dir, "f.txt"), "hi\n");
  git(["add", "."]);
  git(["commit", "-qm", "init"]);
  return { dir, git };
}

test("resolveBranchBaseSha: an explicit base ref resolves to that ref's commit sha", () => {
  const { dir, git } = makeRepo("main");
  try {
    const expected = git(["rev-parse", "main^{commit}"]).stdout.trim();
    assert.equal(resolveBranchBaseSha(dir, "main"), expected);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveBranchBaseSha: an invalid base ref throws (guard is load-bearing)", () => {
  const { dir } = makeRepo("main");
  try {
    assert.throws(() => resolveBranchBaseSha(dir, "no-such-ref-xyz"), /Invalid base ref/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveBranchBaseSha: with no base, auto-resolves to develop when main is absent", () => {
  const { dir, git } = makeRepo("develop");
  try {
    const expected = git(["rev-parse", "develop^{commit}"]).stdout.trim();
    assert.equal(resolveBranchBaseSha(dir, null), expected);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── Integration tests for bin/cli.js --loop with branch scope ──────────────

function runBranchLoopCli(args, { mocks = {}, dirty = false, fixer = "myfixer", detach = false } = {}) {
  const mocksDir = fs.mkdtempSync(path.join(os.tmpdir(), "adv-bl-mocks-"));
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "adv-bl-repo-"));
  const git = makeGit(repoDir);
  try {
    for (const [name, body] of Object.entries(mocks)) {
      writeMockBin(mocksDir, name, body);
    }
    git(["init", "-q", "-b", "main"]);
    git(["config", "user.email", "t@example.com"]);
    git(["config", "user.name", "Test"]);
    git(["config", "commit.gpgsign", "false"]);
    git(["config", "tag.gpgsign", "false"]);
    fs.writeFileSync(path.join(repoDir, "code.js"), "export const x = 1;\n");
    git(["add", "."]);
    git(["commit", "-qm", "base"]);
    git(["checkout", "-q", "-b", "feature"]);
    fs.writeFileSync(path.join(repoDir, "code.js"), "export const x = 2; // needs fix\n");
    git(["commit", "-qam", "feature change"]);
    if (dirty) fs.writeFileSync(path.join(repoDir, "code.js"), "export const x = 3; // uncommitted\n");
    if (detach) git(["checkout", "-q", "--detach"]);

    const baseSha = git(["rev-parse", "main"]).stdout.trim();
    const headBefore = git(["rev-parse", "HEAD"]).stdout.trim();

    let sysDirs = ["/usr/bin", "/bin"];
    if (process.platform === "win32") {
      const whereGit = spawnSync("where.exe", ["git"], { encoding: "utf8" });
      if (whereGit.status === 0 && whereGit.stdout.trim()) {
        sysDirs = [path.dirname(whereGit.stdout.trim().split(/\r?\n/)[0])];
      }
    }
    const PATH = [mocksDir, nodeBinDir, ...sysDirs].join(path.delimiter);
    const cliArgs = [...args];
    if (process.platform === "win32" && !cliArgs.includes("--loop-unsafe")) {
      cliArgs.push("--loop-unsafe");
    }
    const r = spawnSync(process.execPath, [cli, ...cliArgs, "--loop-fixer", fixer], {
      cwd: repoDir,
      encoding: "utf8",
      env: { HOME: process.env.HOME, PATH, ADVERSARIAL_REVIEW_CONFIG: path.join(mocksDir, "adv-config.json") }
    });
    const baseShaAfter = git(["rev-parse", "main"]).stdout.trim();
    const headAfter = git(["rev-parse", "HEAD"]).stdout.trim();
    const commitsAhead = Number(git(["rev-list", "--count", "main..HEAD"]).stdout.trim());
    const statusAfter = git(["status", "--porcelain"]).stdout.trim();
    return {
      status: r.status, stdout: r.stdout || "", stderr: r.stderr || "",
      baseSha, baseShaAfter, headBefore, headAfter, commitsAhead, statusAfter
    };
  } finally {
    try { fs.rmSync(mocksDir, { recursive: true, force: true }); } catch {}
    try { fs.rmSync(repoDir, { recursive: true, force: true }); } catch {}
  }
}

const BL = ["--loop", "--scope", "branch", "--base", "main", "--loop-unsafe", "--allow-secrets"];

function summaryLines(stdout) {
  return stdout.split("\n").filter(Boolean)
    .map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter((e) => e && e.type === "loop_summary");
}

// ── AC1: dispatch + clean-tree precondition ───────────────────────────────────

test("AC1: a dirty working tree at start is refused (exit 1), nothing committed or moved", () => {
  const r = runBranchLoopCli([...BL], { dirty: true, mocks: { claude: staticMock(FLAG), myfixer: NOOP_FIXER } });
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /clean working tree/i);
  assert.equal(r.baseShaAfter, r.baseSha, "base ref unmoved");
  assert.equal(r.headAfter, r.headBefore, "HEAD unmoved (no commit)");
});

test("AC1b: --base <ref> alone (scope auto) also routes to the branch loop", () => {
  // Dispatch must fire on args.base, not ONLY on args.scope==='branch'. With the
  // buggy && the working-tree loop would run instead (clean tree → exit 0, no
  // commit), so a committed fix (commitsAhead >= 2) proves the branch loop ran.
  const r = runBranchLoopCli(["--loop", "--base", "main", "--loop-unsafe", "--allow-secrets"], {
    mocks: { claude: smartMock, myfixer: MARKER_FIXER }
  });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.commitsAhead >= 2, "the branch loop committed the fix (not the working-tree loop)");
  assert.equal(r.baseShaAfter, r.baseSha, "base ref unmoved");
});

test("AC1c: a detached HEAD is refused (exit 1), base untouched", () => {
  const r = runBranchLoopCli([...BL], { detach: true, mocks: { claude: staticMock(FLAG), myfixer: NOOP_FIXER } });
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /detached/i);
  assert.equal(r.baseShaAfter, r.baseSha, "base ref unmoved");
});

test("AC1d: an explicit --scope working-tree wins over --base (working-tree loop, no branch commit)", () => {
  // The clean working tree makes the working-tree loop exit clean immediately; the
  // key assertion is that NO branch commit was made and --base is warned-ignored.
  const r = runBranchLoopCli(["--loop", "--scope", "working-tree", "--base", "main", "--loop-unsafe", "--allow-secrets"], {
    mocks: { claude: staticMock(FLAG), myfixer: NOOP_FIXER }
  });
  assert.match(r.stderr, /--base is ignored/, "--base is warned-ignored under explicit working-tree");
  assert.equal(r.commitsAhead, 1, "no branch commit — the working-tree loop ran, not the branch loop");
});

test("AC1e: --scope branch with NO --base auto-resolves the base (to main) and converges", () => {
  // Exercises resolveBranchBaseSha's fallback chain (upstream → origin/HEAD → main)
  // — the paths every --base test skips.
  const r = runBranchLoopCli(["--loop", "--scope", "branch", "--loop-unsafe", "--allow-secrets"], {
    mocks: { claude: smartMock, myfixer: MARKER_FIXER }
  });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.commitsAhead >= 2, "auto-resolved base + committed fix → converged");
  assert.equal(r.baseShaAfter, r.baseSha, "base ref unmoved");
});

test("AC1f: --scope working-tree with no --base does NOT warn about --base being ignored", () => {
  const r = runBranchLoopCli(["--loop", "--scope", "working-tree", "--loop-unsafe", "--allow-secrets"], {
    mocks: { claude: staticMock(FLAG), myfixer: NOOP_FIXER }
  });
  assert.ok(!/--base is ignored/.test(r.stderr), "no spurious --base-ignored warning when --base is absent");
});

// ── AC2: converge = commit the fix on the branch; base untouched ──────────────

test("AC2: fixable finding → commit on feature branch → re-review approves (exit 0), base untouched", () => {
  const r = runBranchLoopCli([...BL], { mocks: { claude: smartMock, myfixer: MARKER_FIXER } });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.baseShaAfter, r.baseSha, "BASE ref sha must be unchanged");
  assert.ok(r.commitsAhead >= 2, `feature advanced by a fix commit (ahead=${r.commitsAhead})`);
  assert.notEqual(r.headAfter, r.headBefore, "HEAD advanced by the fix commit");
});

// ── AC3: fixer error rolls back THIS round only (reset to beforeFixHead) ───────

test("AC3: fixer error → reset --hard + clean, exit 2, no partial commit, base untouched", () => {
  const r = runBranchLoopCli([...BL], { mocks: { claude: staticMock(FLAG), errfixer: ERR_FIXER }, fixer: "errfixer" });
  assert.equal(r.status, 2, r.stderr);
  assert.equal(r.baseShaAfter, r.baseSha, "base ref unmoved");
  assert.equal(r.headAfter, r.headBefore, "the failed partial fix was reset — HEAD back at the pre-fix commit");
  assert.equal(r.statusAfter, "", "working tree cleaned (no partial leftovers)");
});

// ── AC4: no-progress leaves the fix commits + prints reset recovery ───────────

test("AC4: no-progress → exit 2, fix commits REMAIN, reset-to-original recovery printed", () => {
  // Static FLAG (same finding each round) + a committing fixer → round 2's gating
  // set repeats round 1's → no-progress. The fixer's commit stays on the branch.
  const r = runBranchLoopCli([...BL], { mocks: { claude: staticMock(FLAG), myfixer: MARKER_FIXER } });
  assert.equal(r.status, 2, r.stderr);
  assert.equal(r.baseShaAfter, r.baseSha, "base ref unmoved");
  assert.ok(r.commitsAhead >= 2, "the fix commit(s) remain on the feature branch");
  assert.match(r.stderr, /git reset --hard [0-9a-f]{7,}/, "a reset-to-original recovery command is printed");
});

// ── AC4b: ceiling ─────────────────────────────────────────────────────────────

test("AC4b: ceiling (--loop-max 1, varying findings) → exit 2, commits remain, base untouched", () => {
  const r = runBranchLoopCli([...BL, "--loop-max", "1"], { mocks: { claude: varyingMock, myfixer: MARKER_FIXER } });
  assert.equal(r.status, 2, r.stderr);
  assert.equal(r.baseShaAfter, r.baseSha, "base ref unmoved");
  assert.ok(r.commitsAhead >= 2, "the fix commit remains on the feature branch");
});

// ── AC5: base ref is never a write target (explicit cross-path assertion) ──────

test("AC5: base sha is identical before/after across clean, no-diff, and error exits", () => {
  const clean = runBranchLoopCli([...BL], { mocks: { claude: smartMock, myfixer: MARKER_FIXER } });
  assert.equal(clean.baseShaAfter, clean.baseSha, "clean path: base unmoved");
  const noDiff = runBranchLoopCli([...BL], { mocks: { claude: staticMock(FLAG), myfixer: NOOP_FIXER } });
  assert.equal(noDiff.baseShaAfter, noDiff.baseSha, "no-diff path: base unmoved");
  assert.equal(noDiff.status, 2, noDiff.stderr);
  const err = runBranchLoopCli([...BL], { mocks: { claude: staticMock(FLAG), errfixer: ERR_FIXER }, fixer: "errfixer" });
  assert.equal(err.baseShaAfter, err.baseSha, "fixer-error path: base unmoved");
});

// ── AC6: loop_summary parity under --json ─────────────────────────────────────

test("AC6: branch-loop under --json emits a terminal loop_summary", () => {
  const r = runBranchLoopCli([...BL, "--json"], { mocks: { claude: smartMock, myfixer: MARKER_FIXER } });
  assert.equal(r.status, 0, r.stderr);
  const s = summaryLines(r.stdout);
  assert.equal(s.length, 1, r.stdout);
  assert.equal(s[0].verdict, "approve");
  assert.equal(s[0].exitReason, "clean");
  assert.equal(s[0].acceptedCount, 0);
});
