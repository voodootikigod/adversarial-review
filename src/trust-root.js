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
// The worktree boundary, found WITHOUT executing anything: walk ancestors for a
// `.git` entry (a directory in a normal clone, a file in a submodule or linked
// worktree). Returns null when there is none.
//
// This exists because the boundary has to be known BEFORE git runs. Excluding
// only cwd is not enough: run from /repo/packages/app and the ancestor-owned
// /repo/node_modules/.bin — which npm and npx put first on PATH — is outside cwd
// and stays eligible, so the repository picks the git that inspects it, and the
// containment checks that follow are already too late. A pure filesystem walk
// cannot be hijacked the way a PATH lookup can.
export function findWorktreeBoundary(startDir) {
  let cur = path.resolve(startDir);
  for (;;) {
    try {
      // Canonicalized on the way out, like every other boundary this module
      // produces: a caller comparing it against a realpath-resolved path must not
      // have to know which of the two forms it got.
      if (fs.existsSync(path.join(cur, ".git"))) return canonicalize(cur);
    } catch {
      // Unreadable directory — keep walking.
    }
    const parent = path.dirname(cur);
    if (parent === cur) return null;
    cur = parent;
  }
}

export function reviewTrustRoot({ cwd = process.cwd() } = {}) {
  if (cachedRoot !== undefined) return cachedRoot;
  // BOOTSTRAP: git must run before the root it reports exists, so the boundary is
  // established by the exec-free ancestor walk above and the WHOLE boundary is
  // excluded from PATH resolution. Together with resolving to an absolute path
  // (never a bare name, which Windows resolves from the current directory — the
  // repository under review) that closes both hijack routes before anything runs.
  const boundary = findWorktreeBoundary(cwd) ?? canonicalize(cwd);
  // The FALLBACK is the boundary, not cwd. Falling back to cwd discarded the
  // boundary exactly when the tool was least able to verify anything — no git on
  // PATH, or a git that failed or timed out — and from a nested package that
  // shrinks the trust root to /repo/packages/app, at which point the ancestor
  // /repo/node_modules/.bin measures as OUTSIDE the repository and its git is
  // treated as trusted. The failure path has to stay at least as wide as the
  // success path, or a hijack becomes easier by making the bootstrap fail.
  let root = boundary;
  const git = resolveCommand("git", { excludeRoots: [boundary] });
  if (git) {
    try {
      const out = execFileSync(git, ["rev-parse", "--show-toplevel"], {
        cwd,
        encoding: "utf8",
        timeout: 2000,
        stdio: ["ignore", "pipe", "ignore"]
      }).trim();
      // A git-reported root may only WIDEN the filesystem boundary. The walk
      // cannot be hijacked; a git invocation can be steered (GIT_DIR, a planted
      // .git, a wrapper), so a report that narrows or moves the boundary is
      // ignored rather than trusted to shrink what we protect.
      if (out) {
        const reported = canonicalize(out);
        if (isInsideTrustRoot(boundary, { root: reported })) root = reported;
      }
    } catch {
      // not a git repo, or git failed → the filesystem boundary stands
    }
  }
  cachedRoot = canonicalize(root);
  // The exec-free boundary is at or above the git toplevel in every normal
  // layout, so the bootstrap git should land outside the final root. If it did
  // not, the boundary was wrong and repository-supplied code has ALREADY run —
  // say so loudly instead of continuing on a compromised assumption. cachedRoot
  // stays assigned so a retry cannot execute it a second time.
  if (git && isInsideTrustRoot(git, { root: cachedRoot })) {
    throw Object.assign(
      new Error(
        `Refusing to continue: the git used to locate the repository (${git}) resolves INSIDE ` +
        `the repository under review (${cachedRoot}). A repository must not supply the git that ` +
        `inspects it. Install git system-wide and remove it from this worktree's PATH entries.`
      ),
      { code: "EUNTRUSTEDGIT" }
    );
  }
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
