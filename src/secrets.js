// Lightweight secret-pattern scan over the outbound review payload.
// The diff and untracked-file contents are sent verbatim to a third-party
// model provider; this catches the common credential shapes before they
// leave the machine. Heuristic, not exhaustive — a clean scan is not proof
// of absence.

const SECRET_PATTERNS = [
  { name: "AWS access key ID", regex: /\bAKIA[0-9A-Z]{16}\b/g },
  { name: "Private key (PEM)", regex: /-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----/g },
  { name: "OpenAI/Anthropic-style key", regex: /\bsk-[A-Za-z0-9_-]{20,}\b/g },
  { name: "GitHub token", regex: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/g },
  { name: "Slack token", regex: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g },
  { name: "Google API key", regex: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { name: "JWT", regex: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g },
  {
    name: "Hardcoded credential assignment",
    regex: /\b(?:api[_-]?key|secret|passwd|password|auth[_-]?token|access[_-]?token)\b["']?\s*[:=]\s*["'][^"'\s]{12,}["']/gi
  }
];

function redact(match) {
  const head = match.slice(0, 6);
  return `${head}…(${match.length} chars)`;
}

/**
 * Replace every likely secret in `text` with its redacted form, in place.
 *
 * Deliberately surgical rather than dropping the whole field. Finding a hardcoded
 * credential is one of the things this reviewer exists to do, so a finding that
 * reads "STRIPE_SECRET is a live key" must survive — with the key itself masked.
 * Blanking the field would suppress the tool's most valuable output exactly when
 * it is most valuable.
 *
 * Returns { text, hits }; `hits` is empty when nothing matched.
 */
export function redactSecrets(text) {
  if (typeof text !== "string" || !text) return { text, hits: [] };
  let out = text;
  const hits = [];
  for (const { name, regex } of SECRET_PATTERNS) {
    regex.lastIndex = 0;
    let matched = false;
    out = out.replace(regex, (m) => {
      matched = true;
      return redact(m);
    });
    if (matched) hits.push({ pattern: name });
  }
  return { text: out, hits };
}

/**
 * Redact secrets across every free-text field of a review result.
 *
 * The pre-flight scan covers the OUTBOUND payload only. A reviewer with file-read
 * tools (opencode, claude, codex, the Cursor agent) can open a gitignored .env that
 * was never in the diff and quote it into a finding — which then lands in a terminal
 * or a CI log, and in the findings ledger, entirely unscanned. This is the boundary
 * where that content actually escapes, so it is where the scan belongs.
 */
export function redactSecretsInResult(result) {
  if (!result || typeof result !== "object") return { result, hits: [] };
  const hits = [];
  const scrub = (v) => {
    if (typeof v !== "string") return v;
    const r = redactSecrets(v);
    if (r.hits.length) hits.push(...r.hits);
    return r.text;
  };

  const findings = Array.isArray(result.findings)
    ? result.findings.map((f) => {
        const out = { ...f };
        for (const field of ["title", "body", "evidence", "recommendation", "exploit_scenario"]) {
          if (typeof out[field] === "string") out[field] = scrub(out[field]);
        }
        return out;
      })
    : result.findings;

  const next = Array.isArray(result.next_steps) ? result.next_steps.map(scrub) : result.next_steps;

  return {
    result: { ...result, summary: scrub(result.summary), findings, next_steps: next },
    // Dedupe by pattern name: one warning per credential shape is enough.
    hits: [...new Map(hits.map((h) => [h.pattern, h])).values()]
  };
}

// Scan text for likely secrets. Returns [{ pattern, sample }] with redacted samples.
export function scanForSecrets(text) {
  const hits = [];
  for (const { name, regex } of SECRET_PATTERNS) {
    regex.lastIndex = 0;
    const seen = new Set();
    let m;
    while ((m = regex.exec(text)) !== null) {
      const sample = redact(m[0]);
      if (!seen.has(sample)) {
        seen.add(sample);
        hits.push({ pattern: name, sample });
      }
      // Guard against zero-length-match loops.
      if (m.index === regex.lastIndex) regex.lastIndex++;
    }
  }
  return hits;
}
