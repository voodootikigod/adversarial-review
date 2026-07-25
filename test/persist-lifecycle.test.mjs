import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// End-to-end coverage for the resolution-cache LIFECYCLE (T21): a resolution is
// persisted only AFTER a successful review, and a cache-sourced provider that
// fails is invalidated and re-detected once. Drives the real bin/cli.js against a
// throwaway git repo with mock CLIs, config isolated OUTSIDE the repo (T23).

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const cli = path.join(root, "bin", "cli.js");
const nodeBinDir = path.dirname(process.execPath);

const APPROVE = '{"verdict":"approve","summary":"ok","coverage":{"files_examined":["code.js"],"files_skipped":[]},"findings":[],"next_steps":[]}';

// mocks: { name: "APPROVE" | "BAD" }. APPROVE emits a valid review; BAD emits
// non-JSON so runReview fails. seedConfig (optional) is written to the isolated
// config path before the run. Returns { status, stdout, stderr, configPath, readConfig() }.
function runCli(args, { mocks = {}, seedConfig = null, env = {} } = {}) {
  const mocksDir = fs.mkdtempSync(path.join(os.tmpdir(), "adv-life-mocks-"));
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "adv-life-repo-"));
  const configPath = path.join(mocksDir, "adv-config.json"); // outside cwd=repoDir
  try {
    for (const [name, kind] of Object.entries(mocks)) {
      const p = path.join(mocksDir, name);
      let body;
      if (kind === "APPROVE") {
        body = `#!/bin/sh\ncat >/dev/null\ncat <<'JSON'\n${APPROVE}\nJSON\n`;
      } else if (kind === "AUTHFAIL") {
        // Simulate a logged-out CLI session: non-zero exit + an auth-ish stderr.
        body = `#!/bin/sh\ncat >/dev/null\necho 'error: not logged in; run: login' >&2\nexit 1\n`;
      } else {
        body = `#!/bin/sh\ncat >/dev/null\necho 'not json at all'\n`; // BAD: parse failure
      }
      fs.writeFileSync(p, body);
      fs.chmodSync(p, 0o755);
    }
    const git = (a) => spawnSync("git", a, { cwd: repoDir, encoding: "utf8" });
    git(["init", "-q"]);
    git(["config", "user.email", "t@t.t"]);
    git(["config", "user.name", "t"]);
    fs.writeFileSync(path.join(repoDir, "code.js"), "export const x = 1;\n");
    git(["add", "-A"]);
    git(["commit", "-qm", "init"]);
    fs.writeFileSync(path.join(repoDir, "code.js"), "export const x = 2; // changed\n");

    if (seedConfig) {
      // Fill in the mock's real cliPath so cachedResolutionUsable accepts it.
      seedConfig = JSON.parse(JSON.stringify(seedConfig));
      for (const entry of Object.values(seedConfig.cache || {})) {
        if (entry.provider === "cli" && entry.cliCmd) {
          entry.cliPath = fs.realpathSync(path.join(mocksDir, entry.cliCmd));
        }
      }
      fs.writeFileSync(configPath, JSON.stringify(seedConfig));
    }

    const PATH = [mocksDir, nodeBinDir, "/usr/bin", "/bin"].join(path.delimiter);
    const r = spawnSync(process.execPath, [cli, ...args], {
      cwd: repoDir,
      encoding: "utf8",
      env: { HOME: process.env.HOME, PATH, ...env, ADVERSARIAL_REVIEW_CONFIG: configPath }
    });
    // Read the config BEFORE the finally block removes mocksDir.
    const config = fs.existsSync(configPath) ? JSON.parse(fs.readFileSync(configPath, "utf8")) : null;
    return { status: r.status, stdout: r.stdout, stderr: r.stderr, config };
  } finally {
    try { fs.rmSync(mocksDir, { recursive: true, force: true }); } catch {}
    try { fs.rmSync(repoDir, { recursive: true, force: true }); } catch {}
  }
}

const BASE = ["--scope", "working-tree", "--allow-secrets"];

