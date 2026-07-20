import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { cleanJsonResponse, configureLLM, cliFallbackArgs, cliReviewArgs, describeUnknownFlagRejection, parseRetryAfterMs } from "../src/llm.js";
import { loadSchema } from "../src/review.js";

test("cleanJsonResponse extracts plain valid JSON", () => {
  const input = '{"verdict": "approve", "summary": "good"}';
  const expected = '{"verdict": "approve", "summary": "good"}';
  assert.equal(cleanJsonResponse(input), expected);
});

test("cleanJsonResponse extracts JSON from markdown blocks", () => {
  const input = '```json\n{"verdict": "approve"}\n```';
  const expected = '{"verdict": "approve"}';
  assert.equal(cleanJsonResponse(input), expected);
});

test("cleanJsonResponse extracts JSON from markdown blocks with surrounding prose", () => {
  const input = 'Here is the result:\n```json\n{"verdict": "needs-attention"}\n```\nHope this helps!';
  const expected = '{"verdict": "needs-attention"}';
  assert.equal(cleanJsonResponse(input), expected);
});

test("cleanJsonResponse extracts JSON even if prose has curly braces", () => {
  const input = 'The review of the {auth} changes is here:\n```json\n{"verdict": "approve"}\n```';
  const expected = '{"verdict": "approve"}';
  assert.equal(cleanJsonResponse(input), expected);
});

test("cleanJsonResponse handles JSON that contains code blocks as string properties", () => {
  const input = '{\n  "code": "```javascript\\nconsole.log(1);\\n```"\n}';
  const expected = '{\n  "code": "```javascript\\nconsole.log(1);\\n```"\n}';
  assert.equal(cleanJsonResponse(input), expected);
});

test("cleanJsonResponse returns trimmed input if no JSON structures are identified", () => {
  const input = "  plain text response  ";
  const expected = "plain text response";
  assert.equal(cleanJsonResponse(input), expected);
});

test("configureLLM handles custom base, key, and headers", () => {
  const oldEnv = { ...process.env };
  // Clean env to avoid interference
  delete process.env.OPENAI_API_KEY;
  delete process.env.LLM_API_KEY;
  delete process.env.LLM_HEADERS;
  delete process.env.OPENAI_API_BASE;
  delete process.env.OPENAI_BASE_URL;

  try {
    const args = {
      provider: "openai",
      apiBase: "https://my-custom-endpoint/v1",
      apiKey: "secret-cli-key",
      headers: '{"x-custom-h":"some-value"}',
      model: "gpt-4o-custom"
    };

    const config = configureLLM(args);

    assert.equal(config.provider, "openai");
    assert.equal(config.model, "gpt-4o-custom");
    assert.equal(config.apiKey, "secret-cli-key");
    assert.equal(config.apiBase, "https://my-custom-endpoint/v1");
    assert.deepEqual(config.customHeaders, { "x-custom-h": "some-value" });
  } finally {
    process.env = oldEnv;
  }
});

test("configureLLM maps cursor provider to the Cursor Agent CLI (not a localhost proxy)", () => {
  const oldEnv = { ...process.env };
  delete process.env.OPENAI_API_KEY;
  delete process.env.AI_GATEWAY_API_KEY;
  delete process.env.VERCEL_OIDC_TOKEN;
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "adv-cursor-"));
  const binName = process.platform === "win32" ? "agent.cmd" : "agent";
  const binPath = path.join(tempDir, binName);
  fs.writeFileSync(binPath, "#!/bin/sh\necho mock");
  if (process.platform !== "win32") fs.chmodSync(binPath, 0o755);
  process.env.PATH = tempDir;
  try {
    const config = configureLLM({ provider: "cursor" });
    assert.equal(config.provider, "cli");
    assert.equal(config.cliCmd, "agent");
    assert.notEqual(config.apiBase, "http://127.0.0.1:8765/v1");
  } finally {
    process.env = oldEnv;
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
  }
});

