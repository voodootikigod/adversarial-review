import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { makeGit } from "./helpers/git-retry.mjs";

// gh-22 / T8 — makeGit() wraps spawnSync("git", ...) with a bounded, backed-off
// retry on TRANSIENT git failures (e.g. index.lock contention), which the loop
// e2e harnesses hit under parallel CPU load. These tests exercise the retry
// wrapper directly rather than relying on the e2e suite to reproduce contention.

function makeRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "adv-git-retry-"));
  const git = makeGit(dir);
  git(["init", "-q", "-b", "main"]);
  git(["config", "user.email", "t@example.com"]);
  git(["config", "user.name", "Test"]);
  git(["config", "commit.gpgsign", "false"]);
  fs.writeFileSync(path.join(dir, "f.txt"), "hi\n");
  return { dir, git };
}

test("makeGit: a normal command succeeds on the first attempt", () => {
  const { dir, git } = makeRepo();
  try {
    const r = git(["add", "-A"]);
    assert.equal(r.status, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("makeGit: retries through a transient index.lock and succeeds once it clears", () => {
  const { dir, git } = makeRepo();
  try {
    const lockPath = path.join(dir, ".git", "index.lock");
    fs.writeFileSync(lockPath, "");
    // Simulate a concurrent git process holding the lock: a detached child
    // removes it shortly after this call starts blocking (spawnSync + the
    // synchronous backoff sleep are both blocking in this process, so the
    // removal must come from a separate process, not a same-process timer).
    const remover = spawn(
      process.execPath,
      ["-e", `setTimeout(() => { try { require("fs").unlinkSync(${JSON.stringify(lockPath)}); } catch {} }, 30);`],
      { stdio: "ignore" }
    );
    remover.unref();

    const r = git(["add", "-A"]);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(fs.existsSync(lockPath), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("makeGit: a persistent lock exhausts retries and returns the failed result (bounded, not hung)", () => {
  const { dir } = makeRepo();
  try {
    const lockPath = path.join(dir, ".git", "index.lock");
    fs.writeFileSync(lockPath, "");
    // A small injected budget proves the exhausted-retries path terminates
    // without waiting out the real ~27s production budget on every test run.
    const git = makeGit(dir, { maxAttempts: 3, baseDelayMs: 10, maxDelayMs: 50 });
    const start = Date.now();
    const r = git(["add", "-A"]);
    const elapsed = Date.now() - start;
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /index\.lock|unable to create/i);
    assert.ok(elapsed < 1000, `expected a bounded retry window, took ${elapsed}ms`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("makeGit: a non-transient git failure (bad subcommand) is NOT retried and returns immediately", () => {
  const { dir, git } = makeRepo();
  try {
    const start = Date.now();
    const r = git(["not-a-real-git-subcommand"]);
    const elapsed = Date.now() - start;
    assert.notEqual(r.status, 0);
    assert.ok(elapsed < 500, `non-retryable failure should return fast, took ${elapsed}ms`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("makeGit: a bad cwd (ENOENT, permanent misconfiguration) fails fast and is NOT retried", () => {
  // Spawn-level errors are only retried for a known-transient errno allowlist
  // (EAGAIN/ENOMEM/EMFILE/ENFILE/EBUSY); ENOENT from a nonexistent cwd or a
  // missing git binary is a permanent break and must fail on the first attempt,
  // not silently retry for the full ~27s production budget.
  const git = makeGit("/no/such/directory/at/all-xyz123-adv-test");
  const start = Date.now();
  const r = git(["status"]);
  const elapsed = Date.now() - start;
  assert.notEqual(r.status, 0);
  assert.equal(r.error && r.error.code, "ENOENT");
  assert.ok(elapsed < 500, `a permanent misconfiguration should fail fast, took ${elapsed}ms`);
});

test("makeGit: retries exactly maxAttempts times, not more (kills an off-by-one boundary regression)", () => {
  // A fake `git` on PATH counts real invocations and always reports a
  // retryable failure, so this directly measures the loop's stop condition
  // rather than inferring it from elapsed time — a `attempt > maxAttempts`
  // regression (one extra attempt) would fail this assertion.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "adv-git-retry-count-"));
  const fakeGitDir = fs.mkdtempSync(path.join(os.tmpdir(), "adv-fake-git-"));
  const counterPath = path.join(dir, "count.txt");
  const fakeGitPath = path.join(fakeGitDir, "git");
  fs.writeFileSync(
    fakeGitPath,
    `#!/bin/sh\nprintf 'x' >> ${JSON.stringify(counterPath)}\nprintf 'fatal: Unable to create lock\\n' >&2\nexit 128\n`
  );
  fs.chmodSync(fakeGitPath, 0o755);

  const originalPath = process.env.PATH;
  process.env.PATH = [fakeGitDir, originalPath].join(path.delimiter);
  try {
    const git = makeGit(dir, { maxAttempts: 4, baseDelayMs: 5, maxDelayMs: 20 });
    const r = git(["status"]);
    assert.notEqual(r.status, 0);
    const invocations = fs.readFileSync(counterPath, "utf8").length;
    assert.equal(invocations, 4, `expected exactly maxAttempts (4) invocations, got ${invocations}`);
  } finally {
    process.env.PATH = originalPath;
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(fakeGitDir, { recursive: true, force: true });
  }
});
