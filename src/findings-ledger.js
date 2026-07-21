// Bridge from a review result to the ADLC findings ledger (.adlc/findings.jsonl),
// so P7 distillation (lesson-foundry) can cluster real, repeated findings.
//
// Only GATING findings are recorded (the same set that drives the exit code),
// using the canonical JSONL schema consumed by @adlc/lesson-foundry and emitted
// by @adlc/model-ratchet: { ts, tool, file, line, category, severity, desc }.

import fs from "node:fs";
import path from "node:path";
import { isGatingFinding } from "./review.js";

// Pure: map a validated review result to ledger entry objects for its gating
// findings. `assessments` are the grounding assessments (index-aligned with
// result.findings); pass a fixed `ts` for deterministic output (e.g. in tests).
export function toLedgerEntries(result, assessments, { failOn = "medium", minConfidence = 0.5, ts } = {}) {
  const timestamp = ts ?? new Date().toISOString();
  return result.findings
    .map((finding, i) => ({ finding, assessment: assessments?.[i] }))
    .filter(({ finding, assessment }) => isGatingFinding(finding, assessment, { failOn, minConfidence }))
    .map(({ finding }) => ({
      ts: timestamp,
      tool: "adversarial-review",
      file: finding.file,
      line: finding.line_start,
      category: finding.category,
      severity: finding.severity,
      // lesson-foundry clusters on `desc`; the concise title clusters better than
      // the full body.
      desc: finding.title
    }));
}

// Walk every directory component of `target` and refuse if any is a symbolic
// link. lstat does not follow, so this inspects the link itself rather than
// what it points at. Checking the chain — not just the leaf — is what stops a
// symlinked `.adlc` from redirecting the write.
// The walk is BOUNDED to components at or below `base` (the working directory).
// Only those are attacker-controlled — `.adlc` inside the reviewed repository is
// the threat. Walking to filesystem root instead rejects legitimate paths: /var
// is itself a symlink on macOS, so an unbounded check refuses every temp
// directory, which is a false positive that breaks normal use.
function assertNoSymlinkedParents(target, base = process.cwd()) {
  const resolved = path.resolve(target);
  const root = path.resolve(base);
  // Only inspect the chain when the ledger actually lives under `base`.
  if (!resolved.startsWith(root + path.sep)) return;

  let current = path.dirname(resolved);
  while (current.startsWith(root + path.sep)) {
    let st;
    try {
      st = fs.lstatSync(current);
    } catch {
      break; // does not exist yet; nothing to traverse through
    }
    if (st.isSymbolicLink()) {
      throw new Error(
        `Refusing to write the findings ledger: "${current}" is a symbolic link. ` +
        `Writing through it would append to, and change the permissions of, files outside the intended path.`
      );
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
}

// Append entries to the ledger as JSONL. Creates parent dirs; appends (never
// truncates); writes all lines in a single call so a line is never half-written
// under concurrent runs. No-op when there are no entries.
export function appendLedger(ledgerPath, entries) {
  if (!entries || entries.length === 0) return;
  // Gating findings quote source code, so the ledger can contain excerpts of the
  // reviewed repository. Create it owner-only rather than inheriting umask.
  const dir = path.dirname(ledgerPath);
  if (dir && dir !== ".") fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const buffer = entries.map((e) => JSON.stringify(e)).join("\n") + "\n";

  // O_NOFOLLOW below guards only the FINAL component. The default ledger path
  // is `.adlc/findings.jsonl` inside the reviewed repository, so the PARENT is
  // attacker-controlled too: a repo shipping `.adlc` as a symlink redirects the
  // whole write, and both the append and the fchmod land outside the repo.
  // Reject a symlink anywhere in the directory chain we are about to traverse.
  assertNoSymlinkedParents(ledgerPath);

  // The default ledger path lives INSIDE the repository under review, so its
  // final component is attacker-controlled. Path-based append + chmod follow
  // symlinks: a repo that pre-creates .adlc/findings.jsonl as a symlink gets our
  // JSON appended to the target AND that target chmod-ed to 0600 — an arbitrary
  // write plus a permission change on a file we never intended to touch.
  //
  // O_NOFOLLOW makes the open fail (ELOOP) when the final component is a
  // symlink, and every subsequent operation goes through the resulting fd
  // rather than the path, so the target cannot be swapped between calls.
  const NOFOLLOW = fs.constants.O_NOFOLLOW ?? 0; // not meaningful on win32
  let fd;
  try {
    fd = fs.openSync(
      ledgerPath,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_APPEND | NOFOLLOW,
      0o600
    );
  } catch (err) {
    if (err.code === "ELOOP") {
      throw new Error(
        `Refusing to write the findings ledger: "${ledgerPath}" is a symbolic link. ` +
        `Writing through it would append to, and change the permissions of, another file.`
      );
    }
    throw err;
  }

  try {
    fs.writeSync(fd, buffer);
    // Harden a pre-existing ledger too: the mode argument is honored only when
    // the file is CREATED, so a ledger written before this change keeps its
    // umask default (commonly 0644) indefinitely — and those are the ones
    // already holding quoted repository source. fchmod acts on the fd we just
    // wrote, so it cannot be redirected. Best effort; never fail the run.
    if (process.platform !== "win32") {
      try {
        const current = fs.fstatSync(fd).mode & 0o777;
        if (current !== 0o600) fs.fchmodSync(fd, 0o600);
      } catch { /* ignore */ }
    }
  } finally {
    try { fs.closeSync(fd); } catch { /* ignore */ }
  }
}
