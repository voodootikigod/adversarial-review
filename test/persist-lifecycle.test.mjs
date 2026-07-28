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
import { writeMockBin } from "./helpers/mock-bin.mjs";
import { makeGit } from "./helpers/git-retry.mjs";

function runCli(args, { mocks = {}, seedConfig = null, env = {} } = {}) {
  const mocksDir = fs.mkdtempSync(path.join(os.tmpdir(), "adv-life-mocks-"));
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "adv-life-repo-"));
  const configPath = path.join(mocksDir, "adv-config.json");
  try {
    for (const [name, kind] of Object.entries(mocks)) {
      let body;
      if (kind === "APPROVE") {
        body = `
import fs from "node:fs";
process.stdin.resume();
process.stdin.on("end", () => {
  const out = ${JSON.stringify(APPROVE + "\n")};
  const idx = process.argv.indexOf("--output-last-message");
  if (idx !== -1 && process.argv[idx + 1]) {
    fs.writeFileSync(process.argv[idx + 1], out);
  } else {
    process.stdout.write(out);
  }
});
`;
      } else if (kind === "AUTHFAIL") {
        body = `
process.stderr.write("error: not logged in; run: login\\n");
process.exit(1);
`;
      } else if (kind === "MODELFAIL") {
        body = `
process.stderr.write("error: the model does not exist or is retired\\n");
process.exit(1);
`;
      } else {
        body = `
process.stdout.write("not json at all\\n");
`;
      }
      writeMockBin(mocksDir, name, body);
    }
    const git = makeGit(repoDir);
    git(["init", "-q"]);
    git(["config", "user.email", "t@t.t"]);
    git(["config", "user.name", "t"]);
    fs.writeFileSync(path.join(repoDir, "code.js"), "export const x = 1;\n");
    git(["add", "-A"]);
    git(["commit", "-qm", "init"]);
    fs.writeFileSync(path.join(repoDir, "code.js"), "export const x = 2; // changed\n");

    if (seedConfig) {
      seedConfig = JSON.parse(JSON.stringify(seedConfig));
      for (const entry of Object.values(seedConfig.cache || {})) {
        if (entry.provider === "cli" && entry.cliCmd) {
          const mockName = process.platform === "win32" ? `${entry.cliCmd}.cmd` : entry.cliCmd;
          entry.cliPath = fs.realpathSync(path.join(mocksDir, mockName));
        }
      }
      fs.writeFileSync(configPath, JSON.stringify(seedConfig));
    }

    let sysDirs = ["/usr/bin", "/bin"];
    if (process.platform === "win32") {
      const whereGit = spawnSync("where.exe", ["git"], { encoding: "utf8" });
      if (whereGit.status === 0 && whereGit.stdout.trim()) {
        sysDirs = [path.dirname(whereGit.stdout.trim().split(/\r?\n/)[0])];
      }
    }
    const PATH = [mocksDir, nodeBinDir, ...sysDirs].join(path.delimiter);
    const finalArgs = [...args];
    if (process.platform === "win32" && finalArgs.includes("--loop") && !finalArgs.includes("--loop-unsafe")) {
      finalArgs.push("--loop-unsafe");
    }
    const r = spawnSync(process.execPath, [cli, ...finalArgs], {
      cwd: repoDir,
      encoding: "utf8",
      env: { HOME: process.env.HOME, PATH, ...env, ADVERSARIAL_REVIEW_CONFIG: configPath }
    });
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
  // Seed the cache at a mock 'codex' whose session is dead (auth failure); plant a
  // working 'claude'. The failed provider is excluded, so re-detection advances to
  // claude even though the ladder would otherwise reconsider codex.
  const r = runCli(BASE, {
    mocks: { codex: "AUTHFAIL", claude: "APPROVE" },
    seedConfig: { version: 1, defaults: { models: {} }, cache: { default: { provider: "cli", cliCmd: "codex", family: "openai" } } }
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
      mocks: { codex: "AUTHFAIL", claude: "APPROVE", myfixer: "APPROVE" },
      seedConfig: { version: 1, defaults: { models: {} }, cache: { default: { provider: "cli", cliCmd: "codex", family: "openai" } } }
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

test("T24: a cache-sourced provider with a RETIRED-MODEL failure is invalidated and recovers", () => {
  const r = runCli(BASE, {
    mocks: { codex: "MODELFAIL", claude: "APPROVE" },
    seedConfig: { version: 1, defaults: { models: {} }, cache: { default: { provider: "cli", cliCmd: "codex", family: "openai" } } }
  });
  assert.equal(r.status, 0, `expected recovery to succeed, got ${r.status}: ${r.stderr}`);
  assert.match(r.stderr, /re-detected/, "a retired-model failure should trigger the same recovery as auth");
  assert.equal(r.config.cache.default.cliCmd, "claude");
});

test("AC2b: a NON-auth failure (parse error) does NOT invalidate the cache or retry", () => {
  // A cached provider that returns garbage is a transient/content failure, not a
  // dead credential — the run must fail (exit 1) without nuking the cache entry.
  const r = runCli(BASE, {
    mocks: { codex: "BAD" },
    seedConfig: { version: 1, defaults: { models: {} }, cache: { default: { provider: "cli", cliCmd: "codex", family: "openai" } } }
  });
  assert.equal(r.status, 1, "a non-auth failure surfaces as exit 1");
  assert.doesNotMatch(r.stderr || "", /re-detected/, "must not attempt the auth-failure fallback");
  // The cache entry is preserved (not invalidated by a non-auth error).
  assert.equal(r.config?.cache?.default?.cliCmd, "codex", "cache entry preserved on a non-auth failure");
});
