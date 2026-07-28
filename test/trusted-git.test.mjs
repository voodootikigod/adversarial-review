import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolveCommand, sanitizePathEnv } from "../src/resolve-command.js";

// A repository must never supply the git used to inspect it. Two ways it could:
//   1. Windows resolves a BARE executable name from the CURRENT DIRECTORY before
//      PATH, and our cwd is the repository under review — so a committed git.exe
//      runs with the reviewer's privileges, before any provider sandbox applies.
//   2. npm and npx prepend ./node_modules/.bin to PATH, so a repo can put a
//      `git` on PATH just by shipping one.

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const cli = path.join(root, "bin", "cli.js");
const nodeBinDir = path.dirname(process.execPath);

test("no source file spawns ANY command by bare name", () => {
  // One trusted-absolute-path API, enforced by scan. A bare name is not a
  // command, it is a lookup in an environment the reviewed repository can
  // influence — Windows searches the current directory first, npx puts
  // ./node_modules/.bin at the head of PATH. This catches probes and helpers,
  // which is where it kept regressing: git, then getconf, then the fixer
  // --version probe, then unshare.
  const offenders = [];
  for (const file of fs.readdirSync(path.join(root, "src"))) {
    if (!file.endsWith(".js")) continue;
    const raw = fs.readFileSync(path.join(root, "src", file), "utf8");
    const code = raw.split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
    // A quoted first argument to a spawn call is a bare name; a resolved path
    // arrives in a variable.
    const bare = code.match(/(?:execFileSync|spawnSync|spawn)\(\s*["'`][^"'`]+["'`]/g) || [];
    for (const hit of bare) offenders.push(`${file}: ${hit}`);
  }
  assert.deepEqual(offenders, [], `bare-name spawns found:\n${offenders.join("\n")}`);
});

test("every spawn passes a sanitized environment", () => {
  // Third time this class regressed by being applied incompletely: bare-name
  // spawns, then containment predicates, now inherited environments. Resolving
  // the executable is only half — the child does its OWN lookups from what it
  // inherits (`#!/usr/bin/env node`, a .cmd wrapper falling back to bare `node`).
  // Enforced by scan rather than by remembering every call site.
  const offenders = [];
  for (const file of fs.readdirSync(path.join(root, "src"))) {
    if (!file.endsWith(".js")) continue;
    const raw = fs.readFileSync(path.join(root, "src", file), "utf8");
    const code = raw.split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
    // Each spawn call, from the opening paren to its matching close-ish boundary.
    const calls = code.match(/(?:execFileSync|spawnSync|spawn|spawnImpl)\([\s\S]{0,600}?\n\s*\}\)/g) || [];
    for (const call of calls) {
      // spawn-safe.js owns the sanitizer itself; exec-watchdog forwards it.
      if (/env:\s*(sanitizedSpawnEnv|sanitizePathEnv|safeSpawnEnvOrRaw|options\.env)/.test(call)) continue;
      offenders.push(`${file}: ${call.split("\n")[0].trim()}`);
    }
  }
  assert.deepEqual(offenders, [], `spawns without a sanitized env:\n${offenders.join("\n")}`);
});

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

test("a '..'-prefixed CHILD directory is inside the repo, not outside it", async () => {
  // `!rel.startsWith("..")` treats a legitimate child named "..cache" as a
  // traversal: path.relative(root, root + "/..cache/x") is "..cache/x". Every
  // caller uses this to decide TRUST, so the error runs the wrong way — a real
  // descendant measures as OUTSIDE and becomes trusted. A repo reaches that
  // state by committing an executable under a "..name" directory.
  const { isPathInside } = await import("../src/path-containment.js");
  const root = "/repo";
  for (const inside of ["/repo", "/repo/src", "/repo/..cache", "/repo/..cache/git", "/repo/...x/y"]) {
    assert.equal(isPathInside(inside, root), true, `${inside} must be inside ${root}`);
  }
  for (const outside of ["/repo2", "/", "/other/bin", "/repo/../evil"]) {
    assert.equal(isPathInside(outside, root), false, `${outside} must be outside ${root}`);
  }

  // End to end through the resolver: the payload lives under a "..cache" child
  // that a naive predicate reads as an escape.
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "adv-dotdot-"));
  try {
    const sneaky = path.join(repo, "..cache");
    fs.mkdirSync(sneaky);
    const p = path.join(sneaky, "advgit");
    fs.writeFileSync(p, "#!/bin/sh\nexit 0\n");
    fs.chmodSync(p, 0o755);
    assert.equal(
      resolveCommand("advgit", { platform: "linux", env: { PATH: sneaky }, excludeRoots: [repo] }),
      null,
      "a '..'-prefixed child of the repo must not resolve as trusted"
    );
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("a refused trust decision is replayed, never cached away", async () => {
  // Assigning cachedRoot and throwing separately meant the NEXT call hit the
  // cache and returned the untrusted root with no check — so catching the error
  // once disabled the guard for the rest of the process. The refusal must repeat.
  const trustRoot = await import("../src/trust-root.js");
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "adv-poison-"));
  const oldPath = process.env.PATH;
  const oldCwd = process.cwd();
  try {
    fs.mkdirSync(path.join(repo, ".git"));
    // The ONLY git is inside the repo, reached via a PATH dir outside it, so the
    // bootstrap runs it and the post-check refuses.
    const outsideBin = fs.mkdtempSync(path.join(os.tmpdir(), "adv-poison-bin-"));
    const payload = path.join(repo, "git");
    fs.writeFileSync(payload, `#!/bin/sh\necho "${repo}"\n`);
    fs.chmodSync(payload, 0o755);
    fs.symlinkSync(payload, path.join(outsideBin, "git"));

    process.chdir(repo);
    trustRoot._resetTrustRootCache();
    process.env.PATH = outsideBin;

    // Whatever the first call does, EVERY later call must agree — a refusal that
    // stops repeating is the bypass.
    let first = null;
    try { trustRoot.reviewTrustRoot(); } catch (err) { first = err; }
    if (first) {
      assert.equal(first.code, "EUNTRUSTEDGIT");
      for (let i = 0; i < 3; i++) {
        assert.throws(() => trustRoot.reviewTrustRoot(), (err) => err.code === "EUNTRUSTEDGIT",
          "the refusal must replay on every subsequent call");
      }
    }
    fs.rmSync(outsideBin, { recursive: true, force: true });
  } finally {
    process.chdir(oldCwd);
    process.env.PATH = oldPath;
    trustRoot._resetTrustRootCache();
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("a CLI named by absolute path resolves, and is still trust-checked", async () => {
  // `--loop-fixer /opt/tools/codex` resolved to null and was reported as "not
  // installed", because resolveCommand rejects every non-bare token. Naming a
  // path must work — and must buy no trust a bare name would not get.
  const { resolveTrustedCommand } = await import("../src/spawn-safe.js");
  const trustRoot = await import("../src/trust-root.js");
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "adv-abs-repo-"));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "adv-abs-out-"));
  const oldCwd = process.cwd();
  try {
    fs.mkdirSync(path.join(repo, ".git"));
    const good = path.join(outside, "myfixer");
    fs.writeFileSync(good, "#!/bin/sh\nexit 0\n");
    fs.chmodSync(good, 0o755);
    const evil = path.join(repo, "myfixer");
    fs.writeFileSync(evil, "#!/bin/sh\nexit 0\n");
    fs.chmodSync(evil, 0o755);

    process.chdir(repo);
    trustRoot._resetTrustRootCache();

    assert.equal(resolveTrustedCommand(good), fs.realpathSync(good), "an outside path resolves");
    assert.equal(resolveTrustedCommand(evil), null, "a path INSIDE the repo is still refused");
    assert.equal(resolveTrustedCommand(path.join(outside, "nope")), null, "a missing path resolves to null");
    if (process.platform !== "win32") {
      const notExec = path.join(outside, "plain.txt");
      fs.writeFileSync(notExec, "not executable\n");
      fs.chmodSync(notExec, 0o644);
      assert.equal(resolveTrustedCommand(notExec), null, "a non-executable file is not a command");
    }
  } finally {
    process.chdir(oldCwd);
    trustRoot._resetTrustRootCache();
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test("the sanitized child environment drops repo PATH entries", async () => {
  // Resolving what we spawn is not the end of it: an npm .cmd wrapper falls back
  // to a bare `node`, and `#!/usr/bin/env node` resolves from PATH. Both would
  // pick a repo-supplied runtime out of node_modules/.bin — a trusted wrapper
  // executing untrusted code.
  const { sanitizedSpawnEnv } = await import("../src/spawn-safe.js");
  const trustRoot = await import("../src/trust-root.js");
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "adv-env-"));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "adv-env-out-"));
  const oldCwd = process.cwd();
  try {
    fs.mkdirSync(path.join(repo, ".git"));
    const repoBin = path.join(repo, "node_modules", ".bin");
    fs.mkdirSync(repoBin, { recursive: true });
    process.chdir(repo);
    trustRoot._resetTrustRootCache();

    const env = sanitizedSpawnEnv({ PATH: [repoBin, outside].join(path.delimiter), KEEP: "yes" });
    const entries = env.PATH.split(path.delimiter);
    assert.ok(!entries.includes(repoBin), `repo PATH entry survived: ${env.PATH}`);
    assert.ok(entries.includes(outside), "non-repo entries must be preserved");
    assert.equal(env.KEEP, "yes", "unrelated variables pass through");
  } finally {
    process.chdir(oldCwd);
    trustRoot._resetTrustRootCache();
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
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

test("a repo-local binary does not HIDE the real system CLI behind it", async () => {
  // Resolving to the first match and then rejecting it made one repo-local
  // binary shadow the genuine tool: a dependency shipping its own `advcli` into
  // node_modules/.bin — which npx puts first — made an installed system copy
  // report as unavailable, so the tool refused a provider the user had. Skipping
  // repo entries during the walk is both safer and correct.
  const { resolveTrustedCli } = await import("../src/llm.js");
  const trustRoot = await import("../src/trust-root.js");

  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "adv-shadow-repo-"));
  const system = fs.mkdtempSync(path.join(os.tmpdir(), "adv-shadow-sys-"));
  const oldPath = process.env.PATH;
  const oldCwd = process.cwd();
  try {
    const repoBin = path.join(repo, "node_modules", ".bin");
    fs.mkdirSync(repoBin, { recursive: true });
    fs.mkdirSync(path.join(repo, ".git"));
    for (const dir of [repoBin, system]) {
      const p = path.join(dir, "advcli");
      fs.writeFileSync(p, "#!/bin/sh\nexit 0\n");
      fs.chmodSync(p, 0o755);
    }

    process.chdir(repo);
    trustRoot._resetTrustRootCache();
    process.env.PATH = [repoBin, system].join(path.delimiter);

    assert.equal(
      resolveTrustedCli("advcli"),
      fs.realpathSync(path.join(system, "advcli")),
      "the system copy must be found past the repo-local one, not hidden by it"
    );
  } finally {
    process.chdir(oldCwd);
    process.env.PATH = oldPath;
    trustRoot._resetTrustRootCache();
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(system, { recursive: true, force: true });
  }
});

test("a failed or missing bootstrap git does not SHRINK the trust root", async () => {
  // The failure path has to stay at least as wide as the success path. Falling
  // back to cwd discarded the discovered boundary exactly when the tool could
  // verify least — no git on PATH, or one that failed — and from a nested package
  // that shrinks the root to /repo/packages/app, at which point the ancestor
  // /repo/node_modules/.bin measures as OUTSIDE the repository and its git counts
  // as trusted. Making the bootstrap fail would then be a way to open the hijack.
  const trustRoot = await import("../src/trust-root.js");
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "adv-shrink-"));
  const emptyBin = fs.mkdtempSync(path.join(os.tmpdir(), "adv-shrink-bin-"));
  const oldPath = process.env.PATH;
  const oldCwd = process.cwd();
  try {
    fs.mkdirSync(path.join(repo, ".git"));
    const nested = path.join(repo, "packages", "app");
    fs.mkdirSync(nested, { recursive: true });
    const repoBin = path.join(repo, "node_modules", ".bin");
    fs.mkdirSync(repoBin, { recursive: true });
    const evil = path.join(repoBin, "advgit");
    fs.writeFileSync(evil, "#!/bin/sh\nexit 0\n");
    fs.chmodSync(evil, 0o755);

    // No git reachable at all: the bootstrap cannot run.
    process.chdir(nested);
    trustRoot._resetTrustRootCache();
    process.env.PATH = emptyBin;

    assert.equal(
      trustRoot.reviewTrustRoot(),
      fs.realpathSync(repo),
      "the trust root must stay the whole worktree, not the nested cwd"
    );
    // And with the root intact, the ancestor-owned repo binary is still refused.
    trustRoot._resetTrustRootCache();
    process.env.PATH = repoBin;
    process.chdir(nested);
    assert.equal(
      (await import("../src/spawn-safe.js")).resolveTrustedCommand("advgit"),
      null,
      "an ancestor-owned repo binary must not become trusted when the bootstrap fails"
    );
  } finally {
    process.chdir(oldCwd);
    process.env.PATH = oldPath;
    trustRoot._resetTrustRootCache();
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(emptyBin, { recursive: true, force: true });
  }
});

