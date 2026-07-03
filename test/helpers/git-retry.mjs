import { spawnSync } from "node:child_process";

// The loop e2e harnesses (branch-loop, loop-summary, loop-providers) drive many
// `git` subprocesses per test against throwaway repos. Under parallel CPU load
// (several test-runner workers + a concurrent adversarial-review gate), these
// transient failures surface — the repo is never actually broken, a retry
// succeeds shortly after: index.lock contention between racing git
// invocations, and — under heavier saturation — the child process itself
// failing to spawn (Node reports this via `result.error`, e.g. EAGAIN/ENOMEM,
// with no stderr at all since git never ran) or being killed (gh-22). This
// wraps spawnSync("git", ...) so a short, backed-off retry absorbs those
// instead of failing the test outright.
const RETRYABLE_STDERR = /\.lock['"]?|unable to create|resource temporarily unavailable|device or resource busy/i;
// Spawn-level failure codes (git never ran at all) that are plausibly transient
// under CPU/process-table pressure. A permanent misconfiguration (e.g. ENOENT
// from a bad cwd or missing git binary) is deliberately NOT in this set — it
// should fail on the first attempt, not silently retry for ~27s.
const RETRYABLE_SPAWN_ERRNO = new Set(["EAGAIN", "ENOMEM", "EMFILE", "ENFILE", "EBUSY"]);
const MAX_ATTEMPTS = 15;
const BASE_DELAY_MS = 50;
const MAX_DELAY_MS = 3000;

function sleepSync(ms) {
  const view = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(view, 0, 0, ms);
}

function isTransient(result) {
  if (result.status === 0) return false;
  if (result.error) return RETRYABLE_SPAWN_ERRNO.has(result.error.code);
  // The process started but was killed (e.g. by a signal under memory
  // pressure) rather than git running and exiting non-zero.
  if (result.status === null) return true;
  return RETRYABLE_STDERR.test(result.stderr || "");
}

// Returns a `git(args)` function bound to `cwd`, matching the inline
// `(a) => spawnSync("git", a, { cwd, encoding: "utf8" })` closures it replaces.
// The retry budget is overridable (maxAttempts/baseDelayMs/maxDelayMs) so tests
// can exercise the exhausted-retries path without waiting out the real ~27s
// production budget.
export function makeGit(cwd, { maxAttempts = MAX_ATTEMPTS, baseDelayMs = BASE_DELAY_MS, maxDelayMs = MAX_DELAY_MS } = {}) {
  return function git(args) {
    for (let attempt = 1; ; attempt++) {
      const result = spawnSync("git", args, { cwd, encoding: "utf8" });
      if (!isTransient(result) || attempt >= maxAttempts) return result;
      sleepSync(Math.min(baseDelayMs * 2 ** (attempt - 1), maxDelayMs));
    }
  };
}
