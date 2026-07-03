import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { buildLoopSummary } from "../src/loop.js";

// T5 / GitHub #11 — a consolidated `loop_summary` NDJSON event emitted as the
// terminal line at every --loop exit, so a P6 gate-manifest consumer reads ONE
// record (providers, iterations, verdict, exitReason, survivingCount,
// acceptedCount) instead of correlating loop_end + review_result by hand.

// ── AC1: pure helper — verdict derivation, acceptedCount, shape, passthrough ──

const NON_CLEAN = ["no-progress", "ceiling", "no-diff", "fixer-error", "fixer-timeout"];

test("AC1: buildLoopSummary derives verdict approve IFF exitReason is clean", () => {
  const clean = buildLoopSummary({ providers: ["claude"], iterations: 0, exitReason: "clean", survivingCount: 0 });
  assert.equal(clean.verdict, "approve");
  for (const exitReason of NON_CLEAN) {
    const s = buildLoopSummary({ providers: ["claude"], iterations: 2, exitReason, survivingCount: 3 });
    assert.equal(s.verdict, "needs-attention", `${exitReason} must be needs-attention`);
  }
});

test("AC1: acceptedCount is always 0 (human-owned P6 value)", () => {
  for (const exitReason of ["clean", ...NON_CLEAN]) {
    const s = buildLoopSummary({ providers: ["x"], iterations: 1, exitReason, survivingCount: 5 });
    assert.equal(s.acceptedCount, 0, `${exitReason} acceptedCount must be 0`);
  }
});

test("AC1: object has exactly the seven summary keys", () => {
  const s = buildLoopSummary({ providers: ["a"], iterations: 1, exitReason: "clean", survivingCount: 0 });
  assert.deepEqual(
    Object.keys(s).sort(),
    ["acceptedCount", "exitReason", "iterations", "providers", "survivingCount", "type", "verdict"]
  );
  assert.equal(s.type, "loop_summary");
});

test("AC1: providers, iterations, survivingCount pass through unchanged", () => {
  const providers = ["claude", "gemini"];
  const s = buildLoopSummary({ providers, iterations: 7, exitReason: "ceiling", survivingCount: 4 });
  assert.equal(s.providers, providers); // same reference — no copy/mutation
  assert.equal(s.iterations, 7);
  assert.equal(s.survivingCount, 4);
});

// ── End-to-end harness: drive the real binary in --loop mode against a
//    throwaway repo with mock CLIs, exactly like test/loop-providers.test.mjs ──

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const cli = path.join(root, "bin", "cli.js");
const nodeBinDir = path.dirname(process.execPath);

const APPROVE = '{"verdict":"approve","summary":"ok","coverage":{"files_examined":["code.js"],"files_skipped":[]},"findings":[],"next_steps":[]}';
const FLAG = '{"verdict":"needs-attention","summary":"bad","coverage":{"files_examined":["code.js"],"files_skipped":[]},"findings":[{"severity":"high","category":"security","title":"t","body":"b","exploit_scenario":"e","evidence":"","file":"code.js","line_start":1,"line_end":1,"confidence":0.9,"recommendation":"r"}],"next_steps":["n"]}';

// Reviewer mock: read+discard stdin, print a static JSON body.
const staticMock = (body) => `#!/bin/sh\ncat >/dev/null\ncat <<'JSON'\n${body}\nJSON\n`;
// Fixer mocks: a no-op (no change); one that mutates the reviewed file; and one
// that writes a partial change then exits non-zero (drives the fixer-error path).
const NOOP_FIXER = `#!/bin/sh\ncat >/dev/null\nexit 0\n`;
const MARKER_FIXER = `#!/bin/sh\ncat >/dev/null\nprintf '// FIXED\\n' >> code.js\nexit 0\n`;
const ERR_FIXER = `#!/bin/sh\ncat >/dev/null\nprintf '// partial\\n' >> code.js\nexit 1\n`;

// A reviewer that flags a DIFFERENT gating finding each round: line_start jumps by
// 10 per applied fix (counted via the FIXED markers in the diff), so the gating
// set never repeats (>5 apart ⇒ findingsMatch is false) and the loop reaches the
// ceiling instead of tripping the no-progress guard first.
const VARYING_FLAG_REVIEWER =
  `#!/bin/sh\n` +
  `INPUT=$(cat)\n` +
  `N=$(printf '%s' "$INPUT" | grep -c 'FIXED')\n` +
  `LINE=$(( (N + 1) * 10 ))\n` +
  `cat <<JSON\n` +
  `{"verdict":"needs-attention","summary":"bad","coverage":{"files_examined":["code.js"],"files_skipped":[]},"findings":[{"severity":"high","category":"security","title":"t","body":"b","exploit_scenario":"e","evidence":"","file":"code.js","line_start":$LINE,"line_end":$LINE,"confidence":0.9,"recommendation":"r"}],"next_steps":["n"]}\n` +
  `JSON\n`;

