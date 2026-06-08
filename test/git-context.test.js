import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { collectReviewContext } from "../src/git-context.js";

const cliPath = fileURLToPath(new URL("../bin/cli.js", import.meta.url));

function git(cwd, args) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  });
}

function initRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "adversarial-review-test-"));
  git(dir, ["init"]);
  fs.writeFileSync(path.join(dir, "README.md"), "initial\n");
  git(dir, ["add", "README.md"]);
  git(dir, [
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.com",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "-m",
    "init"
  ]);
  return dir;
}

test("collectReviewContext rejects malicious branch refs without executing shell metacharacters", () => {
  const dir = initRepo();

  assert.throws(
    () => collectReviewContext(dir, { scope: "branch", base: "HEAD; printf INJECTED; #" }),
    /Invalid git base ref/
  );
});

test("collectReviewContext skips untracked symlinks instead of reading their targets", () => {
  const dir = initRepo();
  const secret = path.join(os.tmpdir(), `adversarial-review-secret-${Date.now()}.txt`);
  fs.writeFileSync(secret, "SECRET_SHOULD_NOT_BE_IN_PROMPT\n");
  fs.symlinkSync(secret, path.join(dir, "secret-link.txt"));

  const context = collectReviewContext(dir, { scope: "working-tree" });

  assert.match(context.content, /secret-link\.txt/);
  assert.match(context.content, /\(skipped: symlink\)/);
  assert.doesNotMatch(context.content, /SECRET_SHOULD_NOT_BE_IN_PROMPT/);
});

test("CLI fails closed for summary-only API reviews unless explicitly allowed", () => {
  const dir = initRepo();
  fs.writeFileSync(path.join(dir, "README.md"), "changed\n");

  assert.throws(
    () =>
      execFileSync(process.execPath, [cliPath, "--provider", "openai", "--max-bytes=1"], {
        cwd: dir,
        encoding: "utf8",
        env: { ...process.env, OPENAI_API_KEY: "test-key" },
        stdio: ["ignore", "pipe", "pipe"]
      }),
    (err) => {
      assert.equal(err.status, 1);
      assert.match(err.stderr.toString("utf8"), /too large to inline/);
      return true;
    }
  );
});
