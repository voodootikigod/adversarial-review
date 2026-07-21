// Symlink-safe file opening.
//
// The findings ledger defaults to `.adlc/findings.jsonl` INSIDE the repository
// under review, so every component of that path is attacker-controlled. A
// hostile repo can plant a symlink — at the leaf, the `.adlc` directory, or any
// ancestor — to redirect our write (and any chmod) onto a file outside the repo.
//
// THREAT MODEL (bounded on purpose). A read-only review is static files on disk
// with NO attacker process running concurrently, so the threat is a STATICALLY
// PLANTED symlink, not a live TOCTOU race. Live races would need a concurrent
// writer this model excludes; they are documented here as out of scope rather
// than chased with ever-finer locking.
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
  const intendedInside =
    lexicalTarget === lexicalBase || lexicalTarget.startsWith(lexicalBase + path.sep);

  // mkdir never creates a symlink; creating through an existing symlinked parent
  // is caught by the containment check below (realpath resolves it, then we test
  // where it actually landed).
  const parent = path.dirname(lexicalTarget);
  fs.mkdirSync(parent, { recursive: true, mode: mkdirMode });

  // realpath resolves EVERY symlink in the parent chain in a single call — the
  // whole-path move that replaces walking components one at a time.
  const realParent = fs.realpathSync(parent);

  if (intendedInside) {
    // Canonicalize both sides so a benign symlinked prefix (e.g. macOS
    // /var -> /private/var) is not a false positive: canonical-vs-canonical.
    const realBase = fs.realpathSync(lexicalBase);
    if (realParent !== realBase && !realParent.startsWith(realBase + path.sep)) {
      throw new UncontainedPathError(
        `Refusing to write "${targetPath}": its directory resolves to "${realParent}", ` +
        `outside the intended root "${realBase}". A symbolic link in the path would redirect the write.`
      );
    }
  }

  const leaf = path.join(realParent, path.basename(lexicalTarget));

  // Portable leaf guard: O_NOFOLLOW is unavailable on Windows, so lstat the leaf
  // first. A residual leaf-swap between this lstat and the open is a live TOCTOU
  // race, which the static threat model excludes; O_NOFOLLOW closes it anyway on
  // POSIX.
  let leafStat = null;
  try {
    leafStat = fs.lstatSync(leaf);
  } catch {
    // ENOENT: the leaf does not exist yet — the normal first-write case.
  }
  if (leafStat && leafStat.isSymbolicLink()) {
    throw new UncontainedPathError(
      `Refusing to write "${targetPath}": its final component "${leaf}" is a symbolic link.`
    );
  }

  try {
    return fs.openSync(
      leaf,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_APPEND | O_NOFOLLOW,
      mode
    );
  } catch (err) {
    if (err.code === "ELOOP") {
      // The leaf became a symlink between the lstat and the open (POSIX,
      // O_NOFOLLOW). Treat identically to a planted leaf symlink.
      throw new UncontainedPathError(
        `Refusing to write "${targetPath}": its final component is a symbolic link.`
      );
    }
    throw err;
  }
}