test("configureLLM resolves environment variables for custom base", () => {
  const oldEnv = { ...process.env };
  process.env.OPENAI_API_BASE = "https://env-endpoint/v1";
  process.env.OPENAI_API_KEY = "env-key";
  process.env.LLM_HEADERS = '{"env-h":"val"}';

  try {
    const args = {
      provider: "openai"
    };

    const config = configureLLM(args);

    assert.equal(config.provider, "openai");
    assert.equal(config.apiKey, "env-key");
    assert.equal(config.apiBase, "https://env-endpoint/v1");
    assert.deepEqual(config.customHeaders, { "env-h": "val" });
  } finally {
    process.env = oldEnv;
  }
});

test("configureLLM auto-detects Cursor context when no provider/key specified", () => {
  const oldEnv = { ...process.env };
  delete process.env.OPENAI_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.GEMINI_API_KEY;
  delete process.env.AI_GATEWAY_API_KEY;
  delete process.env.VERCEL_OIDC_TOKEN;
  // Running this suite inside Claude Code sets CLAUDECODE; clear it so the
  // Cursor detection branch is actually exercised.
  delete process.env.CLAUDECODE;
  delete process.env.CLAUDE_CODE;
  process.env.TERM_PROGRAM = "cursor";
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "adv-cursor-auto-"));
  const binName = process.platform === "win32" ? "agent.cmd" : "agent";
  const binPath = path.join(tempDir, binName);
  fs.writeFileSync(binPath, "#!/bin/sh\necho mock");
  if (process.platform !== "win32") fs.chmodSync(binPath, 0o755);
  process.env.PATH = tempDir;

  try {
    const config = configureLLM({});
    assert.equal(config.provider, "cli");
    assert.equal(config.cliCmd, "agent");
  } finally {
    process.env = oldEnv;
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
  }
});

test("configureLLM auto-detects Claude Code context when no provider/key specified", () => {
  const oldEnv = { ...process.env };
  delete process.env.OPENAI_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.GEMINI_API_KEY;
  delete process.env.AI_GATEWAY_API_KEY;
  delete process.env.VERCEL_OIDC_TOKEN;

  process.env.CLAUDE_CODE = "1";
  
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "adversarial-test-"));
  const binName = process.platform === "win32" ? "claude.cmd" : "claude";
  const binPath = path.join(tempDir, binName);
  
  fs.writeFileSync(binPath, "#!/bin/sh\necho mock");
  if (process.platform !== "win32") {
    fs.chmodSync(binPath, 0o755);
  }
  
  process.env.PATH = tempDir; // Isolate PATH so only mock claude is available

  try {
    const config = configureLLM({});
    assert.equal(config.provider, "cli");
    assert.equal(config.cliCmd, "claude");
  } finally {
    process.env = oldEnv;
    try {
      fs.unlinkSync(binPath);
      fs.rmdirSync(tempDir);
    } catch {}
  }
});

test("configureLLM prioritizes non-Anthropic critic in Claude Code if key is present", () => {
  const oldEnv = { ...process.env };
  delete process.env.OPENAI_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  process.env.CLAUDE_CODE = "1";
  process.env.GEMINI_API_KEY = "mock-gemini-key";

  try {
    const config = configureLLM({});
    assert.equal(config.provider, "gemini");
    assert.equal(config.model, "gemini-2.5-pro");
    assert.equal(config.apiKey, "mock-gemini-key");
  } finally {
    process.env = oldEnv;
  }
});

test("configureLLM auto-detects agy CLI when only agy is installed and no API keys", () => {
  const oldEnv = { ...process.env };
  delete process.env.OPENAI_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.GEMINI_API_KEY;
  delete process.env.AI_GATEWAY_API_KEY;
  delete process.env.VERCEL_OIDC_TOKEN;
  // Builder is Claude; the critic should be the agy (Gemini-family) CLI.
  process.env.CLAUDE_CODE = "1";

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "adversarial-agy-"));
  const binName = process.platform === "win32" ? "agy.cmd" : "agy";
  const binPath = path.join(tempDir, binName);
  fs.writeFileSync(binPath, "#!/bin/sh\necho mock");
  if (process.platform !== "win32") {
    fs.chmodSync(binPath, 0o755);
  }
  process.env.PATH = tempDir; // Isolate PATH so only the mock agy is available

  try {
    const config = configureLLM({});
    assert.equal(config.provider, "cli");
    assert.equal(config.cliCmd, "agy");
  } finally {
    process.env = oldEnv;
    try {
      fs.unlinkSync(binPath);
      fs.rmdirSync(tempDir);
    } catch {}
  }
});

