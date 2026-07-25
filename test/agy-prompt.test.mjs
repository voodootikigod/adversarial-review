import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// Regression: agy's `-p`/`--print` takes the prompt as its VALUE and has no stdin
// `-` sentinel. Invoked as `agy -p -` with the prompt on stdin, agy answers the
// literal "-" and returns prose instead of the review JSON. This drives the real
// bin/cli.js against a mock agy that records its argv and only emits review JSON
// when the prompt actually arrived as an argument.

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const cli = path.join(root, "bin", "cli.js");
const nodeBinDir = path.dirname(process.execPath);

const APPROVE = '{"verdict":"approve","summary":"ok","coverage":{"files_examined":["code.js"],"files_skipped":[]},"findings":[],"next_steps":[]}';

test("agy receives the review prompt as a -p ARGUMENT (not the stdin sentinel)", () => {
  const mocksDir = fs.mkdtempSync(path.join(os.tmpdir(), "adv-agy-mocks-"));
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "adv-agy-repo-"));
  const argvOut = path.join(mocksDir, "agy-argv.txt");
  try {
    // Mock agy: dump argv, then emit review JSON ONLY if the prompt (which contains
    // "Prompt:") arrived as an argument; otherwise emit agy's prose-on-empty reply.
    const agy = path.join(mocksDir, "agy");
    fs.writeFileSync(
      agy,
      `#!/bin/sh\nprintf '%s\\n' "$@" > "${argvOut}"\nfor a in "$@"; do\n  case "$a" in\n    *"Prompt:"*) cat <<'JSON'\n${APPROVE}\nJSON\n      exit 0 ;;\n  esac\ndone\necho "Hello! How can I help you today?"\nexit 0\n`
    );
    fs.chmodSync(agy, 0o755);

    const git = (a) => spawnSync("git", a, { cwd: repoDir, encoding: "utf8" });
    git(["init", "-q"]);
    git(["config", "user.email", "t@t.t"]);
    git(["config", "user.name", "t"]);
    fs.writeFileSync(path.join(repoDir, "code.js"), "export const x = 1;\n");
    git(["add", "-A"]);
    git(["commit", "-qm", "init"]);
    fs.writeFileSync(path.join(repoDir, "code.js"), "export const x = 2; // changed\n");

    const PATH = [mocksDir, nodeBinDir, "/usr/bin", "/bin"].join(path.delimiter);
    const r = spawnSync(process.execPath, [cli, "--provider", "agy", "--scope", "working-tree", "--allow-secrets"], {
      cwd: repoDir,
      encoding: "utf8",
      env: { HOME: process.env.HOME, PATH, ADVERSARIAL_REVIEW_CONFIG: path.join(mocksDir, "adv-config.json") }
    });

    const argv = fs.existsSync(argvOut) ? fs.readFileSync(argvOut, "utf8") : "";
    // The prompt must have reached agy as an argument.
    assert.match(argv, /Prompt:/, `agy did not receive the prompt as an argument. argv was:\n${argv}`);
    // agy must NOT be invoked with the bare stdin sentinel `-` as the -p value.
    assert.doesNotMatch(argv, /^-$/m, "agy must not be passed a bare '-' (stdin sentinel it does not honor)");
    // And the review must parse to a clean approve (exit 0), not fail on prose.
    assert.equal(r.status, 0, `expected a clean review (exit 0), got ${r.status}: ${r.stderr}`);
  } finally {
    fs.rmSync(mocksDir, { recursive: true, force: true });
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
});