function runLoopCli(args, { mocks = {}, dirty = true } = {}) {
  const mocksDir = fs.mkdtempSync(path.join(os.tmpdir(), "adv-summary-mocks-"));
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "adv-summary-repo-"));
  try {
    for (const [name, body] of Object.entries(mocks)) {
      const binName = process.platform === "win32" ? `${name}.cmd` : name;
      const p = path.join(mocksDir, binName);
      fs.writeFileSync(p, body);
      if (process.platform !== "win32") fs.chmodSync(p, 0o755);
    }
    const git = (a) => spawnSync("git", a, { cwd: repoDir, encoding: "utf8" });
    git(["init", "-q"]);
    git(["config", "user.email", "t@example.com"]);
    git(["config", "user.name", "Test"]);
    fs.writeFileSync(path.join(repoDir, "code.js"), "export const x = 1;\n");
    git(["add", "."]);
    git(["commit", "-qm", "init"]);
    // A committed, CLEAN working tree (dirty=false) drives the empty-first-review
    // terminal site; otherwise leave a real uncommitted change to review.
    if (dirty) fs.writeFileSync(path.join(repoDir, "code.js"), "export const x = 2; // changed\n");

    const PATH = [mocksDir, nodeBinDir, "/usr/bin", "/bin"].join(path.delimiter);
    const r = spawnSync(process.execPath, [cli, ...args], {
      cwd: repoDir,
      encoding: "utf8",
      env: { HOME: process.env.HOME, PATH }
    });
    return { status: r.status, stdout: r.stdout || "", stderr: r.stderr || "" };
  } finally {
    try { fs.rmSync(mocksDir, { recursive: true, force: true }); } catch {}
    try { fs.rmSync(repoDir, { recursive: true, force: true }); } catch {}
  }
}

// The single-provider loop auto-detects the reviewer CLI (claude→codex→agy); with
// only `claude` mocked it resolves to claude, and `myfixer` is the explicit fixer.
const BASE = ["--loop", "--loop-unsafe", "--scope", "working-tree", "--allow-secrets", "--loop-fixer", "myfixer"];

function summaryLines(stdout) {
  return stdout
    .split("\n")
    .filter(Boolean)
    .map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter((e) => e && e.type === "loop_summary");
}

// ── AC2: clean exit emits the terminal loop_summary (approve, surviving 0) ─────

test("AC2: clean --loop --json emits a final loop_summary (approve, surviving 0)", () => {
  const r = runLoopCli(["--json", ...BASE], {
    mocks: { claude: staticMock(APPROVE), myfixer: NOOP_FIXER }
  });
  assert.equal(r.status, 0, r.stderr);
  const events = r.stdout.split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const summaries = events.filter((e) => e.type === "loop_summary");
  assert.equal(summaries.length, 1, "exactly one loop_summary");
  // It is the LAST NDJSON line — the consolidated terminal record.
  assert.equal(events[events.length - 1].type, "loop_summary");
  assert.deepEqual(summaries[0], {
    type: "loop_summary",
    providers: ["claude"],
    iterations: 0,
    verdict: "approve",
    exitReason: "clean",
    survivingCount: 0,
    acceptedCount: 0
  });
});

test("AC2: empty-first-review clean exit → loop_summary iterations 0, approve, surviving 0", () => {
  // No uncommitted change → the working tree is empty → the loop exits clean
  // BEFORE any review/fix runs. Exercises the empty-first-review terminal site
  // (iterations must be exactly 0, not fixCount+1).
  const r = runLoopCli(["--json", ...BASE], {
    dirty: false,
    mocks: { claude: staticMock(APPROVE), myfixer: NOOP_FIXER }
  });
  assert.equal(r.status, 0, r.stderr);
  const s = summaryLines(r.stdout);
  assert.equal(s.length, 1, r.stdout);
  assert.deepEqual(s[0], {
    type: "loop_summary",
    providers: ["claude"],
    iterations: 0,
    verdict: "approve",
    exitReason: "clean",
    survivingCount: 0,
    acceptedCount: 0
  });
});

// ── AC3: non-clean exits emit a loop_summary with surviving >= 1 ───────────────

