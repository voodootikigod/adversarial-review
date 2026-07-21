// Best-effort extraction of a resumable session id from a failed CLI run.
//
// Upstream (Robbyfuu/codex-plugin-cc, commit acf6437) reads this from a tracked
// job record carrying a threadId — structured state, gated on job status. We
// have no job store, so scraping stderr is the only mechanism available to us.
// It is strictly weaker than theirs and is treated as such:
//
//   - BEST EFFORT ONLY. A missing or unparseable hint never fails the run,
//     never changes an exit code, and never emits anything alarming.
//   - Failure states only. A successful review must never print a resume hint.
//   - Anchored PER CLI rather than one loose global pattern, so an unrelated
//     string inside a reviewed diff cannot be mistaken for a session id.
//   - Bounded scan and a validated id shape, because the text being scanned is
//     attacker-influenceable: it may contain the reviewed diff.

// Only the tail is scanned. A CLI that dumps megabytes of output should not
// turn into a pathological scan, and the resume line is always near the end.
export const MAX_SCAN_BYTES = 8 * 1024;

// Session ids are opaque, but every CLI we support uses a bounded token with no
// whitespace or control characters. Anything else is not an id we will echo.
const ID_SHAPE = /^[A-Za-z0-9._:-]{6,128}$/;

// Per-CLI anchors. Each must match the CLI's own documented resume phrasing —
// deliberately not a generic /resume (\S+)/, which a diff could trivially forge.
// The trailing lookahead makes the id end at a boundary. Without it a
// {6,128} quantifier silently TRUNCATES a longer run to its first 128
// characters and accepts the fragment — echoing part of an attacker-supplied
// token back to the terminal instead of rejecting it outright.
const ID_CHARS = "[A-Za-z0-9._:-]";
const ID_CAPTURE = `(${ID_CHARS}{6,128})(?!${ID_CHARS})`;
// NOTE ON CODEX: every codex invocation in this project passes --ephemeral
// (src/llm.js review path, src/loop.js fixer path), which disables session
// persistence — so there is no session to resume and this pattern cannot fire
// in production today. It is retained because dropping --ephemeral is the only
// prerequisite, but no caller should advertise codex resume support until then.
const PATTERNS = [
  { cli: "codex", re: new RegExp(`\\bcodex\\s+resume\\s+${ID_CAPTURE}`, "i") },
  { cli: "agy", re: new RegExp(`\\bagy\\s+resume\\s+${ID_CAPTURE}`, "i") },
  { cli: "claude", re: new RegExp(`\\bclaude\\s+(?:--resume|resume)\\s+${ID_CAPTURE}`, "i") },
  { cli: "agent", re: new RegExp(`\\bagent\\s+resume\\s+${ID_CAPTURE}`, "i") }
];

/**
 * Extract a resume hint from captured CLI output.
 *
 * @returns {{cli: string, id: string, command: string} | null}
 */
export function extractResumeHint(text, { cli: onlyCli = null } = {}) {
  if (typeof text !== "string" || !text) return null;
  const tail = text.length > MAX_SCAN_BYTES ? text.slice(-MAX_SCAN_BYTES) : text;

  // Scope to the CLI that ACTUALLY RAN when the caller knows it. The scanned
  // text is attacker-influenceable, so trying every pattern in a fixed order
  // lets repository content forge a hint for a different CLI — "codex resume
  // <id>" planted in a diff would outrank a genuine agy hint and hand the user
  // a command for a session that never existed.
  const candidates = onlyCli ? PATTERNS.filter((p) => p.cli === onlyCli) : PATTERNS;
  for (const { cli, re } of candidates) {
    const match = tail.match(re);
    if (!match) continue;
    const id = match[1];
    if (!ID_SHAPE.test(id)) continue;
    return { cli, id, command: `${cli} resume ${id}` };
  }
  return null;
}

/**
 * Resume hint for a FAILED run, or null.
 *
 * `failed` is passed explicitly rather than inferred: a successful review whose
 * diff happens to contain resume-shaped text must never produce a hint.
 */
export function resumeHintForError(error, { failed = true, cli = null } = {}) {
  if (!failed || !error) return null;
  // The watchdog attaches stdout/stderr to every rejection precisely so this
  // works (T13 AC15); execFileSync errors carry them too.
  const streams = [error.stderr, error.stdout]
    .map((s) => (Buffer.isBuffer(s) ? s.toString("utf8") : s))
    .filter((s) => typeof s === "string" && s);
  for (const s of streams) {
    const hint = extractResumeHint(s, { cli });
    if (hint) return hint;
  }
  return null;
}