test("with no .git anywhere, the bootstrap runs nothing at all", async () => {
  // findWorktreeBoundary walks UP, so from inside a real repo it finds the root.
  // The hole needed NO .git up the tree: boundary fell back to cwd, so an
  // ANCESTOR's node_modules/.bin stayed eligible and its git executed before the
  // containment check could reject it. The review fails as "not a git repository"
  // either way — it must fail without running anything first.
  const trustRoot = await import("../src/trust-root.js");
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "adv-nogit-"));
  const oldPath = process.env.PATH;
  const oldCwd = process.cwd();
  try {
    const ancestorBin = path.join(base, "node_modules", ".bin");
    const nested = path.join(base, "sub", "deeper");
    fs.mkdirSync(ancestorBin, { recursive: true });
    fs.mkdirSync(nested, { recursive: true });

    const marker = path.join(base, "PWNED");
    const evil = path.join(ancestorBin, "git");
    // Redirection, not `touch`: PATH here is the evil directory ALONE, so an
    // external command would not resolve and the marker would never appear —
    // the test would pass whether or not the payload ran.
    fs.writeFileSync(evil, `#!/bin/sh\n: > "${marker}"\necho "${base}"\n`);
    fs.chmodSync(evil, 0o755);

    process.chdir(nested);
    trustRoot._resetTrustRootCache();
    process.env.PATH = ancestorBin;

    const root = trustRoot.reviewTrustRoot();
    assert.equal(
      fs.existsSync(marker),
      false,
      "an ancestor-owned git executed during the bootstrap of a non-repository directory"
    );
    assert.equal(root, fs.realpathSync(nested), "with no worktree, cwd is the boundary");
  } finally {
    process.chdir(oldCwd);
    process.env.PATH = oldPath;
    trustRoot._resetTrustRootCache();
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test("PATH is read case-insensitively, as Windows supplies it", () => {
  // sanitizePathEnv preserves the ORIGINAL key casing, so on Windows it returns
  // { Path: ... }. process.env papers over case only for the live object, not a
  // plain copy — so reading env.PATH from a sanitized env yielded undefined and
  // every command silently resolved to nothing.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "adv-pathcase-"));
  try {
    const bin = path.join(dir, "advcase");
    fs.writeFileSync(bin, "#!/bin/sh\nexit 0\n");
    fs.chmodSync(bin, 0o755);
    for (const key of ["PATH", "Path", "path"]) {
      assert.equal(
        resolveCommand("advcase", { platform: "linux", env: { [key]: dir } }),
        fs.realpathSync(bin),
        `env key ${key} must resolve`
      );
    }
    // And the sanitized env round-trips through the resolver whatever the casing.
    const sanitized = sanitizePathEnv({ Path: dir }, "/nowhere-outside");
    assert.equal(resolveCommand("advcase", { platform: "linux", env: sanitized }), fs.realpathSync(bin));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
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

test("no repository-supplied helper on PATH is executed during a review", { skip: process.platform === "win32" ? "posix-only shims" : false }, () => {
  // Every helper the review path may spawn, planted at once in the repo's own
  // node_modules/.bin with npx's PATH ordering. Each drops a marker naming
  // itself, so a regression says exactly which spawn site lost its resolver.
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "adv-helpers-"));
  try {
    const realGit = resolveCommand("git");
    assert.ok(realGit, "this test needs a real git on PATH");

    const repoBin = path.join(repo, "node_modules", ".bin");
    fs.mkdirSync(repoBin, { recursive: true });
    const markerDir = path.join(repo, "markers");
    fs.mkdirSync(markerDir);

    const helpers = ["git", "getconf", "unshare", "codex", "claude", "agy"];
    for (const name of helpers) {
      const p = path.join(repoBin, name);
      // Exit non-zero so nothing downstream mistakes these for working tools.
      fs.writeFileSync(p, `#!/bin/sh\ntouch "${path.join(markerDir, name)}"\nexit 1\n`);
      fs.chmodSync(p, 0o755);
    }

    const g = (a) => spawnSync(realGit, a, { cwd: repo, encoding: "utf8" });
    g(["init", "-q"]);
    g(["config", "user.email", "t@t.t"]);
    g(["config", "user.name", "t"]);
    fs.writeFileSync(path.join(repo, "code.js"), "export const x = 1;\n");
    g(["add", "-A"]);
    g(["commit", "-qm", "init"]);
    fs.writeFileSync(path.join(repo, "code.js"), "export const x = 2;\n");

    const PATH = [repoBin, nodeBinDir, path.dirname(realGit), "/usr/bin", "/bin"].join(path.delimiter);
    spawnSync(process.execPath, [cli, "--prompt-only", "--scope", "working-tree", "--allow-secrets"], {
      cwd: repo,
      encoding: "utf8",
      env: { HOME: process.env.HOME, PATH }
    });

    const executed = fs.readdirSync(markerDir);
    assert.deepEqual(executed, [], `repository-supplied helpers were executed: ${executed.join(", ")}`);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});