test("cliReviewArgs / cliFallbackArgs use per-CLI plan flags for claude and agy", () => {
  // agy uses --mode plan (not Claude's --permission-mode)
  assert.deepEqual(cliReviewArgs("agy"), ["--mode", "plan", "-p", "-"]);
  assert.deepEqual(cliReviewArgs("claude"), ["--permission-mode", "plan", "-p", "-"]);
  assert.deepEqual(cliReviewArgs("agy", { allowUnsandboxedCli: true }), ["-p", "-"]);
  assert.deepEqual(cliFallbackArgs("agy", "PROMPT-BODY"), ["--mode", "plan", "-p", "PROMPT-BODY"]);
  assert.deepEqual(cliFallbackArgs("claude", "PROMPT-BODY"), ["--permission-mode", "plan", "-p", "PROMPT-BODY"]);
  assert.deepEqual(
    cliFallbackArgs("claude", "PROMPT-BODY", { allowUnsandboxedCli: true }),
    ["-p", "PROMPT-BODY"]
  );
  assert.deepEqual(
    cliFallbackArgs("agy", "PROMPT-BODY", { allowUnsandboxedCli: true }),
    ["-p", "PROMPT-BODY"]
  );
  assert.deepEqual(cliFallbackArgs("somecli", "PROMPT-BODY"), ["PROMPT-BODY"]);
});

test("describeUnknownFlagRejection parses Go flag and common unknown-flag stderr", () => {
  assert.equal(
    describeUnknownFlagRejection("agy", "flags provided but not defined: -permission-mode\nUsage of agy:\n"),
    'provider "agy" rejected flag "--permission-mode"'
  );
  assert.equal(
    describeUnknownFlagRejection("claude", "error: unknown flag: --mode\n"),
    'provider "claude" rejected flag "--mode"'
  );
  assert.equal(describeUnknownFlagRejection("agy", "some unrelated failure"), null);
});

test("cliReviewArgs for agent uses --mode plan + -p + --trust (not Claude --permission-mode)", () => {
  assert.deepEqual(
    cliReviewArgs("agent"),
    ["-p", "--trust", "--output-format", "text", "--mode", "plan", "-"]
  );
  assert.deepEqual(
    cliReviewArgs("agent", { allowUnsandboxedCli: true }),
    ["-p", "--trust", "--output-format", "text", "-"]
  );
  assert.deepEqual(
    cliReviewArgs("agent", { model: "sonnet-4" }),
    ["-p", "--trust", "--output-format", "text", "--mode", "plan", "--model", "sonnet-4", "-"]
  );
  assert.deepEqual(
    cliFallbackArgs("cursor-agent", "PROMPT-BODY"),
    ["-p", "--trust", "--output-format", "text", "--mode", "plan", "PROMPT-BODY"]
  );
});

test("src/ has no hardcoded Cursor proxy port 8765", () => {
  const llmSrc = fs.readFileSync(new URL("../src/llm.js", import.meta.url), "utf8");
  assert.ok(!llmSrc.includes("8765"), "dead localhost proxy default must be removed");
});

test("configureLLM vercel / gateway defaults (AI Gateway)", () => {
  const oldEnv = { ...process.env };
  delete process.env.OPENAI_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.GEMINI_API_KEY;
  delete process.env.LLM_API_KEY;
  delete process.env.AI_GATEWAY_API_BASE;
  delete process.env.AI_GATEWAY_BASE_URL;
  process.env.AI_GATEWAY_API_KEY = "test";
  try {
    const vercel = configureLLM({ provider: "vercel" });
    assert.equal(vercel.provider, "vercel");
    assert.equal(vercel.apiBase, "https://ai-gateway.vercel.sh/v1");
    assert.equal(vercel.model, "anthropic/claude-sonnet-4.6");
    assert.equal(vercel.apiKey, "test");

    const alias = configureLLM({ provider: "gateway" });
    assert.equal(alias.provider, "vercel");
    assert.equal(alias.apiBase, vercel.apiBase);
    assert.equal(alias.model, vercel.model);
  } finally {
    process.env = oldEnv;
  }
});

