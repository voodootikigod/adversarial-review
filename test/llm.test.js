import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { cleanJsonResponse, configureLLM } from "../src/llm.js";

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

test("configureLLM maps cursor provider correctly", () => {
  const oldEnv = { ...process.env };
  delete process.env.OPENAI_API_KEY;
  try {
    const args = {
      provider: "cursor"
    };

    const config = configureLLM(args);

    assert.equal(config.provider, "cursor");
    assert.equal(config.model, "gpt-4o");
    assert.equal(config.apiKey, "dummy");
    assert.equal(config.apiBase, "http://127.0.0.1:8765/v1");
  } finally {
    process.env = oldEnv;
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
  // Running this suite inside Claude Code sets CLAUDECODE; clear it so the
  // Cursor detection branch is actually exercised.
  delete process.env.CLAUDECODE;
  delete process.env.CLAUDE_CODE;
  process.env.TERM_PROGRAM = "cursor";
  process.env.PATH = ""; // Isolate PATH so no local CLI commands match

  try {
    const config = configureLLM({});
    assert.equal(config.provider, "cursor");
    assert.equal(config.model, "gpt-4o");
    assert.equal(config.apiBase, "http://127.0.0.1:8765/v1");
  } finally {
    process.env = oldEnv;
  }
});

test("configureLLM auto-detects Claude Code context when no provider/key specified", () => {
  const oldEnv = { ...process.env };
  delete process.env.OPENAI_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.GEMINI_API_KEY;
  
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

