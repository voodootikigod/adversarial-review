import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import net from "node:net";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// End-to-end rails for the --loop + --providers capability (T-ar9).
//
// Bug: `adversarial-review --loop --providers a,b` silently ran a SINGLE-provider
// loop and dropped the multi-model request (the loop dispatch ran before the
// multi-provider branch and src/loop.js never read args.providers). The fix runs
// each provider through the loop and derives a quorum-aware verdict, emitting a
// loud under-satisfaction notice when fewer providers are reachable than asked
// for ("no silent downgrade", ADR-0007).
//
// These drive the real binary in --loop mode against a self-contained temp git
// repo with mock provider CLIs, so a clean checkout / CI still passes.

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const cli = path.join(root, "bin", "cli.js");
const nodeBinDir = path.dirname(process.execPath);

const APPROVE = '{"verdict":"approve","summary":"ok","coverage":{"files_examined":["code.js"],"files_skipped":[]},"findings":[],"next_steps":[]}';
const FLAG = '{"verdict":"needs-attention","summary":"bad","coverage":{"files_examined":["code.js"],"files_skipped":[]},"findings":[{"severity":"high","category":"security","title":"t","body":"b","exploit_scenario":"e","evidence":"","file":"code.js","line_start":1,"line_end":1,"confidence":0.9,"recommendation":"r"}],"next_steps":["n"]}';

// A reviewer mock body: static JSON, or "smart" — FLAG unless the piped prompt
// already contains FIXED_MARKER (used to prove the loop converges across rounds).
function staticMock(body) {
  return `#!/bin/sh\ncat >/dev/null\ncat <<'JSON'\n${body}\nJSON\n`;
}
function smartMock() {
  return (
    `#!/bin/sh\n` +
    `INPUT=$(cat)\n` +
    `if printf '%s' "$INPUT" | grep -q 'FIXED_MARKER'; then\n` +
    `cat <<'JSON'\n${APPROVE}\nJSON\n` +
    `else\n` +
    `cat <<'JSON'\n${FLAG}\nJSON\n` +
    `fi\n`
  );
}
// Fixer mocks: a no-op that changes nothing, and one that resolves the finding by
// writing a marker into the reviewed file so the next round's diff carries it.
const NOOP_FIXER = `#!/bin/sh\ncat >/dev/null\nexit 0\n`;
const MARKER_FIXER = `#!/bin/sh\ncat >/dev/null\nprintf '// FIXED_MARKER\\n' >> code.js\nexit 0\n`;

// Run bin/cli.js in --loop mode against a throwaway repo with a real uncommitted
// change. `mocks` maps a CLI name to its script body. Returns {status,stdout,stderr}.
function runLoopCli(args, { mocks = {}, env = {}, fileContents } = {}) {
  const mocksDir = fs.mkdtempSync(path.join(os.tmpdir(), "adv-loop-mocks-"));
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "adv-loop-repo-"));
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
    fs.writeFileSync(path.join(repoDir, "code.js"), fileContents || "export const x = 2; // changed\n");

    const PATH = [mocksDir, nodeBinDir, "/usr/bin", "/bin"].join(path.delimiter);
    const r = spawnSync(process.execPath, [cli, ...args], {
      cwd: repoDir,
      encoding: "utf8",
      env: { HOME: process.env.HOME, PATH, ...env }
    });
    return { status: r.status, stdout: r.stdout || "", stderr: r.stderr || "" };
  } finally {
    try { fs.rmSync(mocksDir, { recursive: true, force: true }); } catch {}
    try { fs.rmSync(repoDir, { recursive: true, force: true }); } catch {}
  }
}

const LOOP = ["--loop", "--loop-unsafe", "--scope", "working-tree", "--allow-secrets", "--loop-fixer", "myfixer"];

// ── AC2: the loop runs EVERY requested provider each round and derives a
//         quorum-aware verdict ────────────────────────────────────────────────

test("AC2: --loop --providers runs both providers; all-approve → clean exit 0", () => {
  const r = runLoopCli(["--providers", "claude,gemini", ...LOOP], {
    mocks: { claude: staticMock(APPROVE), agy: staticMock(APPROVE), myfixer: NOOP_FIXER }
  });
  assert.equal(r.status, 0, r.stderr);
  // Denominator of 2 proves BOTH providers were invoked in the round (a
  // single-provider loop could never print "/2").
  assert.match(r.stderr, /Quorum verdict:\s*0\/2 provider\(s\) flagged/, r.stderr);
  assert.match(r.stderr, /→ approve/);
});

