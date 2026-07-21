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
