import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolveCommand } from "../src/resolve-command.js";

// A repository must never supply the git used to inspect it. Two ways it could:
//   1. Windows resolves a BARE executable name from the CURRENT DIRECTORY before
//      PATH, and our cwd is the repository under review — so a committed git.exe
//      runs with the reviewer's privileges, before any provider sandbox applies.
//   2. npm and npx prepend ./node_modules/.bin to PATH, so a repo can put a
//      `git` on PATH just by shipping one.

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const cli = path.join(root, "bin", "cli.js");
const nodeBinDir = path.dirname(process.execPath);

test("no source file spawns git by bare name", () => {
  // The whole defence is that an absolute path reaches execFileSync. A single
  // bare "git" anywhere in src/ reopens the current-directory search.
  const offenders = [];
  for (const file of fs.readdirSync(path.join(root, "src"))) {
    if (!file.endsWith(".js")) continue;
    const raw = fs.readFileSync(path.join(root, "src", file), "utf8");
    const code = raw.split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
    if (/execFileSync\(\s*["'`]git["'`]/.test(code) || /spawn(Sync)?\(\s*["'`]git["'`]/.test(code)) {
      offenders.push(file);
    }
  }
  assert.deepEqual(offenders, [], `these files spawn git by bare name: ${offenders.join(", ")}`);
});

test("resolveCommand skips PATH entries inside an excluded root", () => {
  // The npm/npx node_modules/.bin vector: a repo-local dir on PATH must not win.
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "adv-git-repo-"));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "adv-git-out-"));
  try {
    const repoBin = path.join(repo, "node_modules", ".bin");
    fs.mkdirSync(repoBin, { recursive: true });
    for (const dir of [repoBin, outside]) {
      const p = path.join(dir, "advgit");
      fs.writeFileSync(p, "#!/bin/sh\nexit 0\n");
      fs.chmodSync(p, 0o755);
    }
    const env = { PATH: [repoBin, outside].join(path.delimiter) };

    // Without the exclusion the repo-local copy wins simply by being first.
    // Compared against realpath: resolveCommand returns the CANONICAL target, so
    // a caller always spawns the executable that was actually vetted.
    assert.equal(
      resolveCommand("advgit", { platform: "linux", env }),
      fs.realpathSync(path.join(repoBin, "advgit"))
    );
    // With it, resolution skips past the repository entirely.
    assert.equal(
      resolveCommand("advgit", { platform: "linux", env, excludeRoots: [repo] }),
      fs.realpathSync(path.join(outside, "advgit"))
    );
    // And when the ONLY candidate is repo-local, nothing is returned — the
    // caller fails closed rather than running the repository's binary.
    assert.equal(
      resolveCommand("advgit", { platform: "linux", env: { PATH: repoBin }, excludeRoots: [repo] }),
      null
    );
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test("a PATH symlink whose TARGET is inside the repo is refused", () => {
  // Excluding the directory is not enough. A permitted outside directory can hold
  // a symlink — e.g. a globally linked binary — whose target lives in the
  // repository under review. What executes is the target, so the target is what
  // must be checked; checking only the link's own location lets the payload run.
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "adv-symlink-repo-"));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "adv-symlink-bin-"));
  try {
    const payload = path.join(repo, "evil-git");
    fs.writeFileSync(payload, "#!/bin/sh\nexit 0\n");
    fs.chmodSync(payload, 0o755);
    fs.symlinkSync(payload, path.join(outside, "advgit"));

    const env = { PATH: outside };
    // The link itself sits outside, so a directory-only check would allow it.
    assert.equal(
      resolveCommand("advgit", { platform: "linux", env }),
      fs.realpathSync(payload),
      "without exclusion it resolves to the canonical target"
    );
    // With the repo excluded, the target's location disqualifies it.
    assert.equal(
      resolveCommand("advgit", { platform: "linux", env, excludeRoots: [repo] }),
      null,
      "a symlink into the reviewed repository must not resolve"
    );
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test("the worktree boundary is found without executing anything", async () => {
  const { findWorktreeBoundary } = await import("../src/trust-root.js");
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "adv-boundary-"));
  try {
    const nested = path.join(repo, "packages", "app", "src");
    fs.mkdirSync(nested, { recursive: true });
    // No .git yet: nothing to find below the temp dir.
    assert.equal(findWorktreeBoundary(nested), null);

    // A .git DIRECTORY (normal clone) is a boundary...
    fs.mkdirSync(path.join(repo, ".git"));
    assert.equal(findWorktreeBoundary(nested), fs.realpathSync(repo));
    fs.rmSync(path.join(repo, ".git"), { recursive: true });

    // ...and so is a .git FILE (submodule or linked worktree).
    fs.writeFileSync(path.join(repo, ".git"), "gitdir: /elsewhere\n");
    assert.equal(findWorktreeBoundary(nested), fs.realpathSync(repo));

    // The nearest boundary wins for a nested repository.
    const inner = path.join(repo, "packages", "app");
    fs.writeFileSync(path.join(inner, ".git"), "gitdir: /elsewhere\n");
    assert.equal(findWorktreeBoundary(nested), fs.realpathSync(inner));
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("an ANCESTOR-owned repo git is not executed when run from a nested package", { skip: process.platform === "win32" ? "posix-only shims" : false }, () => {
  // The monorepo case: run from /repo/packages/app, where npm/npx put the
  // ancestor /repo/node_modules/.bin first on PATH. Excluding only cwd leaves
  // that directory eligible, and the bootstrap executes it before it ever learns
  // that /repo is the trust root — so containment checks arrive too late.
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "adv-nested-"));
  try {
    const realGit = resolveCommand("git");
    assert.ok(realGit, "this test needs a real git on PATH");

    const repoBin = path.join(repo, "node_modules", ".bin");
    const pkg = path.join(repo, "packages", "app");
    fs.mkdirSync(repoBin, { recursive: true });
    fs.mkdirSync(pkg, { recursive: true });

    const marker = path.join(repo, "PWNED");
    const evil = path.join(repoBin, "git");
    fs.writeFileSync(evil, `#!/bin/sh\ntouch "${marker}"\nexec "${realGit}" "$@"\n`);
    fs.chmodSync(evil, 0o755);

    const g = (a) => spawnSync(realGit, a, { cwd: repo, encoding: "utf8" });
    g(["init", "-q"]);
    g(["config", "user.email", "t@t.t"]);
    g(["config", "user.name", "t"]);
    fs.writeFileSync(path.join(pkg, "code.js"), "export const x = 1;\n");
    g(["add", "-A"]);
    g(["commit", "-qm", "init"]);
    fs.writeFileSync(path.join(pkg, "code.js"), "export const x = 2;\n");

    // Run from the NESTED package, ancestor .bin first — exactly npx's ordering.
    const PATH = [repoBin, nodeBinDir, path.dirname(realGit), "/usr/bin", "/bin"].join(path.delimiter);
    spawnSync(process.execPath, [cli, "--prompt-only", "--scope", "working-tree", "--allow-secrets"], {
      cwd: pkg,
      encoding: "utf8",
      env: { HOME: process.env.HOME, PATH }
    });

    assert.equal(
      fs.existsSync(marker),
      false,
      "an ancestor-owned repo git ran during the bootstrap — the boundary was computed from cwd, not the worktree"
    );
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("a git refusal is never swallowed by an allowFail probe or misreported", async () => {
  // The refusal must survive two swallowing layers: git()'s own catch, which
  // turns any failure into "" when allowFail is set, and collectReviewContext's
  // catch, which otherwise reports every failure as "Not inside a git repository"
  // — hiding a security stop behind a setup error.
  const { collectReviewContext } = await import("../src/git-context.js");
  const trustRoot = await import("../src/trust-root.js");

  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "adv-git-refuse-"));
  const emptyBin = fs.mkdtempSync(path.join(os.tmpdir(), "adv-git-none-"));
  const oldPath = process.env.PATH;
  try {
    // No git anywhere on PATH → no trusted git can be established.
    process.env.PATH = emptyBin;
    trustRoot._resetTrustRootCache();
    assert.throws(() => trustRoot.resolveTrustedGit(), (err) => {
      assert.equal(err.code, "EUNTRUSTEDGIT");
      assert.match(err.message, /must not supply the git used to inspect it/);
      return true;
    });
    assert.throws(
      () => collectReviewContext(repo, { scope: "working-tree" }),
      (err) => {
        assert.equal(err.code, "EUNTRUSTEDGIT", "the refusal must reach the caller intact");
        assert.doesNotMatch(err.message, /Not inside a git repository/);
        return true;
      }
    );
  } finally {
    process.env.PATH = oldPath;
    trustRoot._resetTrustRootCache();
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(emptyBin, { recursive: true, force: true });
  }
});

test("a repository-supplied git on PATH is never executed during a review", { skip: process.platform === "win32" ? "posix-only shims" : false }, () => {
  // End to end through the real CLI: the repo ships node_modules/.bin/git, which
  // npx-style PATH would select. If it ever runs it drops a marker file.
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "adv-git-hijack-"));
  try {
    const realGit = resolveCommand("git");
    assert.ok(realGit, "this test needs a real git on PATH");

    const repoBin = path.join(repo, "node_modules", ".bin");
    fs.mkdirSync(repoBin, { recursive: true });
    const marker = path.join(repo, "PWNED");
    const evil = path.join(repoBin, "git");
    // Records that it ran, then delegates so the review would otherwise succeed —
    // a hijack that breaks the run is far less interesting than one that works.
    fs.writeFileSync(evil, `#!/bin/sh\ntouch "${marker}"\nexec "${realGit}" "$@"\n`);
    fs.chmodSync(evil, 0o755);

    const g = (a) => spawnSync(realGit, a, { cwd: repo, encoding: "utf8" });
    g(["init", "-q"]);
    g(["config", "user.email", "t@t.t"]);
    g(["config", "user.name", "t"]);
    fs.writeFileSync(path.join(repo, "code.js"), "export const x = 1;\n");
    g(["add", "-A"]);
    g(["commit", "-qm", "init"]);
    fs.writeFileSync(path.join(repo, "code.js"), "export const x = 2;\n");

    // repoBin FIRST, exactly as npm/npx would order it.
    const PATH = [repoBin, nodeBinDir, path.dirname(realGit), "/usr/bin", "/bin"].join(path.delimiter);
    spawnSync(process.execPath, [cli, "--prompt-only", "--scope", "working-tree", "--allow-secrets"], {
      cwd: repo,
      encoding: "utf8",
      env: { HOME: process.env.HOME, PATH }
    });

    assert.equal(
      fs.existsSync(marker),
      false,
      "the repository's own git was executed — current-directory/PATH hijack is open"
    );
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});
