import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { cliFallbackArgs } from "../src/llm.js";

// Copilot CLI takes the prompt as the `-p` VALUE and has no stdin sentinel:
// `copilot -p -` is read as a prompt of literal "-" and answers "I notice your
// message is empty." This drives the real bin/cli.js against a mock copilot that
// records its argv and only emits review JSON when the prompt actually arrived as
// an argument — then, if the real CLI is installed, checks that the argv we build
// is one it actually accepts.

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const cli = path.join(root, "bin", "cli.js");
const nodeBinDir = path.dirname(process.execPath);

const APPROVE = '{"verdict":"approve","summary":"ok","coverage":{"files_examined":["code.js"],"files_skipped":[]},"findings":[],"next_steps":[]}';

const SKIP_WIN32 = { skip: process.platform === "win32" ? "copilot .cmd shim is refused on Windows for security" : false };

test("copilot receives the review prompt as a -p ARGUMENT (not the stdin sentinel)", SKIP_WIN32, () => {
  const mocksDir = fs.mkdtempSync(path.join(os.tmpdir(), "adv-copilot-mocks-"));
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "adv-copilot-repo-"));
  const argvOut = path.join(mocksDir, "copilot-argv.txt");
  try {
    // Mock copilot: dump argv, emit review JSON ONLY if the prompt arrived as an
    // argument; otherwise emit copilot's real empty-prompt reply.
    const copilot = path.join(mocksDir, "copilot");
    fs.writeFileSync(
      copilot,
      `#!/bin/sh\nprintf '%s\\n' "$@" > "${argvOut}"\nfor a in "$@"; do\n  case "$a" in\n    *"Prompt:"*) cat <<'JSON'\n${APPROVE}\nJSON\n      exit 0 ;;\n  esac\ndone\necho "I notice your message is empty. What would you like help with?"\nexit 0\n`
    );
    fs.chmodSync(copilot, 0o755);

    const git = (a) => spawnSync("git", a, { cwd: repoDir, encoding: "utf8" });
    git(["init", "-q"]);
    git(["config", "user.email", "t@t.t"]);
    git(["config", "user.name", "t"]);
    fs.writeFileSync(path.join(repoDir, "code.js"), "export const x = 1;\n");
    git(["add", "-A"]);
    git(["commit", "-qm", "init"]);
    fs.writeFileSync(path.join(repoDir, "code.js"), "export const x = 2; // changed\n");

    const PATH = [mocksDir, nodeBinDir, "/usr/bin", "/bin"].join(path.delimiter);
    const r = spawnSync(process.execPath, [cli, "--provider", "copilot", "--scope", "working-tree", "--allow-secrets"], {
      cwd: repoDir,
      encoding: "utf8",
      env: { HOME: process.env.HOME, PATH, ADVERSARIAL_REVIEW_CONFIG: path.join(mocksDir, "adv-config.json") }
    });

    const argv = fs.existsSync(argvOut) ? fs.readFileSync(argvOut, "utf8") : "";
    assert.match(argv, /Prompt:/, `copilot did not receive the prompt as an argument. argv was:\n${argv}`);
    assert.doesNotMatch(argv, /^-$/m, "copilot must not be passed a bare '-' (a stdin sentinel it does not honor)");
    // Read-only isolation must be forced for an untrusted diff.
    assert.match(argv, /^--mode$/m, "copilot must run in plan mode");
    assert.match(argv, /^plan$/m);
    assert.equal(r.status, 0, `expected a clean review (exit 0), got ${r.status}: ${r.stderr}`);
  } finally {
    fs.rmSync(mocksDir, { recursive: true, force: true });
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
});

// AC10: the argv we construct must be one the REAL CLI accepts. A mock proves the
// prompt reaches argv; only the real binary proves we did not invent a flag.
test("the real copilot CLI accepts the review argv we build", { ...SKIP_WIN32, timeout: 240_000 }, (t) => {
  const which = spawnSync("command", ["-v", "copilot"], { encoding: "utf8", shell: true });
  if (which.status !== 0 || !which.stdout.trim()) {
    t.skip("copilot not installed");
    return;
  }

  // A prompt cheap enough to answer, shaped like the review contract.
  const args = cliFallbackArgs("copilot", 'Reply with exactly the JSON {"ok":true} and nothing else.');
  const r = spawnSync("copilot", args, { encoding: "utf8", timeout: 200_000 });
  const stderr = r.stderr || "";

  // A rejected FLAG is what this test exists to catch, and it is checked first:
  // it is a defect in the argv we build and must fail even if other noise follows.
  assert.doesNotMatch(stderr, /unknown option|unknown flag/i, `copilot rejected a flag we pass: ${stderr}`);

  // Everything else that can make the CLI exit non-zero is account or network
  // state, not our argv — quota, expired auth, an unreachable API. Failing on
  // those turns an exhausted Copilot subscription into a red build, so they skip.
  // (Observed for real while writing this: "You have exceeded your monthly quota".)
  if (r.status !== 0) {
    const environmental = /quota|rate.?limit|not logged in|unauthorized|authentication|forbidden|network|ENOTFOUND|ECONNRESET|timed? out/i;
    if (r.error || environmental.test(stderr)) {
      t.skip(`copilot unavailable — ${(r.error?.message || stderr).trim().slice(0, 200)}`);
      return;
    }
    assert.fail(`copilot rejected the review argv (exit ${r.status}): ${stderr}`);
  }

  assert.match(r.stdout || "", /\{"ok":\s*true\}/, `expected the JSON back on stdout, got: ${r.stdout}`);
});