test("configureLLM auto-detects AI_GATEWAY_API_KEY as vercel", () => {
  const oldEnv = { ...process.env };
  delete process.env.OPENAI_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.GEMINI_API_KEY;
  delete process.env.LLM_API_KEY;
  delete process.env.CLAUDECODE;
  delete process.env.CLAUDE_CODE;
  delete process.env.TERM_PROGRAM;
  process.env.AI_GATEWAY_API_KEY = "gw-only";
  process.env.PATH = "";
  try {
    const config = configureLLM({});
    assert.equal(config.provider, "vercel");
    assert.equal(config.apiKey, "gw-only");
  } finally {
    process.env = oldEnv;
  }
});

test("configureLLM openai with only AI_GATEWAY_API_KEY does not silently redirect", () => {
  const oldEnv = { ...process.env };
  delete process.env.OPENAI_API_KEY;
  delete process.env.LLM_API_KEY;
  process.env.AI_GATEWAY_API_KEY = "gw-only";
  try {
    assert.throws(
      () => configureLLM({ provider: "openai" }),
      /API key is not set|vercel/i
    );
  } finally {
    process.env = oldEnv;
  }
});

test("parseRetryAfterMs parses seconds and HTTP-date, capped", () => {
  assert.equal(parseRetryAfterMs("2"), 2000);
  assert.equal(parseRetryAfterMs("120"), 60_000); // capped
  const now = Date.parse("2026-01-01T00:00:00Z");
  assert.equal(parseRetryAfterMs("Thu, 01 Jan 2026 00:00:05 GMT", { now, capMs: 60_000 }), 5000);
  assert.equal(parseRetryAfterMs(""), null);
  assert.equal(parseRetryAfterMs(null), null);
});

test("agy CLI review path invokes -p print mode and delivers the prompt via stdin", async () => {
  const { llmCall } = await import("../src/llm.js");

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-test-"));
  const binName = process.platform === "win32" ? "agy.cmd" : "agy";
  const binPath = path.join(tmpDir, binName);
  const sentinelSystem = "be adversarial sentinel";
  const sentinelPrompt = "review this sentinel";
  const expectedResponse = '{"verdict":"approve","summary":"ok"}';

  // Mock agy binary enforcing the print-mode contract:
  //   1. `-p` (print/non-interactive) must be present — bare agy would hang.
  //   2. `-` must be present as the stdin sentinel.
  //   3. Stdin must carry both the system instruction and the user prompt.
  // Exits non-zero on any violation so the test fails if the contract breaks.
  fs.writeFileSync(
    binPath,
    `#!/bin/sh
has_print=false
read_stdin=false
has_plan=false
has_bad_flag=false
prev=""
for arg in "$@"; do
  if [ "$arg" = "-p" ] || [ "$arg" = "--print" ]; then has_print=true; fi
  if [ "$arg" = "-" ]; then read_stdin=true; fi
  if [ "$arg" = "--permission-mode" ]; then has_bad_flag=true; fi
  if [ "$prev" = "--mode" ] && [ "$arg" = "plan" ]; then has_plan=true; fi
  prev="$arg"
done
if [ "$has_print" = "false" ]; then
  echo "FAIL: -p/--print not passed (would hang interactively)" >&2; exit 1
fi
if [ "$read_stdin" = "false" ]; then
  echo "FAIL: stdin indicator (-) not passed" >&2; exit 1
fi
if [ "$has_plan" = "false" ]; then
  echo "FAIL: --mode plan not passed (review isolation required)" >&2; exit 1
fi
if [ "$has_bad_flag" = "true" ]; then
  echo "FAIL: --permission-mode must not be passed to agy" >&2; exit 1
fi
stdin_content=$(cat)
echo "$stdin_content" | grep -q "${sentinelSystem}" || { echo "FAIL: system instruction missing from stdin" >&2; exit 1; }
echo "$stdin_content" | grep -q "${sentinelPrompt}" || { echo "FAIL: prompt content missing from stdin" >&2; exit 1; }
printf '%s' '${expectedResponse}'
`
  );
  fs.chmodSync(binPath, 0o755);

  const oldPath = process.env.PATH;
  process.env.PATH = `${tmpDir}:${oldPath}`;

  try {
    const config = { provider: "cli", cliCmd: "agy", timeoutMs: 10000 };
    const result = await llmCall(config, sentinelPrompt, sentinelSystem);
    assert.equal(result, expectedResponse, "should return agy's stdout from print mode");
  } finally {
    process.env.PATH = oldPath;
    try { fs.unlinkSync(binPath); } catch {}
    try { fs.rmdirSync(tmpDir); } catch {}
  }
});

