// The single containment predicate.
//
// This exists because the naive form was written four separate times and three
// of them were wrong the same way. `!rel.startsWith("..")` treats a legitimate
// CHILD named "..cache" as a traversal: path.relative(root, root + "/..cache/x")
// returns "..cache/x", which starts with ".." without escaping anything. Every
// caller here uses the result to decide TRUST, so the error runs the wrong way —
// a real descendant measures as OUTSIDE the repository and becomes trusted. A
// repository can reach that state deliberately by committing an executable under
// a "..name" directory and pointing node_modules/.bin at it.
//
// Match the traversal TOKEN instead: ".." alone, or ".." followed by a separator.

import path from "path";

/**
 * Is `target` at or inside `root`?
 *
 * Pure and lexical: callers canonicalize (realpath) first when symlinks matter.
 * Returns true when the two are the same path.
 */
export function isPathInside(target, root) {
  const rel = path.relative(path.resolve(root), path.resolve(target));
  if (rel === "") return true;
  if (path.isAbsolute(rel)) return false;
  return rel !== ".." && !rel.startsWith(".." + path.sep);
}
