import assert from "node:assert/strict";
import test from "node:test";
import { scanForSecrets } from "../src/secrets.js";

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
