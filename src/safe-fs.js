// Symlink-safe file opening.
//
// The findings ledger defaults to `.adlc/findings.jsonl` INSIDE the repository
// under review, so every component of that path is attacker-controlled. A
// hostile repo can plant a symlink — at the leaf, the `.adlc` directory, or any
// ancestor — to redirect our write (and any chmod) onto a file outside the repo.
//
// THREAT MODEL (bounded on purpose). A read-only review is static files on disk
// with NO attacker process running concurrently, so the threat is a STATICALLY
// PLANTED symlink, not a live TOCTOU race. A live race — swapping the leaf OR any
// ancestor to a symlink in the window between our check and our open — would
// need a concurrent writer this model excludes. Node exposes no portable
// openat()-style per-component fd traversal that would close that window, so it
// is documented here as out of scope rather than chased with partial locking.
// O_NOFOLLOW still closes the leaf-swap case on POSIX for free.
//
// The mechanism is ONE pass over the whole path — canonicalize, contain, open —
// not a per-component check-then-act chain. Component-at-a-time hardening is what
// makes this class of bug oscillate: each patch covers the one component the last
// review named and leaves the next uncovered.

import fs from "node:fs";
import path from "node:path";

// O_NOFOLLOW does not exist on Windows (the constant is undefined there), so it
// no-ops; the portable lstat leaf-check below covers the leaf on every platform.
const O_NOFOLLOW = fs.constants.O_NOFOLLOW ?? 0;

export class UncontainedPathError extends Error {
  constructor(message) {
    super(message);
    this.name = "UncontainedPathError";
    this.code = "EUNCONTAINED";
  }
}

/**
 * Open `targetPath` for appending, refusing any symlink in the path chain and —
 * when the operator named a path INSIDE `base` — guaranteeing the resolved file
 * stays inside `base`.
 *
 * Two trust cases, decided by operator INTENT (lexical), enforced by ACTUAL
 * resolution (realpath):
 *   - Target named under `base` (the default `.adlc/findings.jsonl` case): the
 *     canonical parent MUST remain under `base`. A repo-planted symlink that
 *     escapes is refused.
 *   - Target the operator named OUTSIDE `base` (e.g. `--findings-ledger
 *     /ci/artifacts/x`): an explicit, trusted choice outside the repo-symlink
 *     threat model — containment is not enforced, but a symlinked leaf is still
 *     refused.
 *
 * The caller receives an open fd and MUST close it. All subsequent operations
 * (write, fstat, fchmod) go through the fd, never the path, so nothing can be
 * swapped after the open.
 *
 * @returns {number} an open, appendable file descriptor
 */
export function openContainedAppendFd(
  targetPath,
  { base = process.cwd(), mode = 0o600, mkdirMode = 0o700 } = {}
) {
  const lexicalBase = path.resolve(base);
  const lexicalTarget = path.resolve(lexicalBase, targetPath);
  const rel = path.relative(lexicalBase, lexicalTarget);
  const insideBase = rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);

  if (insideBase) {
    // The attacker-controlled region is every component STRICTLY UNDER base,
    // down to and including the leaf. lstat each existing one — without
    // following — and refuse ANY symlink, whether it escapes the repo or
    // redirects within it. This runs BEFORE any mkdir/open, so a symlink can
    // never direct a side effect (a created directory, an append, a chmod)
    // before the guard fires.
    //
    // Components of `base` itself are never inspected, so a benign symlinked
    // prefix (macOS /var -> /private/var) is not a false positive — path
    // resolution follows those intermediates for us; only each final component
    // is lstat'd, and none of base's own components is ever a "final" here.
    let cur = lexicalBase;
    for (const part of rel.split(path.sep)) {
      cur = path.join(cur, part);
      let st;
      try {
        st = fs.lstatSync(cur);
      } catch {
        break; // this component and everything below it does not exist yet;
               // mkdir will create them as real dirs, and open as a real file.
      }
      if (st.isSymbolicLink()) {
        throw new UncontainedPathError(
          `Refusing to write "${targetPath}": "${cur}" is a symbolic link, which could ` +
          `redirect the write and its permission change onto another file.`
        );
      }
    }
  } else {
    // The operator named a path OUTSIDE base (e.g. --findings-ledger
    // /ci/artifacts/x): a trusted, explicit choice, not a repo-planted link.
    // Containment does not apply, but a symlinked leaf is still refused.
    let leafStat = null;
    try {
      leafStat = fs.lstatSync(lexicalTarget);
    } catch { /* absent = first write */ }
    if (leafStat && leafStat.isSymbolicLink()) {
      throw new UncontainedPathError(
        `Refusing to write "${targetPath}": its final component is a symbolic link.`
      );
    }
  }

  // Safe now: the existing suffix is symlink-free, so mkdir cannot follow a link
  // outside base, and any directory it creates is a real directory.
  fs.mkdirSync(path.dirname(lexicalTarget), { recursive: true, mode: mkdirMode });

  try {
    // O_NOFOLLOW is the atomic backstop on POSIX: if the leaf was created as a
    // symlink between the lstat walk and here (a live race the static threat
    // model excludes), the open fails with ELOOP rather than following it.
    return fs.openSync(
      lexicalTarget,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_APPEND | O_NOFOLLOW,
      mode
    );
  } catch (err) {
    if (err.code === "ELOOP") {
      throw new UncontainedPathError(
        `Refusing to write "${targetPath}": its final component is a symbolic link.`
      );
    }
    throw err;
  }
}