test("AC3(a): no-diff exit → loop_summary needs-attention, surviving >= 1", () => {
  const r = runLoopCli(["--json", ...BASE], {
    mocks: { claude: staticMock(FLAG), myfixer: NOOP_FIXER }
  });
  assert.equal(r.status, 2, r.stderr);
  const s = summaryLines(r.stdout);
  assert.equal(s.length, 1, r.stdout);
  assert.equal(s[0].verdict, "needs-attention");
  assert.equal(s[0].exitReason, "no-diff");
  assert.equal(s[0].survivingCount, 1);
  // Exact, not >=: the no-op fixer runs on the first round, so iterations is 0
  // (a +1 off-by-one at this site must fail here).
  assert.equal(s[0].iterations, 0);
});

test("AC3(b): no-progress exit → loop_summary needs-attention, surviving 1, iterations 1", () => {
  const r = runLoopCli(["--json", ...BASE.slice(0, -1), "markerfixer"], {
    mocks: { claude: staticMock(FLAG), markerfixer: MARKER_FIXER }
  });
  assert.equal(r.status, 2, r.stderr);
  const s = summaryLines(r.stdout);
  assert.equal(s.length, 1, r.stdout);
  assert.equal(s[0].verdict, "needs-attention");
  assert.equal(s[0].exitReason, "no-progress");
  assert.equal(s[0].survivingCount, 1);
  // Exactly one fix ran before the repeat was detected — pins the off-by-one.
  assert.equal(s[0].iterations, 1);
});

test("AC3(c): ceiling exit → loop_summary needs-attention, exitReason ceiling, iterations 1", () => {
  // A reviewer that flags a fresh finding each round + a file-changing fixer +
  // --loop-max 1 reaches the ceiling on the second review (no-progress never
  // fires because the gating set differs every round).
  const r = runLoopCli(["--json", "--loop-max", "1", ...BASE.slice(0, -1), "markerfixer"], {
    mocks: { claude: VARYING_FLAG_REVIEWER, markerfixer: MARKER_FIXER }
  });
  assert.equal(r.status, 2, r.stderr);
  const s = summaryLines(r.stdout);
  assert.equal(s.length, 1, r.stdout);
  assert.equal(s[0].verdict, "needs-attention");
  assert.equal(s[0].exitReason, "ceiling");
  assert.equal(s[0].survivingCount, 1);
  assert.equal(s[0].iterations, 1);
});

test("AC3(d): fixer-error exit → loop_summary needs-attention, exitReason fixer-error, iterations 0", () => {
  // The fixer writes a partial change then exits non-zero on the first round.
  const r = runLoopCli(["--json", ...BASE.slice(0, -1), "errfixer"], {
    mocks: { claude: staticMock(FLAG), errfixer: ERR_FIXER }
  });
  assert.equal(r.status, 2, r.stderr);
  const s = summaryLines(r.stdout);
  assert.equal(s.length, 1, r.stdout);
  assert.equal(s[0].verdict, "needs-attention");
  assert.equal(s[0].exitReason, "fixer-error");
  assert.equal(s[0].survivingCount, 1);
  assert.equal(s[0].iterations, 0);
});

// ── AC4: loop_summary is json-gated (parity with every other loop event) ───────

test("AC4: a non-json clean loop emits NO loop_summary to stdout", () => {
  const r = runLoopCli([...BASE], {
    mocks: { claude: staticMock(APPROVE), myfixer: NOOP_FIXER }
  });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(!r.stdout.includes("loop_summary"), "loop_summary must not appear without --json");
});

// ── AC5: multi-provider (--providers) — providers carries the resolved ids ─────

test("AC5: --providers loop → loop_summary.providers is the resolved provider ids, not families", () => {
  // The gemini family resolves to the local agy CLI, but its provider id stays the
  // requested token "gemini". The claude token's id is "claude" (its FAMILY is
  // "anthropic") — so ["claude","gemini"] proves the summary carries provider ids,
  // not family labels (which would be ["anthropic","gemini"]).
  const r = runLoopCli(["--providers", "claude,gemini", "--json", ...BASE], {
    mocks: { claude: staticMock(APPROVE), agy: staticMock(APPROVE), myfixer: NOOP_FIXER }
  });
  assert.equal(r.status, 0, r.stderr);
  const s = summaryLines(r.stdout);
  assert.equal(s.length, 1, r.stdout);
  assert.deepEqual(s[0].providers, ["claude", "gemini"]);
  assert.equal(s[0].verdict, "approve");
});
