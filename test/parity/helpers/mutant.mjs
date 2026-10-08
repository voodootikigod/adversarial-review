// Mutant support: the hollow-test countermeasure (T50 item 8, AP9).
//
// withMutant([{ file, find, replace }], fn) copies the whole package (the
// working-tree bytes of `git ls-files -z` minus test/, executable modes kept)
// into a temp dir, applies each exact-string replacement, and calls
// fn(<tmp>/bin/cli.js, { dir }) so a row can run the mutant as its cliEntry.
//   - It THROWS unless `find` occurs EXACTLY ONCE in `file` (0: stale mutant,
//     >1: ambiguous), so a mutant must use a unique snippet.
//   - Into every mutated file it injects one sentinel line (after the shebang,
//     else at line 1): `(await import('node:fs')).writeFileSync('<tmp>/.mutant-loaded-<i>', '');`
//     After fn returns (and also when fn throws; fn's error wins) it throws
//     `mutant was not loaded` unless every mutated file's marker exists.
//
// POLICY: a refactor ticket may not edit any mutant's `find` text. A stale
// mutant is re-targeted in a separate commit under its own approved ticket
// before the refactor merges. Enforcement: every refactor or delta ticket (T55
// and later) declares test/parity/** as rails, so
// `adlc rails-guard --base main --ticket <id>` exits 2 on such an edit.
// Staleness is detected by harness.test.mjs: every `export const MUTANTS = [...]`
// in test/parity/*.test.mjs must have a `find` occurring exactly once in its
// target file at HEAD. MUTANTS must be a self-contained literal (strings,
// numbers, arrays, objects; no references), because it is read statically,
// without importing (and so running) the test file.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HELPERS = path.dirname(fileURLToPath(import.meta.url));
const PARITY = path.resolve(HELPERS, "..");
export const PACKAGE_ROOT = path.resolve(PARITY, "..", "..");

function countOccurrences(text, find) {
  if (!find) return 0;
  let n = 0;
  let i = text.indexOf(find);
  while (i !== -1) { n++; i = text.indexOf(find, i + find.length); }
  return n;
}

function packageFiles(root) {
  const r = spawnSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`withMutant: git ls-files failed: ${r.stderr}`);
  return r.stdout.split("\0").filter((f) => f && !f.startsWith("test/"));
}

function copyPackage(root, dest) {
  for (const rel of packageFiles(root)) {
    const src = path.join(root, rel);
    let st;
    try { st = fs.lstatSync(src); } catch { continue; } // tracked but deleted in the worktree
    if (!st.isFile()) continue;
    const out = path.join(dest, rel);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.copyFileSync(src, out);
    fs.chmodSync(out, st.mode & 0o777);
  }
}

function insertSentinel(text, marker) {
  const line = `(await import('node:fs')).writeFileSync(${JSON.stringify(marker)}, '');`;
  if (text.startsWith("#!")) {
    const nl = text.indexOf("\n");
    return nl === -1 ? `${text}\n${line}\n` : `${text.slice(0, nl + 1)}${line}\n${text.slice(nl + 1)}`;
  }
  return `${line}\n${text}`;
}

export async function withMutant(mutants, fn, { root = PACKAGE_ROOT } = {}) {
  if (!Array.isArray(mutants) || !mutants.length) throw new Error("withMutant: at least one mutant is required");
  // Validate against the source tree before copying anything.
  for (const m of mutants) {
    const text = fs.readFileSync(path.join(root, m.file), "utf8");
    const n = countOccurrences(text, m.find);
    if (n === 0) throw new Error(`stale mutant${m.id ? ` ${m.id}` : ""}: find not found in ${m.file}`);
    if (n > 1) throw new Error(`ambiguous mutant${m.id ? ` ${m.id}` : ""}: find occurs ${n} times in ${m.file}`);
  }
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "parity-mutant-"));
  try {
    copyPackage(root, dir);
    const files = [...new Set(mutants.map((m) => m.file))];
    const markers = files.map((file, i) => {
      const p = path.join(dir, file);
      let text = fs.readFileSync(p, "utf8");
      for (const m of mutants.filter((x) => x.file === file)) {
        if (countOccurrences(text, m.find) !== 1) {
          throw new Error(`ambiguous mutant${m.id ? ` ${m.id}` : ""}: find no longer unique in ${file} after earlier replacements`);
        }
        text = text.replace(m.find, () => m.replace);
      }
      const marker = path.join(dir, `.mutant-loaded-${i}`);
      fs.writeFileSync(p, insertSentinel(text, marker));
      return { file, marker };
    });
    let fnError = null;
    try {
      await fn(path.join(dir, "bin", "cli.js"), { dir });
    } catch (err) {
      fnError = err;
    }
    const missing = markers.filter((m) => !fs.existsSync(m.marker)).map((m) => m.file);
    if (fnError) throw fnError;
    if (missing.length) throw new Error(`mutant was not loaded: ${missing.join(", ")} never evaluated`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// Staleness check: returns violation strings naming each mutant whose `find`
// does not occur exactly once in its target file.
export function checkMutants(mutants, { root = PACKAGE_ROOT } = {}) {
  const out = [];
  for (const m of mutants) {
    const name = `${m.id ?? "(unnamed)"}${m.source ? ` (${m.source})` : ""}`;
    let text;
    try { text = fs.readFileSync(path.join(root, m.file), "utf8"); } catch {
      out.push(`mutant ${name}: target ${m.file} does not exist`);
      continue;
    }
    const n = countOccurrences(text, m.find);
    if (n !== 1) out.push(`mutant ${name}: find occurs ${n} times in ${m.file} (must be exactly once)`);
  }
  return out;
}

// Extracts the array literal after `export const MUTANTS =`, honoring strings,
// template literals and comments.
function extractArrayLiteral(src, start) {
  let i = src.indexOf("[", start);
  if (i === -1) return null;
  const begin = i;
  let depth = 0;
  for (; i < src.length; i++) {
    const c = src[i];
    if (c === '"' || c === "'" || c === "`") {
      const q = c;
      for (i++; i < src.length && src[i] !== q; i++) if (src[i] === "\\") i++;
    } else if (c === "/" && src[i + 1] === "/") {
      i = src.indexOf("\n", i);
      if (i === -1) return null;
    } else if (c === "/" && src[i + 1] === "*") {
      i = src.indexOf("*/", i) + 1;
    } else if (c === "[" || c === "{") {
      depth++;
    } else if (c === "]" || c === "}") {
      depth--;
      if (depth === 0) return src.slice(begin, i + 1);
    }
  }
  return null;
}

// Every MUTANTS entry declared in test/parity/*.test.mjs, tagged with source.
export function collectMutants({ dir = PARITY } = {}) {
  const out = [];
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith(".test.mjs")).sort()) {
    const src = fs.readFileSync(path.join(dir, f), "utf8");
    const re = /^export\s+const\s+MUTANTS\s*=/gm; // declarations at line start only
    let m;
    while ((m = re.exec(src))) {
      const literal = extractArrayLiteral(src, m.index + m[0].length);
      if (!literal) throw new Error(`${f}: cannot read the MUTANTS literal`);
      const list = vm.runInNewContext(`(${literal})`, Object.create(null), { timeout: 1000 });
      for (const mutant of list) out.push({ ...mutant, source: f });
    }
  }
  return out;
}
