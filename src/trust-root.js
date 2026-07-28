import { execFileSync } from "child_process";
import fs from "fs";
import path from "path";
import { resolveCommand } from "./resolve-command.js";

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
  // BOOTSTRAP: this call has to run git before the trust root it computes exists,
  // so it cannot use the full check. It gets the two guarantees available without
  // one — an absolute path (never a bare name, which Windows resolves from the
  // CURRENT DIRECTORY, i.e. the repository under review) and no PATH entry inside
  // cwd (npm/npx prepend ./node_modules/.bin). resolveTrustedGit below applies
  // the real containment check to every subsequent invocation.
  const git = resolveCommand("git", { excludeRoots: [path.resolve(cwd)] });
  if (git) {
    try {
      const out = execFileSync(git, ["rev-parse", "--show-toplevel"], {
        cwd,
        encoding: "utf8",
        timeout: 2000,
        stdio: ["ignore", "pipe", "ignore"]
      }).trim();
      if (out) root = out;
    } catch {
      // not a git repo → cwd is the best available boundary
    }
  }
  cachedRoot = canonicalize(root);
  return cachedRoot;
}

let cachedGit; // undefined = not yet resolved

/**
 * The canonical absolute `git` executable to use for every review operation.
 *
 * Bare "git" must never reach a spawn site. On Windows, CreateProcess searches
 * the CURRENT DIRECTORY before PATH, and this tool's current directory is the
 * repository under review — so a repo that commits git.exe would run it with the
 * reviewer's privileges, before any provider sandbox or spawn guard applies. The
 * same reasoning already governs the command interpreter and taskkill.
 *
 * PATH entries inside the trust root are excluded for the same reason a
 * repo-local review CLI is refused: npm and npx put ./node_modules/.bin on PATH,
 * so a repository can otherwise nominate its own git. Throws when no trusted git
 * exists — a review cannot be collected safely without one.
 */
export function resolveTrustedGit() {
  if (cachedGit !== undefined) return cachedGit;
  const root = reviewTrustRoot();
  const resolved = resolveCommand("git", { excludeRoots: [root] });
  if (!resolved || isInsideTrustRoot(resolved, { root })) {
    throw Object.assign(
      new Error(
        "Refusing to run git: no trusted git executable was found outside the repository under " +
        "review. A repository must not supply the git used to inspect it. Install git system-wide " +
        "and ensure it is on PATH from outside this worktree."
      ),
      // Tagged so a caller's "is this a git repo?" probe cannot swallow a security
      // refusal and report it as an ordinary missing-repository condition.
      { code: "EUNTRUSTEDGIT" }
    );
  }
  cachedGit = resolved;
  return cachedGit;
}

// Test seam: forget the memoized root (the real CLI computes it once per process).
export function _resetTrustRootCache() {
  cachedRoot = undefined;
  cachedGit = undefined;
}

// True when `target` is contained within the trust root (symlink-resolved). An
// explicit `root` overrides the git detection (used by unit tests).
export function isInsideTrustRoot(target, { root } = {}) {
  const r = canonicalize(root ?? reviewTrustRoot());
  const t = canonicalize(target);
  const rel = path.relative(r, t);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}