test("codex CLI path uses exec --output-last-message and delivers full prompt via stdin", async () => {
  const { llmCall } = await import("../src/llm.js");

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-test-"));
  const binPath = path.join(tmpDir, "codex");
  const sentinelSystem = "be adversarial sentinel";
  const sentinelPrompt = "review this sentinel";
  const expectedResponse = '{"verdict":"approve","summary":"ok"}';

  // Mock codex binary that enforces the full invocation contract:
  //   1. --output-last-message <file> must be present (reliable output capture)
  //   2. Isolation flags --sandbox read-only, --ignore-rules, --ephemeral must be present
  //   3. `-` must appear as the positional prompt (stdin mode, not argv mode)
  //   4. Stdin must contain both the system instruction and the user prompt
  // The mock exits non-zero on any violation so the test fails if the contract breaks.
  fs.writeFileSync(
    binPath,
    `#!/bin/sh
output_file=""
read_stdin=false
has_sandbox=false
has_ignore_rules=false
has_ephemeral=false
prev=""
for arg in "$@"; do
  if [ "$prev" = "--output-last-message" ]; then
    output_file="$arg"
  fi
  if [ "$prev" = "--sandbox" ] && [ "$arg" = "read-only" ]; then
    has_sandbox=true
  fi
  if [ "$arg" = "--ignore-rules" ]; then
    has_ignore_rules=true
  fi
  if [ "$arg" = "--ephemeral" ]; then
    has_ephemeral=true
  fi
  if [ "$arg" = "-" ]; then
    read_stdin=true
  fi
  prev="$arg"
done
if [ -z "$output_file" ]; then
  echo "FAIL: --output-last-message not passed" >&2; exit 1
fi
if [ "$has_sandbox" = "false" ]; then
  echo "FAIL: --sandbox read-only not passed" >&2; exit 1
fi
if [ "$has_ignore_rules" = "false" ]; then
  echo "FAIL: --ignore-rules not passed" >&2; exit 1
fi
if [ "$has_ephemeral" = "false" ]; then
  echo "FAIL: --ephemeral not passed" >&2; exit 1
fi
if [ "$read_stdin" = "false" ]; then
  echo "FAIL: stdin indicator (-) not passed as positional" >&2; exit 1
fi
stdin_content=$(cat)
echo "$stdin_content" | grep -q "${sentinelSystem}" || { echo "FAIL: system instruction missing from stdin" >&2; exit 1; }
echo "$stdin_content" | grep -q "${sentinelPrompt}" || { echo "FAIL: prompt content missing from stdin" >&2; exit 1; }
printf '%s' '${expectedResponse}' > "$output_file"
`
  );
  fs.chmodSync(binPath, 0o755);

  const oldPath = process.env.PATH;
  process.env.PATH = `${tmpDir}:${oldPath}`;

  try {
    const config = { provider: "cli", cliCmd: "codex", timeoutMs: 10000 };
    const result = await llmCall(config, sentinelPrompt, sentinelSystem);
    assert.equal(result, expectedResponse, "should return the content written to --output-last-message");
  } finally {
    process.env.PATH = oldPath;
    try { fs.unlinkSync(binPath); } catch {}
    try { fs.rmdirSync(tmpDir); } catch {}
  }
});

