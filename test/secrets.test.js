import assert from "node:assert/strict";
import test from "node:test";
import { scanForSecrets, redactSecrets, redactSecretsInResult } from "../src/secrets.js";

test("scanForSecrets detects common credential shapes", () => {
  const text = [
    "aws_key = AKIAIOSFODNN7EXAMPLE",
    "-----BEGIN RSA PRIVATE KEY-----",
    'const key = "sk-abcdefghijklmnopqrstuvwx"',
    "token: ghp_abcdefghijklmnopqrstuvwxyz0123456789",
    "slack: xoxb-1234567890-abcdef",
    'apiKey = "AIzaSyA-1234567890abcdefghijklmnopqrstu"',
    'password = "supersecretvalue123"'
  ].join("\n");

  const hits = scanForSecrets(text);
  const patterns = hits.map((h) => h.pattern);

  assert.ok(patterns.includes("AWS access key ID"));
  assert.ok(patterns.includes("Private key (PEM)"));
  assert.ok(patterns.includes("OpenAI/Anthropic-style key"));
  assert.ok(patterns.includes("GitHub token"));
  assert.ok(patterns.includes("Slack token"));
  assert.ok(patterns.includes("Google API key"));
  assert.ok(patterns.includes("Hardcoded credential assignment"));
});

test("scanForSecrets redacts matched values in samples", () => {
  const hits = scanForSecrets("AKIAIOSFODNN7EXAMPLE");
  assert.equal(hits.length, 1);
  assert.ok(!hits[0].sample.includes("IOSFODNN7EXAMPLE"));
  assert.ok(hits[0].sample.startsWith("AKIAIO"));
});

test("scanForSecrets stays quiet on ordinary code", () => {
  const text = [
    "function add(a, b) { return a + b; }",
    "const apiKey = process.env.OPENAI_API_KEY;",
    "// rotate keys regularly",
    "password_field_label = t('login.password')"
  ].join("\n");

  assert.deepEqual(scanForSecrets(text), []);
});

// --- output-side redaction ----------------------------------------------------
//
// The pre-flight scan covers the outbound payload only. A reviewer with file-read
// tools can open a gitignored .env that was never in the diff and quote it into a
// finding, which then reaches a terminal, a CI log, and the findings ledger with
// nothing having scanned it.

test("redactSecrets masks the credential but keeps the surrounding text", () => {
  const { text, hits } = redactSecrets('The literal assigned to STRIPE is sk-abcdefghijklmnopqrstuvwxyz123 and it is live.');
  assert.doesNotMatch(text, /sk-abcdefghijklmnopqrstuvwxyz123/, "the credential must not survive");
  assert.match(text, /The literal assigned to STRIPE is/, "the finding must remain readable");
  assert.match(text, /and it is live\./);
  assert.equal(hits.length, 1);
});

test("redactSecretsInResult scrubs every free-text field a finding can carry", () => {
  const key = "AKIAIOSFODNN7EXAMPLE";
  const result = {
    verdict: "needs-attention",
    summary: `Found ${key} in the env helper`,
    findings: [{
      title: `Hardcoded ${key}`,
      body: `The value ${key} is live.`,
      evidence: `AWS_KEY = "${key}"`,
      recommendation: `Rotate ${key} immediately.`,
      exploit_scenario: `Anyone cloning gets ${key}.`,
      severity: "critical"
    }],
    next_steps: [`Rotate ${key}.`]
  };

  const { result: clean, hits } = redactSecretsInResult(result);
  const serialized = JSON.stringify(clean);
  assert.doesNotMatch(serialized, new RegExp(key), `the credential leaked: ${serialized}`);
  assert.ok(hits.length >= 1);

  // Structure and non-secret content survive — a redacted review is still a review.
  assert.equal(clean.verdict, "needs-attention");
  assert.equal(clean.findings[0].severity, "critical");
  assert.match(clean.findings[0].recommendation, /Rotate/);
  assert.match(clean.findings[0].body, /is live/);
  assert.equal(clean.next_steps.length, 1);
});

test("redactSecretsInResult preserves a finding that is ABOUT a hardcoded secret", () => {
  // The reviewer's most valuable output is "you committed a live key". Blanking the
  // field on a secret hit would suppress exactly that, so redaction is surgical.
  const { result: clean } = redactSecretsInResult({
    summary: "ok",
    findings: [{ title: "Hardcoded API key in environment helper", body: 'STRIPE_SECRET = "sk-livekey1234567890abcdef" is committed.' }],
    next_steps: []
  });
  assert.match(clean.findings[0].title, /Hardcoded API key in environment helper/);
  assert.match(clean.findings[0].body, /STRIPE_SECRET/, "the finding must still name what leaked");
  assert.match(clean.findings[0].body, /is committed\./);
  assert.doesNotMatch(clean.findings[0].body, /sk-livekey1234567890abcdef/);
});

test("redactSecretsInResult is a no-op on clean output", () => {
  const result = { verdict: "approve", summary: "no issues", findings: [], next_steps: [] };
  const { result: clean, hits } = redactSecretsInResult(result);
  assert.deepEqual(hits, []);
  assert.deepEqual(clean, result);
});