test("AC2: any one provider flagging gates the loop (quorum 1 default) → needs-attention", () => {
  // claude flags, gemini approves, default quorum 1 → needs-attention. The no-op
  // fixer changes nothing → the loop exits 2 on the unresolved finding.
  const r = runLoopCli(["--providers", "claude,gemini", ...LOOP], {
    mocks: { claude: staticMock(FLAG), agy: staticMock(APPROVE), myfixer: NOOP_FIXER }
  });
  assert.match(r.stderr, /Quorum verdict:\s*1\/2 provider\(s\) flagged/, r.stderr);
  assert.match(r.stderr, /→ needs-attention/);
  assert.equal(r.status, 2, r.stderr);
});

test("AC2: quorum is honored — one flag under --quorum 2 does NOT gate → exit 0", () => {
  // Pins quorum-correctness AND that the loop actually reads --providers: the
  // buggy single-provider loop would review with claude only, flag, and exit 2.
  const r = runLoopCli(["--providers", "claude,gemini", "--quorum", "2", ...LOOP], {
    mocks: { claude: staticMock(FLAG), agy: staticMock(APPROVE), myfixer: NOOP_FIXER }
  });
  assert.match(r.stderr, /Quorum verdict:\s*1\/2 provider\(s\) flagged/, r.stderr);
  assert.match(r.stderr, /→ approve/, "1 flag under quorum 2 must NOT gate");
  assert.equal(r.status, 0, r.stderr);
});

test("AC2: providers are re-run every round — flag → fix → re-review approves → exit 0", () => {
  // Round 1: both flag (no marker). Fixer writes the marker. Round 2: both see the
  // marker and approve → clean exit. Proves the multi-provider review runs per round.
  const r = runLoopCli(["--providers", "claude,gemini", ...LOOP.slice(0, -1), "markerfixer"], {
    mocks: { claude: smartMock(), agy: smartMock(), markerfixer: MARKER_FIXER }
  });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /Post-fix review/, "the loop performed a second review round");
  // Two rounds × two providers → the quorum verdict is printed for each round.
  const quorumLines = r.stderr.match(/Quorum verdict:/g) || [];
  assert.ok(quorumLines.length >= 2, `expected a quorum verdict per round, saw ${quorumLines.length}`);
});

// ── AC3: fewer reachable providers than requested emits a loud notice (no silent
//         downgrade) and proceeds with what is available ──────────────────────

test("AC3: an unreachable provider triggers a loud under-satisfaction notice", () => {
  // gemini requested but agy absent and no GEMINI_API_KEY → only claude reachable.
  const r = runLoopCli(["--providers", "claude,gemini", ...LOOP], {
    mocks: { claude: staticMock(APPROVE), myfixer: NOOP_FIXER }
  });
  assert.match(r.stderr, /Under-satisfied/, "a loud under-satisfaction notice must reach stderr");
  assert.match(r.stderr, /1 of 2/, "the notice names how many of the requested providers contributed");
  assert.equal(r.status, 0, "proceeds with the reachable provider's approve verdict → exit 0");
});

// ── gh-9 P5#1: an API-configured provider must be downgraded to its local CLI
//    fallback (or dropped) when the round's diff cannot be inlined — mirroring
//    bin/cli.js's non-loop apiProvidersCannotReview guard, which --loop never
//    applied. Reproduced without any real network call: an "anthropic"-family
//    provider is made reachable via a fake ANTHROPIC_API_KEY, but --api-base
//    points at a closed local port, so a genuine (unfixed) attempt to call it
//    directly fails fast (connection error) — proving the guard did not fire. A
//    claude mock (the anthropic family's CLI fallback) sits on PATH as the
//    expected downgrade target. ─────────────────────────────────────────────────

function getClosedPort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close((err) => (err ? reject(err) : resolve(port)));
    });
    srv.on("error", reject);
  });
}

test("gh-9 P5#1: --loop downgrades an API provider to its local CLI fallback on a non-inlinable diff", async () => {
  const closedPort = await getClosedPort();
  // A diff that exceeds --max-bytes so context.includeDiff is false (summary-only).
  const bigFile = "export const x = 1;\n" + "// padding\n".repeat(200);
  const r = runLoopCli(
    ["--providers", "anthropic", "--max-bytes", "10", ...LOOP],
    {
      mocks: { claude: staticMock(APPROVE), myfixer: NOOP_FIXER },
      env: { ANTHROPIC_API_KEY: "test-key-not-real", ANTHROPIC_API_BASE: `http://127.0.0.1:${closedPort}` },
      fileContents: bigFile
    }
  );
  assert.match(
    r.stderr,
    /cannot inspect a non-inlinable diff; using local claude instead/,
    `expected a downgrade warning; got:\n${r.stderr}`
  );
  assert.equal(r.status, 0, `expected the downgraded claude mock's approve to clear the loop; got:\n${r.stderr}`);
  // If the guard did not fire, the run would instead attempt the real (bogus)
  // API base and fail with a connection error — assert that never happened.
  assert.doesNotMatch(r.stderr, /ECONNREFUSED|fetch failed/, "must never attempt the API directly on a non-inlinable diff");
});
