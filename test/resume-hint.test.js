import assert from "node:assert/strict";
import test from "node:test";
import { extractResumeHint, resumeHintForError, MAX_SCAN_BYTES } from "../src/resume-hint.js";

test("T14 AC1: a codex resume line is extracted", () => {
  const hint = extractResumeHint("error: run failed\nTo continue: codex resume 01JABCDEF23\n");
  assert.deepEqual(hint, { cli: "codex", id: "01JABCDEF23", command: "codex resume 01JABCDEF23" });
});

test("T14 AC2: an agy resume line is extracted by its own anchor", () => {
  const hint = extractResumeHint("session interrupted; agy resume sess_9f8e7d6c");
  assert.equal(hint.cli, "agy");
  assert.equal(hint.id, "sess_9f8e7d6c");
});

test("T14 AC3: absent or unparseable output yields null, never a throw", () => {
  for (const input of ["", null, undefined, 42, "no session information here"]) {
    assert.equal(extractResumeHint(input), null, `${String(input)} must yield null`);
  }
});

test("T14: a generic 'resume' mention is not treated as a session id", () => {
  // The pattern is anchored per CLI precisely so reviewed content cannot forge
  // a hint. A diff discussing resumption must not produce one.
  assert.equal(extractResumeHint("// TODO: resume abc123 after the retry lands"), null);
  assert.equal(extractResumeHint("the job will resume automatically"), null);
});

test("T14 AC5: a malformed or oversized id is rejected rather than echoed", () => {
  assert.equal(extractResumeHint("codex resume short"), null, "too short");
  assert.equal(extractResumeHint(`codex resume ${"a".repeat(200)}`), null, "too long");
  assert.equal(extractResumeHint("codex resume has space"), null, "whitespace is not an id");
  assert.equal(extractResumeHint("codex resume bad/slash!"), null, "unexpected characters");
});

test("T14 AC6: only a bounded tail is scanned", () => {
  // A valid line buried in the discarded head must not be found — otherwise a
  // huge hostile diff becomes a pathological scan.
  const buried = "codex resume 01JBURIEDID9\n" + "x".repeat(MAX_SCAN_BYTES + 500);
  assert.equal(extractResumeHint(buried), null);
  // ...but the same line near the end is found.
  const nearEnd = "x".repeat(MAX_SCAN_BYTES + 500) + "\ncodex resume 01JFOUNDID99";
  assert.equal(extractResumeHint(nearEnd).id, "01JFOUNDID99");
});

test("T14: the hint is read off an error's captured streams (T13's contract)", () => {
  const err = Object.assign(new Error("hung"), {
    code: "EIDLE",
    stderr: "no output for 180s\ncodex resume 01JFROMSTDERR",
    stdout: ""
  });
  assert.equal(resumeHintForError(err).id, "01JFROMSTDERR");
});

test("T14: Buffer streams are handled, not just strings", () => {
  const err = Object.assign(new Error("x"), { stderr: Buffer.from("agy resume sess_buffered1") });
  assert.equal(resumeHintForError(err).cli, "agy");
});

test("T14 AC4: no hint is produced for a successful run", () => {
  // A review that succeeded while its diff happened to contain resume-shaped
  // text must stay silent.
  const err = Object.assign(new Error("x"), { stderr: "codex resume 01JSHOULDNOTSHOW" });
  assert.equal(resumeHintForError(err, { failed: false }), null);
});

test("T14: a null error yields no hint", () => {
  assert.equal(resumeHintForError(null), null);
  assert.equal(resumeHintForError(undefined), null);
});

test("T14: the scan bound is pinned to its specified value", () => {
  // AC6 asserts against MAX_SCAN_BYTES itself, which is mutation-invariant.
  // The bound is what keeps a hostile multi-megabyte diff from becoming a
  // pathological scan, so pin the literal.
  assert.equal(MAX_SCAN_BYTES, 8 * 1024);
});

test("T14: the minimum id length boundary is 6 characters", () => {
  // Pins {6,128}. At {7,…} a legitimate 6-character session id is silently
  // dropped and the user loses a resumable session for no reason.
  assert.equal(extractResumeHint("codex resume abc123").id, "abc123", "6 chars is a valid id");
  assert.equal(extractResumeHint("codex resume abc12"), null, "5 chars is below the floor");
});

test("T14: a forged hint for another CLI cannot outrank the one that actually ran", () => {
  // The scanned text is attacker-influenceable. Searching every pattern in a
  // fixed order let repository content plant "codex resume <id>" and outrank a
  // genuine agy hint, handing the user a command for a session that never
  // existed.
  const stderr = "codex resume 01JFORGEDBYDIFF\nagy resume sess_realone1";
  assert.equal(extractResumeHint(stderr, { cli: "agy" }).id, "sess_realone1");
  assert.equal(extractResumeHint(stderr, { cli: "agy" }).cli, "agy");
  // A CLI with no hint present yields nothing rather than borrowing another's.
  assert.equal(extractResumeHint("codex resume 01JFORGEDBYDIFF", { cli: "agy" }), null);
});

test("T14: resumeHintForError forwards the CLI scope", () => {
  const err = Object.assign(new Error("x"), {
    stderr: "codex resume 01JFORGEDBYDIFF\nagy resume sess_genuine9"
  });
  assert.equal(resumeHintForError(err, { cli: "agy" }).id, "sess_genuine9");
});