test("codex CLI path sanitizes the schema written to --output-schema (matches the OpenAI call site's options: no optional property outside required, no constraint keywords)", async () => {
  const { llmCall } = await import("../src/llm.js");

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-schema-test-"));
  const binPath = path.join(tmpDir, "codex");
  const sentinelSystem = "be adversarial sentinel";
  const sentinelPrompt = "review this sentinel";
  const expectedResponse = '{"verdict":"approve","summary":"sanitized ok"}';

  // Mock codex binary written in Node (not sh) because the check requires real
  // JSON structural comparison: every key in properties.findings.items.properties
  // must also appear in properties.findings.items.required. A shell/grep
  // string-match substitute would be a hollow check that stays green even if the
  // sanitize call regresses (P1 parallax resolution R1 for ticket T4).
  //
  // Also asserts constraint keywords (minLength/minimum/maximum) are stripped,
  // not just that corroborated_by is gone: corroborated_by is unconditionally
  // dropped by ALWAYS_DROP regardless of the `keepConstraints` option, so a
  // wrong-but-plausible fix that reaches for the Anthropic call site's
  // `{ keepConstraints: true }` (instead of the OpenAI-mirroring default) would
  // still pass a properties/required-only check. This closes that blind spot
  // (found during P5 prosecution of ticket T4).
  fs.writeFileSync(
    binPath,
    `#!/usr/bin/env node
const fs = require("fs");
const args = process.argv.slice(2);
let outputFile = null;
let schemaFile = null;
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--output-last-message") outputFile = args[i + 1];
  if (args[i] === "--output-schema") schemaFile = args[i + 1];
}
process.stdin.resume();
process.stdin.on("end", () => {
  if (!schemaFile) {
    console.error("FAIL: --output-schema not passed");
    process.exit(1);
  }
  const written = JSON.parse(fs.readFileSync(schemaFile, "utf8"));
  const findingProps = written.properties.findings.items.properties;
  const findingRequired = written.properties.findings.items.required || [];
  const missing = Object.keys(findingProps).filter((k) => !findingRequired.includes(k));
  if (missing.length) {
    console.error("FAIL: schema written to disk has properties not in required: " + missing.join(", "));
    process.exit(1);
  }
  const constrained = Object.entries(findingProps).filter(
    ([, v]) => "minLength" in v || "minimum" in v || "maximum" in v
  );
  if (constrained.length) {
    console.error(
      "FAIL: schema written to disk still has constraint keywords (expected the OpenAI-mirroring " +
        "default sanitize options, not keepConstraints:true): " + constrained.map(([k]) => k).join(", ")
    );
    process.exit(1);
  }
  fs.writeFileSync(outputFile, '${expectedResponse}');
});
`
  );
  fs.chmodSync(binPath, 0o755);

  const oldPath = process.env.PATH;
  process.env.PATH = `${tmpDir}:${oldPath}`;

  try {
    const config = { provider: "cli", cliCmd: "codex", timeoutMs: 10000 };
    // Real repo schema.json: findings.items has corroborated_by in properties
    // but not in required (merge-time-only annotation). This is the actual
    // shape that triggered the OpenAI strict json_schema 400 via codex.
    const schema = loadSchema();
    const result = await llmCall(config, sentinelPrompt, sentinelSystem, schema);
    assert.equal(result, expectedResponse, "should return the content written to --output-last-message");
  } finally {
    process.env.PATH = oldPath;
    try { fs.unlinkSync(binPath); } catch {}
    try { fs.rmdirSync(tmpDir); } catch {}
  }
});



test("claude CLI review path uses -p, stdin sentinel, and plan mode (same contract as agy)", async () => {
  const { llmCall } = await import("../src/llm.js");

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-test-"));
  const binName = process.platform === "win32" ? "claude.cmd" : "claude";
  const binPath = path.join(tmpDir, binName);
  const expectedResponse = '{"verdict":"approve","summary":"ok"}';

  fs.writeFileSync(
    binPath,
    `#!/bin/sh
has_print=false
read_stdin=false
has_plan=false
prev=""
for arg in "$@"; do
  if [ "$arg" = "-p" ] || [ "$arg" = "--print" ]; then has_print=true; fi
  if [ "$arg" = "-" ]; then read_stdin=true; fi
  if [ "$prev" = "--permission-mode" ] && [ "$arg" = "plan" ]; then has_plan=true; fi
  prev="$arg"
done
if [ "$has_print" = "false" ]; then echo "FAIL: -p missing" >&2; exit 1; fi
if [ "$read_stdin" = "false" ]; then echo "FAIL: - missing" >&2; exit 1; fi
if [ "$has_plan" = "false" ]; then echo "FAIL: plan mode missing" >&2; exit 1; fi
cat >/dev/null
printf '%s' '${expectedResponse}'
`
  );
  fs.chmodSync(binPath, 0o755);

  const oldPath = process.env.PATH;
  process.env.PATH = `${tmpDir}:${oldPath}`;
  try {
    const result = await llmCall(
      { provider: "cli", cliCmd: "claude", timeoutMs: 10000 },
      "review me",
      "system"
    );
    assert.equal(result, expectedResponse);
  } finally {
    process.env.PATH = oldPath;
    try { fs.unlinkSync(binPath); } catch {}
    try { fs.rmdirSync(tmpDir); } catch {}
  }
});