test("AC1: a SUCCESSFUL auto-detected review persists the resolution", () => {
  const r = runCli(BASE, { mocks: { claude: "APPROVE" } });
  assert.equal(r.status, 0, r.stderr);
  const cfg = r.config;
  assert.ok(cfg, "config should be written after a successful review");
  assert.equal(cfg.cache.default.provider, "cli");
  assert.equal(cfg.cache.default.cliCmd, "claude");
});

test("AC1: a FAILED review does NOT persist the resolution (persist-after-success)", () => {
  const r = runCli(BASE, { mocks: { claude: "BAD" } });
  assert.equal(r.status, 1, "a review that cannot parse the model output exits 1");
  const cfg = r.config;
  // No cache entry may be written for a resolution that never produced a review.
  assert.ok(!cfg || !cfg.cache || !cfg.cache.default, "a failed resolution must not be cached");
});

test("AC2: a cache-sourced provider with an AUTH failure is invalidated, excluded, and a reachable alternative is used", () => {
  // Seed the cache at a mock 'agy' whose session is dead (auth failure); plant a
  // working 'claude'. The failed provider is excluded, so re-detection advances to
  // claude even though the ladder would otherwise reconsider agy.
  const r = runCli(BASE, {
    mocks: { agy: "AUTHFAIL", claude: "APPROVE" },
    seedConfig: { version: 1, defaults: { models: {} }, cache: { default: { provider: "cli", cliCmd: "agy", family: "gemini" } } }
  });
  assert.equal(r.status, 0, `expected recovery to succeed, got ${r.status}: ${r.stderr}`);
  assert.match(r.stderr, /re-detected/, "should log the re-detection after the cached provider failed auth");
  const cfg = r.config;
  assert.equal(cfg.cache.default.cliCmd, "claude", "the recovered provider is cached; the stale one is gone");
});

test("F6: loop mode persists the resolution after a successful review", () => {
  // A clean first review (approve) ends the loop at exit 0; loop mode must run the
  // same success-persistence lifecycle as the normal path.
  const r = runCli(
    ["--loop", "--loop-unsafe", "--scope", "working-tree", "--allow-secrets", "--loop-fixer", "myfixer"],
    { mocks: { claude: "APPROVE", myfixer: "APPROVE" } }
  );
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.config, "loop mode should persist config after a successful review (F6)");
  assert.equal(r.config.cache.default.cliCmd, "claude");
});

test("F5: after an auth-failure fallback, loop_summary names the provider that actually reviewed", () => {
  const r = runCli(
    ["--loop", "--loop-unsafe", "--scope", "working-tree", "--allow-secrets", "--loop-fixer", "myfixer", "--json"],
    {
      mocks: { agy: "AUTHFAIL", claude: "APPROVE", myfixer: "APPROVE" },
      seedConfig: { version: 1, defaults: { models: {} }, cache: { default: { provider: "cli", cliCmd: "agy", family: "gemini" } } }
    }
  );
  assert.equal(r.status, 0, r.stderr);
  const events = (r.stdout || "").trim().split("\n")
    .map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter(Boolean);
  const summary = events.find((o) => o.type === "loop_summary");
  assert.ok(summary, "a loop_summary event should be emitted");
  assert.deepEqual(summary.providers, ["claude"], "summary names the recovered provider, not the failed cached one");
});

test("AC2b: a NON-auth failure (parse error) does NOT invalidate the cache or retry", () => {
  // A cached provider that returns garbage is a transient/content failure, not a
  // dead credential — the run must fail (exit 1) without nuking the cache entry.
  const r = runCli(BASE, {
    mocks: { agy: "BAD" },
    seedConfig: { version: 1, defaults: { models: {} }, cache: { default: { provider: "cli", cliCmd: "agy", family: "gemini" } } }
  });
  assert.equal(r.status, 1, "a non-auth failure surfaces as exit 1");
  assert.doesNotMatch(r.stderr || "", /re-detected/, "must not attempt the auth-failure fallback");
  // The cache entry is preserved (not invalidated by a non-auth error).
  assert.equal(r.config?.cache?.default?.cliCmd, "agy", "cache entry preserved on a non-auth failure");
});
