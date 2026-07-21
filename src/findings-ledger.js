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

// Append entries to the ledger as JSONL. Creates parent dirs; appends (never
// truncates); writes all lines in a single call so a line is never half-written
// under concurrent runs. No-op when there are no entries.
//
// Scope note: this is the MINIMAL T14 behaviour — new ledgers are created
// owner-only (0600), a strict improvement over inheriting umask. It does NOT
// harden a pre-existing ledger's mode, and it does NOT defend the
// attacker-controlled default path (`.adlc/findings.jsonl` inside the reviewed
// repository) against planted symlinks. That symlink safety kept regenerating
// review findings when patched piecemeal here, so it is being solved completely
// and reviewed in isolation as T20 (canonicalize-contain-open). Following a
// symlink on append is no worse than main today; the fix belongs in T20.
export function appendLedger(ledgerPath, entries) {
  if (!entries || entries.length === 0) return;
  const dir = path.dirname(ledgerPath);
  if (dir && dir !== ".") fs.mkdirSync(dir, { recursive: true });
  const buffer = entries.map((e) => JSON.stringify(e)).join("\n") + "\n";
  // `mode` applies only when appendFileSync CREATES the file; an existing ledger
  // keeps whatever mode it already has, so this never loosens one.
  fs.appendFileSync(ledgerPath, buffer, { mode: 0o600 });
}
