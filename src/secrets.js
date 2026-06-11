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
