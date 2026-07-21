import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openContainedAppendFd, UncontainedPathError } from "../src/safe-fs.js";

// Real temp roots are canonicalized (realpathSync) so comparisons against the
// module's own realpath calls line up: on macOS os.tmpdir() is under the
// /var -> /private/var symlink, which is exactly the AC5 false-positive case.
function tmpRoot(tag) {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `adv-safefs-${tag}-`)));
}

function appendVia(fd, text) {
  try { fs.writeSync(fd, text); } finally { fs.closeSync(fd); }
}

test("AC1: a leaf symlink pointing outside the repo is refused; victim untouched", () => {
  const root = tmpRoot("leaf");
  try {
    const victim = path.join(root, "victim.txt");
    fs.writeFileSync(victim, "important\n");
    fs.chmodSync(victim, 0o644);
    const repo = path.join(root, "repo");
    fs.mkdirSync(repo);
    const ledger = path.join(repo, "findings.jsonl");
    fs.symlinkSync(victim, ledger);

    assert.throws(() => openContainedAppendFd(ledger, { base: repo }), UncontainedPathError);
    assert.equal(fs.readFileSync(victim, "utf8"), "important\n", "victim not written");
    assert.equal(fs.statSync(victim).mode & 0o777, 0o644, "victim mode unchanged");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("AC2: a parent directory symlink (.adlc -> outside) is refused; victim untouched", () => {
  const root = tmpRoot("parent");
  try {
    const outside = path.join(root, "outside");
    fs.mkdirSync(outside);
    const victim = path.join(outside, "findings.jsonl");
    fs.writeFileSync(victim, "pre\n");
    const repo = path.join(root, "repo");
    fs.mkdirSync(repo);
    fs.symlinkSync(outside, path.join(repo, ".adlc"));

    assert.throws(
      () => openContainedAppendFd(path.join(repo, ".adlc", "findings.jsonl"), { base: repo }),
      UncontainedPathError
    );
    assert.equal(fs.readFileSync(victim, "utf8"), "pre\n", "victim not written");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("AC3: a grandparent symlink two levels up is refused", () => {
  const root = tmpRoot("grand");
  try {
    const outside = path.join(root, "outside");
    fs.mkdirSync(outside);
    const repo = path.join(root, "repo");
    fs.mkdirSync(repo);
    // repo/a -> outside, target repo/a/b/findings.jsonl escapes via the grandparent.
    fs.symlinkSync(outside, path.join(repo, "a"));

    assert.throws(
      () => openContainedAppendFd(path.join(repo, "a", "b", "findings.jsonl"), { base: repo }),
      UncontainedPathError
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("AC4: a symlink that resolves INSIDE the repo is allowed (no escape, no victim)", () => {
  const root = tmpRoot("inside");
  try {
    const repo = path.join(root, "repo");
    fs.mkdirSync(repo);
    const realDir = path.join(repo, "real-adlc");
    fs.mkdirSync(realDir);
    fs.symlinkSync(realDir, path.join(repo, ".adlc")); // .adlc -> repo/real-adlc (still inside)

    const fd = openContainedAppendFd(path.join(repo, ".adlc", "findings.jsonl"), { base: repo });
    appendVia(fd, "{\"id\":1}\n");
    assert.equal(fs.readFileSync(path.join(realDir, "findings.jsonl"), "utf8"), "{\"id\":1}\n");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("AC5: a canonical base under a symlinked prefix is NOT a false positive", () => {
  const root = tmpRoot("basesym");
  try {
    // realTarget/ is the actual repo; symlinkedBase -> realTarget mimics /var -> /private/var.
    const realTarget = path.join(root, "real");
    fs.mkdirSync(realTarget);
    const symlinkedBase = path.join(root, "link");
    fs.symlinkSync(realTarget, symlinkedBase);

    const fd = openContainedAppendFd(path.join(symlinkedBase, ".adlc", "findings.jsonl"), { base: symlinkedBase });
    appendVia(fd, "ok\n");
    assert.equal(fs.readFileSync(path.join(realTarget, ".adlc", "findings.jsonl"), "utf8"), "ok\n");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("AC6: a first write creates the leaf 0600 with no symlink present", { skip: process.platform === "win32" }, () => {
  const root = tmpRoot("create");
  try {
    const fd = openContainedAppendFd(path.join(root, ".adlc", "findings.jsonl"), { base: root });
    appendVia(fd, "line\n");
    const leaf = path.join(root, ".adlc", "findings.jsonl");
    assert.equal(fs.readFileSync(leaf, "utf8"), "line\n");
    assert.equal(fs.statSync(leaf).mode & 0o777, 0o600, "new leaf is owner-only");
    assert.ok(!fs.lstatSync(leaf).isSymbolicLink());
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("AC7: an existing regular-file ledger is appended to; the fd can tighten a loose mode", { skip: process.platform === "win32" }, () => {
  const root = tmpRoot("append");
  try {
    const leaf = path.join(root, "findings.jsonl");
    fs.writeFileSync(leaf, "first\n");
    fs.chmodSync(leaf, 0o644);

    const fd = openContainedAppendFd(leaf, { base: root });
    try {
      fs.writeSync(fd, "second\n");
      // The fd is what makes tightening safe — it cannot be redirected.
      if ((fs.fstatSync(fd).mode & 0o777) !== 0o600) fs.fchmodSync(fd, 0o600);
    } finally {
      fs.closeSync(fd);
    }
    assert.equal(fs.readFileSync(leaf, "utf8"), "first\nsecond\n", "appended, not truncated");
    assert.equal(fs.statSync(leaf).mode & 0o777, 0o600, "mode tightened via the fd");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("AC (operator intent): an absolute path the operator chose OUTSIDE base is allowed", () => {
  // --findings-ledger /ci/artifacts/x is a trusted operator choice, not a repo
  // symlink. Containment must not refuse it.
  const root = tmpRoot("operator");
  try {
    const repo = path.join(root, "repo");
    fs.mkdirSync(repo);
    const elsewhere = path.join(root, "ci-artifacts", "findings.jsonl"); // outside `repo`
    const fd = openContainedAppendFd(elsewhere, { base: repo });
    appendVia(fd, "ci\n");
    assert.equal(fs.readFileSync(elsewhere, "utf8"), "ci\n");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("AC (operator intent): but a symlinked leaf is refused even outside base", () => {
  const root = tmpRoot("operator-leaf");
  try {
    const repo = path.join(root, "repo");
    fs.mkdirSync(repo);
    const victim = path.join(root, "victim.txt");
    fs.writeFileSync(victim, "keep\n");
    const outside = path.join(root, "ci");
    fs.mkdirSync(outside);
    const ledger = path.join(outside, "findings.jsonl");
    fs.symlinkSync(victim, ledger);

    assert.throws(() => openContainedAppendFd(ledger, { base: repo }), UncontainedPathError);
    assert.equal(fs.readFileSync(victim, "utf8"), "keep\n", "victim untouched");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("AC11: the module documents the TOCTOU / static-threat boundary", () => {
  // Collapse comment line-wrapping so the match is not defeated by "//\n" breaks.
  const src = fs.readFileSync(new URL("../src/safe-fs.js", import.meta.url), "utf8")
    .replace(/\n\s*\/\/\s*/g, " ");
  assert.match(src, /statically planted symlink/i, "must state the static-threat scope");
  assert.match(src, /TOCTOU/, "must name the excluded live-race case");
});
