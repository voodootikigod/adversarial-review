// PATH resolution for bare command names.
//
// This lives in its own module with NO local imports so both spawn-safe.js and
// trust-root.js can use it. trust-root.js needs it to run git safely, and
// spawn-safe.js imports trust-root.js — importing the other direction would make
// a cycle.

import fs from "fs";
import path from "path";
import { isPathInside } from "./path-containment.js";

// Only bare command tokens are resolvable. A path separator or shell
// metacharacter reaching a spawn site is a bug in the caller, not a lookup to
// perform — rejecting it here keeps that from becoming an injection.
const BARE_COMMAND = /^[A-Za-z0-9._-]+$/;

// Symlinks MUST be resolved on both sides. process.cwd() and git's toplevel come
// back realpath-resolved ("/private/var/…" on macOS) while PATH entries do not
// ("/var/…"), so a plain path.relative call reports a directory that is literally
// inside the repository as outside it — and the exclusion silently does nothing.
// This mirrors canonicalize() in trust-root.js, reimplemented here because
// importing that module would reintroduce the cycle this one exists to break.
function realpathOrSelf(p) {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

function isInside(target, root) {
  return isPathInside(realpathOrSelf(target), realpathOrSelf(root));
}

/**
 * An environment whose PATH excludes everything inside `root`.
 *
 * Lives HERE, taking the root as a parameter, precisely so the trust-root
 * bootstrap can use it. The convenience wrapper in spawn-safe.js supplies
 * reviewTrustRoot(), which the bootstrap cannot call — it is what computes it —
 * and importing that wrapper would be a cycle. Without this split the one git
 * invocation that runs before everything else was the only spawn still inheriting
 * the repository's PATH, so an external git wrapper with a `/usr/bin/env` shebang
 * would resolve its interpreter out of ./node_modules/.bin.
 */
export function sanitizePathEnv(env, root) {
  const key = Object.keys(env).find((k) => k.toUpperCase() === "PATH") ?? "PATH";
  const kept = (env[key] || "")
    .split(path.delimiter)
    .filter(Boolean)
    .filter((dir) => !isInside(dir, root));

  const out = { ...env, [key]: kept.join(path.delimiter) };
  // Stops the Windows command interpreter searching the current directory — the
  // repository under review — ahead of PATH.
  if (process.platform === "win32") out.NoDefaultCurrentDirectoryInExePath = "1";
  return out;
}

/**
 * Resolve a bare command name to an absolute executable path, or null.
 *
 * `excludeRoots` drops PATH entries that live inside any of the given
 * directories. npm and npx prepend ./node_modules/.bin to PATH, so without it a
 * repository can put a binary on the reviewer's PATH just by shipping one.
 *
 * The `platform`/`env` seam exists so the Windows PATHEXT behaviour is testable
 * on a POSIX machine; production callers pass neither.
 */
export function resolveCommand(
  cmd,
  { platform = process.platform, env = process.env, excludeRoots = [] } = {}
) {
  if (typeof cmd !== "string" || !BARE_COMMAND.test(cmd)) return null;

  const pathDirs = (env.PATH || "")
    .split(path.delimiter)
    .filter(Boolean)
    .filter((dir) => !excludeRoots.some((root) => root && isInside(dir, root)));

  // On Windows a bare name does not identify a file: `claude` is `claude.cmd`
  // for anything installed by npm. Resolving the real filename ourselves is
  // what lets us drop `shell: true`, which was only ever there to make the
  // shell perform this lookup for us — and on Windows it is also what keeps
  // CreateProcess from searching the CURRENT DIRECTORY, which for this tool is
  // the repository under review.
  const extensions = platform === "win32"
    ? (env.PATHEXT || ".EXE;.CMD;.BAT;.COM").split(";").filter(Boolean).map((e) => e.toLowerCase())
    : [""];

  for (const dir of pathDirs) {
    for (const ext of extensions) {
      const file = ext && cmd.toLowerCase().endsWith(ext) ? cmd : `${cmd}${ext}`;
      const candidate = path.join(dir, file);
      try {
        // On win32 the X_OK bit is not meaningful, so existence + regular file
        // is the strongest check available there.
        if (platform !== "win32") fs.accessSync(candidate, fs.constants.X_OK);
        if (!fs.statSync(candidate).isFile()) continue;
        // Excluding the DIRECTORY is not enough: a permitted directory can hold a
        // symlink whose target lives inside an excluded root — a globally linked
        // binary pointing back into the repository under review. What executes is
        // the target, so the target is what must be checked, and the canonical
        // path is what we return so callers spawn the thing we actually vetted.
        const real = realpathOrSelf(candidate);
        if (excludeRoots.some((root) => root && isInside(real, root))) continue;
        return real;
      } catch {
        // Not this candidate; keep looking.
      }
    }
  }
  return null;
}
