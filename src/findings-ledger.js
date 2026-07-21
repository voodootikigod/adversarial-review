// Bridge from a review result to the ADLC findings ledger (.adlc/findings.jsonl),
// so P7 distillation (lesson-foundry) can cluster real, repeated findings.
//
// Only GATING findings are recorded (the same set that drives the exit code),
// using the canonical JSONL schema consumed by @adlc/lesson-foundry and emitted
// by @adlc/model-ratchet: { ts, tool, file, line, category, severity, desc }.

import fs from "node:fs";
import { isGatingFinding } from "./review.js";
import { openContainedAppendFd } from "./safe-fs.js";

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

// Append entries to the ledger as JSONL, one write so a line is never
// half-formed under concurrent runs. No-op when there are no entries.
//
// The default ledger path is `.adlc/findings.jsonl` INSIDE the reviewed
// repository, so it is attacker-controlled: a hostile repo can plant a symlink
// anywhere in the chain to redirect this write (and the mode change) onto a
// victim file. openContainedAppendFd handles that completely — canonicalize the
// path, refuse an escape or any symlinked component, and hand back an fd we
// operate through so nothing can be swapped after the check. See src/safe-fs.js.
//
// Gating findings quote source, so the ledger can hold repository excerpts, and
// new files are created 0600. Order matters: an existing looser ledger is
// tightened BEFORE the sensitive entry is written, so the new data never lands
// while the file is world-readable. A chmod failure PROPAGATES rather than being
// swallowed — the caller (recordFindings) warns and skips the ledger, so we
// never write findings to a file we could not secure.
function writeAllSync(fd, buffer) {
  // fs.writeSync may write fewer bytes than requested (signals, quotas, some
  // filesystems). Loop until the whole buffer is on disk, or a truncated JSONL
  // record would silently corrupt the ledger.
  let offset = 0;
  while (offset < buffer.length) {
    offset += fs.writeSync(fd, buffer, offset);
  }
}

export function appendLedger(ledgerPath, entries) {
  if (!entries || entries.length === 0) return;
  const buffer = Buffer.from(entries.map((e) => JSON.stringify(e)).join("\n") + "\n", "utf8");

  const fd = openContainedAppendFd(ledgerPath, { mode: 0o600, mkdirMode: 0o700 });
  try {
    // Secure FIRST, then write. The mode arg only applies on creation, so an
    // existing ledger written before this landed keeps its umask default
    // (commonly 0644). fchmod acts on the fd, so it cannot be redirected.
    if (process.platform !== "win32" && (fs.fstatSync(fd).mode & 0o777) !== 0o600) {
      fs.fchmodSync(fd, 0o600);
    }
    writeAllSync(fd, buffer);
  } finally {
    try { fs.closeSync(fd); } catch { /* ignore */ }
  }
}
