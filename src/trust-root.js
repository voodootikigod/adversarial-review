import { execFileSync } from "child_process";
import fs from "fs";
import path from "path";

// The TRUST BOUNDARY for a review is the whole git worktree under review, NOT
// process.cwd(). Running from a nested package (e.g. /repo/packages/app) must not
// classify the rest of the repo (/repo/node_modules/.bin, /repo/adv-config.json)
// as "outside" and therefore trusted. So containment is measured against the git
// worktree top level; when not inside a git repo, it falls back to cwd.

let cachedRoot; // undefined = not yet computed

// Canonicalize `p` by realpath-ing its longest existing prefix and re-appending
// the not-yet-existing tail, so symlinks are resolved even for a path (config
// file, cache dir) that does not exist yet.
export function canonicalize(p) {
  let cur = path.resolve(p);
  const tail = [];
  for (;;) {
    try {
      const real = fs.realpathSync(cur);
      return tail.length ? path.join(real, ...tail.reverse()) : real;
    } catch {
      const parent = path.dirname(cur);
      if (parent === cur) return path.resolve(p);
      tail.push(path.basename(cur));
      cur = parent;
    }
  }
}

// The canonical git worktree top level (the trust root), or the cwd when not in a
// git repo. Cached for the process; `git rev-parse` runs at most once.
export function reviewTrustRoot({ cwd = process.cwd() } = {}) {
  if (cachedRoot !== undefined) return cachedRoot;
  let root = cwd;
  try {
    const out = execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd,
      encoding: "utf8",
      timeout: 2000,
      stdio: ["ignore", "pipe", "ignore"]
    }).trim();
    if (out) root = out;
  } catch {
    // not a git repo / git missing → cwd is the best available boundary
  }
  cachedRoot = canonicalize(root);
  return cachedRoot;
}

// Test seam: forget the memoized root (the real CLI computes it once per process).
export function _resetTrustRootCache() {
  cachedRoot = undefined;
}

// True when `target` is contained within the trust root (symlink-resolved). An
// explicit `root` overrides the git detection (used by unit tests).
export function isInsideTrustRoot(target, { root } = {}) {
  const r = canonicalize(root ?? reviewTrustRoot());
  const t = canonicalize(target);
  const rel = path.relative(r, t);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}