test("allowUnsandboxedCli omits plan-mode sandbox flags for claude/agy review", async () => {
  const { llmCall } = await import("../src/llm.js");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-unsandbox-"));
  const binPath = path.join(tmpDir, "claude");
  fs.writeFileSync(
    binPath,
    `#!/bin/sh
for arg in "$@"; do
  if [ "$arg" = "plan" ]; then echo "FAIL: plan mode present" >&2; exit 1; fi
done
cat >/dev/null
printf '%s' '{"ok":true}'
`
  );
  fs.chmodSync(binPath, 0o755);
  const oldPath = process.env.PATH;
  process.env.PATH = `${tmpDir}:${oldPath}`;
  try {
    const result = await llmCall(
      { provider: "cli", cliCmd: "claude", timeoutMs: 10000, allowUnsandboxedCli: true },
      "p",
      "s"
    );
    assert.equal(result, '{"ok":true}');
  } finally {
    process.env.PATH = oldPath;
    try { fs.unlinkSync(binPath); } catch {}
    try { fs.rmdirSync(tmpDir); } catch {}
  }
});

test("unknown-flag CLI rejection is reported as rejected flag, not prompt-size error", async () => {
  const { llmCall } = await import("../src/llm.js");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-badflag-"));
  const binPath = path.join(tmpDir, "agy");
  // Mimic agy 1.1.2 Go flag rejection for an unrecognized flag.
  fs.writeFileSync(
    binPath,
    `#!/bin/sh
echo "flags provided but not defined: -permission-mode" >&2
echo "Usage of agy:" >&2
exit 2
`
  );
  fs.chmodSync(binPath, 0o755);
  const oldPath = process.env.PATH;
  process.env.PATH = `${tmpDir}:${oldPath}`;
  // Prompt larger than MAX_ARGV_PROMPT_BYTES (100 KiB) — previously this path
  // masked the flag rejection as a "prompt is too large" error.
  const hugePrompt = "x".repeat(110 * 1024);
  try {
    await assert.rejects(
      () => llmCall({ provider: "cli", cliCmd: "agy", timeoutMs: 10000 }, hugePrompt, "sys"),
      (err) => {
        assert.match(err.message, /provider "agy" rejected flag "--permission-mode"/);
        assert.doesNotMatch(err.message, /prompt is too large/);
        return true;
      }
    );
  } finally {
    process.env.PATH = oldPath;
    try { fs.unlinkSync(binPath); } catch {}
    try { fs.rmdirSync(tmpDir); } catch {}
  }
});

test("CLI provider honors config.timeoutMs (fails faster than the 10m hardcode)", async () => {
  const { llmCall } = await import("../src/llm.js");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cli-timeout-"));
  const binPath = path.join(tmpDir, "slowcli");
  fs.writeFileSync(binPath, "#!/bin/sh\nsleep 5\necho ok\n");
  fs.chmodSync(binPath, 0o755);
  const oldPath = process.env.PATH;
  process.env.PATH = `${tmpDir}:${oldPath}`;
  const started = Date.now();
  try {
    await assert.rejects(
      () => llmCall({ provider: "cli", cliCmd: "slowcli", timeoutMs: 500 }, "p", "s"),
      /Failed to execute local CLI agent|ETIMEDOUT|timed out|spawnSync/i
    );
    assert.ok(Date.now() - started < 4000, "should time out well under 4s");
  } finally {
    process.env.PATH = oldPath;
    try { fs.unlinkSync(binPath); } catch {}
    try { fs.rmdirSync(tmpDir); } catch {}
  }
});
