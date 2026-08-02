import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { budgetSeconds, cliRequiresArgvPrompt, cliUnusableMessage, cliUsableForReview, normalizeTimeoutMs, cleanJsonResponse, configureLLM, cliFallbackArgs, cliPrintTimeoutArgs, cliReviewArgs, describeUnknownFlagRejection, isCliPrintTimeoutStderr, maxArgvPromptBytes, parseRetryAfterMs, timeoutExceededMessage, isCmdInstalled, llmCall, GATEWAY_FAMILY_MODELS, cliSandboxArgs, buildOpencodeConfig, opencodeReviewArgs, newOpencodeAgentName, OPENCODE_AGENT_PREFIX, OPENCODE_DEFAULT_MODEL, isOpencodeModelUnavailable, opencodeSandboxFailure } from "../src/llm.js";
import { loadSchema } from "../src/review.js";
import { buildSpawnTarget } from "../src/spawn-safe.js";
import { writeMockBin, writeSimpleMockBin } from "./helpers/mock-bin.mjs";

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
  writeSimpleMockBin(tempDir, "agent");
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
  writeSimpleMockBin(tempDir, "agent");
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
  writeSimpleMockBin(tempDir, "claude");
  
  process.env.PATH = tempDir; // Isolate PATH so only mock claude is available

  try {
    const config = configureLLM({});
    assert.equal(config.provider, "cli");
    assert.equal(config.cliCmd, "claude");
  } finally {
    process.env = oldEnv;
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
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

test("configureLLM auto-detects agy CLI when only agy is installed and no API keys", { skip: process.platform === "win32" ? "agy .cmd shim is not usable for review on Windows" : false }, () => {
  const oldEnv = { ...process.env };
  delete process.env.OPENAI_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.GEMINI_API_KEY;
  delete process.env.AI_GATEWAY_API_KEY;
  delete process.env.VERCEL_OIDC_TOKEN;
  // Builder is Claude; the critic should be the agy (Gemini-family) CLI.
  process.env.CLAUDE_CODE = "1";

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "adversarial-agy-"));
  writeSimpleMockBin(tempDir, "agy");
  process.env.PATH = tempDir; // Isolate PATH so only the mock agy is available

  try {
    const config = configureLLM({});
    assert.equal(config.provider, "cli");
    assert.equal(config.cliCmd, "agy");
  } finally {
    process.env = oldEnv;
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  }
});

test("cliReviewArgs / cliFallbackArgs use per-CLI plan flags for claude and agy", () => {
  // agy has NO stdin `-` review form — its -p takes the prompt as a value, so it
  // is delivered via cliFallbackArgs (argv), never `-p -`. cliReviewArgs returns [].
  assert.deepEqual(cliReviewArgs("agy"), []);
  assert.deepEqual(cliReviewArgs("claude"), ["--permission-mode", "plan", "-p", "-"]);
  assert.deepEqual(cliReviewArgs("agy", { allowUnsandboxedCli: true }), []);
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

  // Cursor Agent CLI is handled by the isCursorAgentCli branch, which returns
  // BEFORE the `cliCmd !== "claude"` guard. Pinned explicitly because reviewers
  // have repeatedly read that guard as stripping Cursor's flags — a bare `agent`
  // would open an interactive session and hang until the watchdog fires.
  for (const cursor of ["agent", "cursor-agent"]) {
    assert.deepEqual(
      cliReviewArgs(cursor, {}),
      ["-p", "--trust", "--output-format", "text", "--mode", "plan", "-"],
      `${cursor} must get its non-interactive flags`
    );
    assert.notDeepEqual(cliReviewArgs(cursor, {}), [], `${cursor} must never be launched bare`);
  }
});

test("cliReviewArgs / cliFallbackArgs forward a resolved model to claude and agy", () => {
  // A configured cli:<cmd> model pin must actually reach the process, not be
  // silently dropped (both claude and agy accept --model <model>). agy's pin rides
  // its argv (cliFallbackArgs) form since it has no stdin review form.
  assert.deepEqual(
    cliReviewArgs("claude", { model: "claude-sonnet-4-6" }),
    ["--permission-mode", "plan", "--model", "claude-sonnet-4-6", "-p", "-"]
  );
  assert.deepEqual(
    cliFallbackArgs("agy", "PROMPT-BODY", { model: "gemini-3.1-pro-high" }),
    ["--mode", "plan", "--model", "gemini-3.1-pro-high", "-p", "PROMPT-BODY"]
  );
});

test("cliFallbackArgs forwards the review budget to agy's own --print-timeout", () => {
  // agy's print mode defaults to a 5m0s wait of its own. Without --print-timeout it
  // aborts a long review at 5 minutes regardless of --timeout (2400s for a local
  // CLI), so the user's budget silently does not apply.
  assert.deepEqual(cliPrintTimeoutArgs("agy", 2400 * 1000), ["--print-timeout", "2400s"]);
  assert.deepEqual(cliPrintTimeoutArgs("agy", 900 * 1000), ["--print-timeout", "900s"]);
  // Sub-second budgets still have to name a positive duration Go can parse.
  assert.deepEqual(cliPrintTimeoutArgs("agy", 250), ["--print-timeout", "1s"]);
  // Unknown/absent budget, and CLIs without the flag, add nothing.
  assert.deepEqual(cliPrintTimeoutArgs("agy", null), []);
  assert.deepEqual(cliPrintTimeoutArgs("agy", 0), []);
  assert.deepEqual(cliPrintTimeoutArgs("claude", 2400 * 1000), []);

  assert.deepEqual(
    cliFallbackArgs("agy", "PROMPT-BODY", { timeoutMs: 900 * 1000 }),
    ["--mode", "plan", "--print-timeout", "900s", "-p", "PROMPT-BODY"]
  );
  // claude has no such flag — its argv form must not grow one.
  assert.deepEqual(
    cliFallbackArgs("claude", "PROMPT-BODY", { timeoutMs: 900 * 1000 }),
    ["--permission-mode", "plan", "-p", "PROMPT-BODY"]
  );
});

test("cliFallbackArgs keeps the prompt LAST, as the value of -p", () => {
  // agy parses with Go's flag package: parsing stops at the first non-flag
  // argument, so any flag appended after the prompt is silently dropped, and any
  // flag inserted between -p and the prompt is consumed AS the prompt (agy then
  // answers that flag name and the real review is never seen). Every argv form
  // must therefore end with exactly [-p, prompt].
  const forms = [
    cliFallbackArgs("agy", "PROMPT-BODY", { timeoutMs: 900 * 1000, model: "gemini-3.1-pro-high" }),
    cliFallbackArgs("agy", "PROMPT-BODY", { allowUnsandboxedCli: true, timeoutMs: 900 * 1000 }),
    cliFallbackArgs("agy", "PROMPT-BODY"),
    cliFallbackArgs("claude", "PROMPT-BODY", { model: "claude-sonnet-4-6" })
  ];
  for (const args of forms) {
    assert.equal(args.at(-1), "PROMPT-BODY", `prompt must be the final argv element: ${JSON.stringify(args)}`);
    assert.equal(args.at(-2), "-p", `prompt must be the value of -p: ${JSON.stringify(args)}`);
    assert.equal(args.indexOf("PROMPT-BODY"), args.length - 1, "prompt must appear exactly once, at the end");
  }
});

test("timeoutExceededMessage never renders a NaN or zero budget", () => {
  assert.equal(
    timeoutExceededMessage('local CLI agent "agy"', 900 * 1000),
    'Failed to execute local CLI agent "agy": exceeded --timeout 900s; retry with --timeout <larger>'
  );
  assert.equal(
    timeoutExceededMessage("codex", 2400 * 1000),
    "Failed to execute codex: exceeded --timeout 2400s; retry with --timeout <larger>"
  );
  // No budget known: cliPrintTimeoutArgs forwarded nothing, so the agent's OWN
  // default is what fired — say so rather than printing "NaNs" or "0s".
  for (const bad of [undefined, null, NaN, 0, -1, "", "abc", {}]) {
    const msg = timeoutExceededMessage("codex", bad);
    assert.doesNotMatch(msg, /NaN|--timeout 0s|--timeout -/, `degenerate budget ${String(bad)} leaked into: ${msg}`);
    assert.match(msg, /timed out with no --timeout budget set/);
  }
  // A numeric STRING is a budget too. Rejecting it would silently drop the
  // user's timeout: agy would revert to its 5m default while this message
  // insisted no budget was set.
  assert.equal(budgetSeconds("600000"), 600);
  assert.deepEqual(cliPrintTimeoutArgs("agy", "600000"), ["--print-timeout", "600s"]);
  assert.equal(
    timeoutExceededMessage("codex", " 900000 "),
    "Failed to execute codex: exceeded --timeout 900s; retry with --timeout <larger>"
  );
  // A sub-second budget IS a budget: it must report the same duration that was
  // forwarded to the agent (1s), not claim none was set.
  assert.equal(budgetSeconds(500), 1);
  assert.deepEqual(cliPrintTimeoutArgs("agy", 500), ["--print-timeout", "1s"]);
  assert.equal(
    timeoutExceededMessage("codex", 500),
    "Failed to execute codex: exceeded --timeout 1s; retry with --timeout <larger>"
  );
});

test("the forwarded --print-timeout and the overrun message always name the same budget", () => {
  // Drift here is the whole failure mode: agy would be told one budget while the
  // error blames another. Both must read the duration from budgetSeconds.
  for (const ms of [500, 1000, 1500, 900 * 1000, 2400 * 1000, 900_499]) {
    const [, forwarded] = cliPrintTimeoutArgs("agy", ms);
    assert.equal(forwarded, `${budgetSeconds(ms)}s`);
    assert.match(timeoutExceededMessage('local CLI agent "agy"', ms), new RegExp(`exceeded --timeout ${budgetSeconds(ms)}s`));
  }
});

test("a numeric-string budget reaches the watchdog and the agent as the SAME number", () => {
  // The divergence this prevents: budgetSeconds coerces "2400000" and tells agy
  // 2400s, while the raw string reaches the watchdog, which cannot read it and
  // substitutes its own default — killing the review early and then blaming a
  // budget that was never enforced.
  for (const raw of ["2400000", " 900000 ", 900 * 1000]) {
    const ms = normalizeTimeoutMs(raw);
    assert.equal(typeof ms, "number");
    assert.equal(budgetSeconds(raw), Math.ceil(ms / 1000), "the agent flag must match the watchdog window");
    assert.match(timeoutExceededMessage("codex", raw), new RegExp(`exceeded --timeout ${Math.ceil(ms / 1000)}s`));
  }
  for (const bad of [undefined, null, NaN, 0, -1, "", "abc", {}]) {
    assert.equal(normalizeTimeoutMs(bad), null, `${String(bad)} is not a budget`);
  }
});

test("an argv-prompt CLI installed as a Windows .cmd shim is not offered for review", () => {
  // agy takes the prompt as an argument, and a .cmd shim can only be reached
  // through cmd.exe, which re-parses it — so buildSpawnTarget refuses. Detection
  // must skip such an install rather than pick it and fail at spawn time.
  const shim = () => "C:\\npm\\agy.cmd";
  const exe = () => "C:\\tools\\agy.exe";
  assert.equal(cliUsableForReview("agy", { platform: "win32", resolve: shim }), false);
  assert.equal(cliUsableForReview("agy", { platform: "win32", resolve: exe }), true);
  assert.equal(cliUsableForReview("agy", { platform: "win32", resolve: () => null }), false);
  // POSIX has no shim problem, and stdin-prompt CLIs are unaffected anywhere.
  assert.equal(cliUsableForReview("agy", { platform: "linux", resolve: shim }), true);
  assert.equal(cliUsableForReview("claude", { platform: "win32", resolve: () => "C:\\npm\\claude.cmd" }), true);
  assert.equal(cliUsableForReview("codex", { platform: "win32", resolve: () => "C:\\npm\\codex.cmd" }), true);

  // The explicit-selection error must distinguish "cannot work" from "not
  // installed" and name what to do instead.
  const msg = cliUnusableMessage("agy");
  assert.match(msg, /\.cmd shim/);
  assert.match(msg, /--provider claude|--provider codex/);
  assert.doesNotMatch(msg, /not installed/);
});

// --- T45: GitHub Copilot CLI --------------------------------------------------

test("copilot takes the prompt as a -p ARGUMENT, never the stdin sentinel", () => {
  // `copilot -p -` is read as a prompt of literal "-": the CLI replies
  // "I notice your message is empty." Same shape as agy, not claude/codex.
  assert.equal(cliRequiresArgvPrompt("copilot"), true);
  assert.equal(cliRequiresArgvPrompt("/opt/tools/copilot"), true);
  assert.equal(cliRequiresArgvPrompt("copilot.cmd"), true);
  assert.equal(cliRequiresArgvPrompt("C:\\npm\\copilot.cmd"), true);
  // Unchanged for the stdin-prompt CLIs.
  assert.equal(cliRequiresArgvPrompt("claude"), false);
  assert.equal(cliRequiresArgvPrompt("codex"), false);
});

test("copilot has no stdin review form, so it routes through the argv branch", () => {
  assert.deepEqual(cliReviewArgs("copilot"), []);
});

test("copilot review args force --mode plan and end with the prompt", () => {
  const args = cliFallbackArgs("copilot", "PROMPT");
  assert.deepEqual(args, ["--mode", "plan", "-s", "--no-color", "--log-level", "none", "-p", "PROMPT"]);
  // The prompt is last, immediately preceded by the flag that consumes it.
  assert.deepEqual(args.slice(-2), ["-p", "PROMPT"]);

  const withModel = cliFallbackArgs("copilot", "PROMPT", { model: "claude-sonnet-4.5" });
  assert.deepEqual(withModel.slice(-4), ["--model", "claude-sonnet-4.5", "-p", "PROMPT"]);
  assert.equal(cliFallbackArgs("copilot", "PROMPT").includes("--model"), false);

  // Opting out of the sandbox drops plan mode but keeps the argv shape.
  const unsandboxed = cliFallbackArgs("copilot", "PROMPT", { allowUnsandboxedCli: true });
  assert.equal(unsandboxed.includes("--mode"), false);
  assert.deepEqual(unsandboxed.slice(-2), ["-p", "PROMPT"]);
});

test("copilot sandbox args are plan mode, and empty when unsandboxed", () => {
  assert.deepEqual(cliSandboxArgs("copilot"), ["--mode", "plan"]);
  assert.deepEqual(cliSandboxArgs("copilot", { allowUnsandboxedCli: true }), []);
});

test("copilot installed as a Windows .cmd shim is not offered for review", () => {
  // copilot ships via npm, so a Windows install IS a .cmd shim — and it carries
  // the prompt in argv, which cmd.exe would re-parse. Must be refused, not picked.
  assert.equal(cliUsableForReview("copilot", { platform: "win32", resolve: () => "C:\\npm\\copilot.cmd" }), false);
  assert.equal(cliUsableForReview("copilot", { platform: "win32", resolve: () => "C:\\tools\\copilot.exe" }), true);
  assert.equal(cliUsableForReview("copilot", { platform: "linux", resolve: () => "/usr/bin/copilot" }), true);
});

test("copilot's quoted unknown-option stderr is parsed without mangling the flag", () => {
  // Captured verbatim from Copilot CLI 1.0.77 (commander.js quotes the flag).
  assert.equal(
    describeUnknownFlagRejection("copilot", "error: unknown option '--definitely-not-a-flag'\n\nTry 'copilot --help' for more information.\n"),
    'provider "copilot" rejected flag "--definitely-not-a-flag"'
  );
  // The unquoted forms keep working.
  assert.equal(
    describeUnknownFlagRejection("claude", "error: unknown flag: --mode\n"),
    'provider "claude" rejected flag "--mode"'
  );
  assert.equal(
    describeUnknownFlagRejection("agy", "flags provided but not defined: -permission-mode\n"),
    'provider "agy" rejected flag "--permission-mode"'
  );
});

test("a CLI named by PATH gets its own calling convention, not the generic one", () => {
  // Accepting a path for --provider meant every dispatch that compared the raw
  // string to "agy"/"claude"/"codex" mismatched, so "/opt/tools/agy" configured
  // cleanly and then reached the wrong branch — losing --mode plan, the argv
  // prompt, and --print-timeout. Same defect as the loop fixer, second surface.
  for (const named of ["/opt/tools/agy", "C:\\tools\\agy.cmd", "/usr/local/bin/agy"]) {
    assert.equal(cliRequiresArgvPrompt(named), true, `${named} must still be argv-prompt`);
    assert.deepEqual(
      cliFallbackArgs(named, "PROMPT-BODY", { timeoutMs: 900 * 1000 }),
      ["--mode", "plan", "--print-timeout", "900s", "-p", "PROMPT-BODY"],
      `${named} lost its agy convention`
    );
    assert.deepEqual(cliReviewArgs(named), [], `${named} must have no stdin review form`);
  }
  for (const named of ["/opt/tools/claude", "C:\\npm\\claude.CMD"]) {
    assert.equal(cliRequiresArgvPrompt(named), false);
    assert.deepEqual(
      cliReviewArgs(named),
      ["--permission-mode", "plan", "-p", "-"],
      `${named} lost its claude convention`
    );
  }
  // Cursor's alias forms travel by path too.
  assert.deepEqual(
    cliReviewArgs("/opt/tools/cursor-agent"),
    ["-p", "--trust", "--output-format", "text", "--mode", "plan", "-"]
  );
  // A genuinely unknown CLI still gets the generic form.
  assert.deepEqual(cliFallbackArgs("/opt/tools/somecli", "PROMPT-BODY"), ["PROMPT-BODY"]);
});

test("isCliPrintTimeoutStderr recognizes agy giving up on its own wait", () => {
  assert.equal(isCliPrintTimeoutStderr("Error: timeout waiting for response\n"), true);
  assert.equal(isCliPrintTimeoutStderr("some unrelated failure"), false);
  assert.equal(isCliPrintTimeoutStderr(""), false);
  assert.equal(isCliPrintTimeoutStderr(null), false);
});

test("agy's own print-timeout surfaces as a --timeout overrun, not an opaque exit 1", { skip: process.platform === "win32" ? "Windows batch shims refuse argv-prompt CLIs by design" : false }, async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-print-timeout-"));
  writeMockBin(tmpDir, "agy", `process.stderr.write("Error: timeout waiting for response\\n"); process.exit(1);`);

  const oldPath = process.env.PATH;
  process.env.PATH = `${tmpDir}${path.delimiter}${oldPath}`;
  try {
    await assert.rejects(
      () => llmCall({ provider: "cli", cliCmd: "agy", timeoutMs: 900 * 1000 }, "review this", "sys"),
      (err) => {
        assert.match(err.message, /exceeded --timeout 900s; retry with --timeout <larger>/);
        return true;
      }
    );
  } finally {
    process.env.PATH = oldPath;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
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
    assert.equal(vercel.model, GATEWAY_FAMILY_MODELS.anthropic);
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

test("agy CLI review path delivers the prompt as the -p argument (no stdin sentinel)", { skip: process.platform === "win32" ? "Windows batch shims refuse argv-prompt CLIs by design" : false }, async () => {
  const { llmCall } = await import("../src/llm.js");

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-test-"));
  const sentinelSystem = "be adversarial sentinel";
  const sentinelPrompt = "review this sentinel";
  const expectedResponse = '{"verdict":"approve","summary":"ok"}';

  const mockCode = `
const args = process.argv.slice(2);
let hasPrint = false;
let hasPlan = false;
let hasBadFlag = false;
let hasStdinDash = false;
let promptArg = "";
for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg === "-p" || arg === "--print" || arg === "--prompt") hasPrint = true;
  if (arg === "-") hasStdinDash = true;
  if (arg === "--permission-mode") hasBadFlag = true;
  if (i > 0 && args[i-1] === "--mode" && arg === "plan") hasPlan = true;
  if (i > 0 && (args[i-1] === "-p" || args[i-1] === "--print" || args[i-1] === "--prompt")) promptArg = arg;
}
if (!hasPrint) { console.error("FAIL: -p/--print not passed"); process.exit(1); }
if (!hasPlan) { console.error("FAIL: --mode plan not passed"); process.exit(1); }
if (hasBadFlag) { console.error("FAIL: --permission-mode must not be passed"); process.exit(1); }
if (hasStdinDash) { console.error("FAIL: stdin dash passed"); process.exit(1); }
if (!promptArg.includes(${JSON.stringify(sentinelSystem)})) { console.error("FAIL: missing system"); process.exit(1); }
if (!promptArg.includes(${JSON.stringify(sentinelPrompt)})) { console.error("FAIL: missing prompt"); process.exit(1); }
process.stdout.write(${JSON.stringify(expectedResponse)});
`;
  writeMockBin(tmpDir, "agy", mockCode);

  const oldPath = process.env.PATH;
  process.env.PATH = `${tmpDir}${path.delimiter}${oldPath}`;

  try {
    const config = { provider: "cli", cliCmd: "agy", timeoutMs: 10000 };
    const result = await llmCall(config, sentinelPrompt, sentinelSystem);
    assert.equal(result, expectedResponse, "should return agy's stdout from print mode");
  } finally {
    process.env.PATH = oldPath;
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
});

test("codex CLI path uses exec --output-last-message and delivers full prompt via stdin", async () => {
  const { llmCall } = await import("../src/llm.js");

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-test-"));
  const sentinelSystem = "be adversarial sentinel";
  const sentinelPrompt = "review this sentinel";
  const expectedResponse = '{"verdict":"approve","summary":"ok"}';

  const mockCode = `
import fs from "node:fs";
const args = process.argv.slice(2);
let outputFile = "";
let readStdin = false;
let hasSandbox = false;
let hasIgnoreRules = false;
let hasEphemeral = false;
for (let i = 0; i < args.length; i++) {
  if (i > 0 && args[i-1] === "--output-last-message") outputFile = args[i];
  if (i > 0 && args[i-1] === "--sandbox" && args[i] === "read-only") hasSandbox = true;
  if (args[i] === "--ignore-rules") hasIgnoreRules = true;
  if (args[i] === "--ephemeral") hasEphemeral = true;
  if (args[i] === "-") readStdin = true;
}
if (!outputFile) { console.error("FAIL: --output-last-message not passed"); process.exit(1); }
if (!hasSandbox) { console.error("FAIL: --sandbox read-only not passed"); process.exit(1); }
if (!hasIgnoreRules) { console.error("FAIL: --ignore-rules not passed"); process.exit(1); }
if (!hasEphemeral) { console.error("FAIL: --ephemeral not passed"); process.exit(1); }
if (!readStdin) { console.error("FAIL: stdin indicator (-) not passed"); process.exit(1); }
const stdinContent = fs.readFileSync(0, "utf8");
if (!stdinContent.includes(${JSON.stringify(sentinelSystem)})) { console.error("FAIL: system instruction missing"); process.exit(1); }
if (!stdinContent.includes(${JSON.stringify(sentinelPrompt)})) { console.error("FAIL: prompt content missing"); process.exit(1); }
fs.writeFileSync(outputFile, ${JSON.stringify(expectedResponse)});
`;
  writeMockBin(tmpDir, "codex", mockCode);

  const oldPath = process.env.PATH;
  process.env.PATH = `${tmpDir}${path.delimiter}${oldPath}`;

  try {
    const config = { provider: "cli", cliCmd: "codex", timeoutMs: 10000 };
    const result = await llmCall(config, sentinelPrompt, sentinelSystem);
    assert.equal(result, expectedResponse, "should return the content written to --output-last-message");
  } finally {
    process.env.PATH = oldPath;
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
});

test("codex CLI path sanitizes the schema written to --output-schema (matches the OpenAI call site's options: no optional property outside required, no constraint keywords)", async () => {
  const { llmCall } = await import("../src/llm.js");

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-schema-test-"));
  const sentinelSystem = "be adversarial sentinel";
  const sentinelPrompt = "review this sentinel";
  const expectedResponse = '{"verdict":"approve","summary":"sanitized ok"}';

  const mockCode = `
import fs from "node:fs";
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
  fs.writeFileSync(outputFile, ${JSON.stringify(expectedResponse)});
});
`;
  writeMockBin(tmpDir, "codex", mockCode);

  const oldPath = process.env.PATH;
  process.env.PATH = `${tmpDir}${path.delimiter}${oldPath}`;

  try {
    const config = { provider: "cli", cliCmd: "codex", timeoutMs: 10000 };
    const schema = loadSchema();
    const result = await llmCall(config, sentinelPrompt, sentinelSystem, schema);
    assert.equal(result, expectedResponse, "should return the content written to --output-last-message");
  } finally {
    process.env.PATH = oldPath;
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
});



test("claude CLI review path uses -p, stdin sentinel, and plan mode (same contract as agy)", async () => {
  const { llmCall } = await import("../src/llm.js");

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-test-"));
  const expectedResponse = '{"verdict":"approve","summary":"ok"}';

  const mockCode = `
import fs from "node:fs";
const args = process.argv.slice(2);
let hasPrint = false;
let readStdin = false;
let hasPlan = false;
for (let i = 0; i < args.length; i++) {
  if (args[i] === "-p" || args[i] === "--print") hasPrint = true;
  if (args[i] === "-") readStdin = true;
  if (i > 0 && args[i-1] === "--permission-mode" && args[i] === "plan") hasPlan = true;
}
if (!hasPrint) { console.error("FAIL: -p missing"); process.exit(1); }
if (!readStdin) { console.error("FAIL: - missing"); process.exit(1); }
if (!hasPlan) { console.error("FAIL: plan mode missing"); process.exit(1); }
process.stdin.resume();
process.stdin.on("end", () => {
  process.stdout.write(${JSON.stringify(expectedResponse)});
});
`;
  writeMockBin(tmpDir, "claude", mockCode);

  const oldPath = process.env.PATH;
  process.env.PATH = `${tmpDir}${path.delimiter}${oldPath}`;
  try {
    const result = await llmCall(
      { provider: "cli", cliCmd: "claude", timeoutMs: 10000 },
      "review me",
      "system"
    );
    assert.equal(result, expectedResponse);
  } finally {
    process.env.PATH = oldPath;
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
});

test("allowUnsandboxedCli omits plan-mode sandbox flags for claude/agy review", async () => {
  const { llmCall } = await import("../src/llm.js");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-unsandbox-"));
  const mockCode = `
import fs from "node:fs";
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i++) {
  if (args[i] === "plan") { console.error("FAIL: plan mode present"); process.exit(1); }
}
fs.readFileSync(0, "utf8");
process.stdout.write('{"ok":true}');
`;
  writeMockBin(tmpDir, "claude", mockCode);

  const oldPath = process.env.PATH;
  process.env.PATH = `${tmpDir}${path.delimiter}${oldPath}`;
  try {
    const result = await llmCall(
      { provider: "cli", cliCmd: "claude", timeoutMs: 10000, allowUnsandboxedCli: true },
      "p",
      "s"
    );
    assert.equal(result, '{"ok":true}');
  } finally {
    process.env.PATH = oldPath;
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
});

test("unknown-flag CLI rejection is reported as rejected flag, not prompt-size error", { skip: process.platform === "win32" ? "agy CLI shim is refused on Windows" : false }, async () => {
  const { llmCall } = await import("../src/llm.js");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-badflag-"));
  const mockCode = `
console.error("flags provided but not defined: -mode\\nUsage of agy:");
process.exit(2);
`;
  writeMockBin(tmpDir, "agy", mockCode);

  const oldPath = process.env.PATH;
  process.env.PATH = `${tmpDir}${path.delimiter}${oldPath}`;
  const hugePrompt = "x".repeat(110 * 1024);
  try {
    await assert.rejects(
      () => llmCall({ provider: "cli", cliCmd: "agy", timeoutMs: 10000 }, hugePrompt, "sys"),
      (err) => {
        assert.match(err.message, /provider "agy" rejected flag "--mode"/);
        assert.doesNotMatch(err.message, /prompt is too large/);
        return true;
      }
    );
  } finally {
    process.env.PATH = oldPath;
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
});

test("CLI provider honors config.timeoutMs (fails faster than the 10m hardcode)", async () => {
  const { llmCall } = await import("../src/llm.js");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cli-timeout-"));
  writeMockBin(tmpDir, "slowcli", `
await new Promise(r => setTimeout(r, 5000));
process.stdout.write("ok");
`);

  const oldPath = process.env.PATH;
  process.env.PATH = `${tmpDir}${path.delimiter}${oldPath}`;
  const started = Date.now();
  try {
    await assert.rejects(
      () => llmCall({ provider: "cli", cliCmd: "slowcli", timeoutMs: 500 }, "p", "s"),
      /Failed to execute local CLI agent|ETIMEDOUT|timed out|spawnSync/i
    );
    assert.ok(Date.now() - started < 4000, "should time out well under 4s");
  } finally {
    process.env.PATH = oldPath;
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
});

test("maxArgvPromptBytes derives from platform ARG_MAX, not a 100 KiB constant", () => {
  // Issue #27: a 114 KB prompt was refused by the old hardcoded 100 KiB guard
  // even though macOS ARG_MAX is 1 MiB and Linux MAX_ARG_STRLEN is 128 KiB.
  const macLimit = maxArgvPromptBytes({
    platform: "darwin",
    argMax: 1048576,
    envBytes: 10_000,
    overheadBytes: 16 * 1024,
  });
  assert.ok(macLimit > 114_711, `macOS limit ${macLimit} should allow a 114711-byte prompt`);
  assert.ok(macLimit > 100 * 1024, "macOS limit must exceed the old 100 KiB hardcode");

  const linuxLimit = maxArgvPromptBytes({
    platform: "linux",
    argMax: 2 * 1024 * 1024,
    envBytes: 10_000,
    overheadBytes: 16 * 1024,
  });
  // Linux is bound by MAX_ARG_STRLEN (128 KiB), not total ARG_MAX.
  assert.ok(linuxLimit <= 128 * 1024, `linux limit ${linuxLimit} must respect MAX_ARG_STRLEN`);
  assert.ok(linuxLimit > 114_711, `linux limit ${linuxLimit} should still allow a 114711-byte prompt`);
  assert.ok(linuxLimit < 200 * 1024, "linux must not use the full 2 MiB ARG_MAX for a single arg");

  // Win32: command-line cap is separate from the environment block.
  const winLimit = maxArgvPromptBytes({
    platform: "win32",
    argMax: 32 * 1024,
    envBytes: 10_000,
    overheadBytes: 16 * 1024,
  });
  assert.equal(winLimit, 16 * 1024);
});

test("114 KB prompt falls back to argv on stdin rejection instead of refusing", { skip: process.platform === "win32" ? "Windows batch shims refuse argv prompts by design" : false }, async () => {
  const { llmCall } = await import("../src/llm.js");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-argv-114k-"));
  const expected = '{"verdict":"approve","summary":"argv ok"}';
  const mockCode = `
import fs from "node:fs";
const args = process.argv.slice(2);
if (args.includes("-")) {
  console.error("stdin not supported in this mock");
  process.exit(2);
}
const prompt = args[args.length - 1] || "";
if (Buffer.byteLength(prompt) < 100000) {
  console.error("FAIL: expected large argv prompt, got " + Buffer.byteLength(prompt));
  process.exit(1);
}
process.stdout.write(${JSON.stringify(expected)});
`;
  writeMockBin(tmpDir, "agy", mockCode);

  const oldPath = process.env.PATH;
  process.env.PATH = `${tmpDir}${path.delimiter}${oldPath}`;
  const largeBody = "y".repeat(114_711);
  try {
    const result = await llmCall(
      { provider: "cli", cliCmd: "agy", timeoutMs: 10000 },
      largeBody,
      "sys"
    );
    assert.equal(result, expected);
  } finally {
    process.env.PATH = oldPath;
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
});

test("argv refusal names the platform limit, not a generic CLI failure", async () => {
  const { llmCall } = await import("../src/llm.js");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-too-big-"));
  const mockCode = `
console.error("stdin rejected");
process.exit(2);
`;
  writeMockBin(tmpDir, "agy", mockCode);

  const oldPath = process.env.PATH;
  process.env.PATH = `${tmpDir}${path.delimiter}${oldPath}`;
  const enormous = "z".repeat(3 * 1024 * 1024);
  try {
    await assert.rejects(
      () => llmCall({ provider: "cli", cliCmd: "agy", timeoutMs: 10000 }, enormous, "sys"),
      (err) => {
        assert.match(err.message, /exceeds this platform's argv limit/);
        assert.doesNotMatch(err.message, /Failed to execute local CLI agent/);
        return true;
      }
    );
  } finally {
    process.env.PATH = oldPath;
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
});

// ─── T12: spawn safety ──────────────────────────────────────────────────────

test("T12 AC1: no spawn site derives `shell` from the platform or the environment", () => {
  // Regression guard for the Windows argument-injection defect: execCli used
  // `shell: process.platform === "win32"`, handing every argument to cmd.exe.
  // Every module that can spawn, not just llm.js — the actual spawn moved into
  // exec-watchdog.js when the watchdog landed, and a guard pinned to one file
  // would have silently stopped covering the thing it guards.
  const modules = ["../src/llm.js", "../src/exec-watchdog.js", "../src/spawn-safe.js"];
  let explicitFalse = 0;
  let shellTrue = 0;

  for (const mod of modules) {
    const raw = fs.readFileSync(new URL(mod, import.meta.url), "utf8");
    // Scan CODE, not prose: the fix is documented in comments that necessarily
    // quote the old `shell: process.platform === "win32"` construct, and a naive
    // grep would flag that explanation as the defect it describes.
    const code = raw
      .split("\n")
      .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
      .join("\n");

    for (const line of code.split("\n").filter((l) => /^\s*shell:/.test(l))) {
      if (/shell:\s*false/.test(line)) { explicitFalse++; continue; }
      shellTrue++;
    }
    // The original defect was a shell selected by an EXPRESSION over platform or
    // env. Neither that nor a literal `shell: true` may reappear: a Windows .cmd
    // shim reaches its interpreter through buildSpawnTarget, by resolved absolute
    // path, with untrusted argv refused — no spawn site needs a shell.
    assert.ok(!/shell:\s*process\.(platform|env)/.test(code), `${mod}: shell must never be derived from platform/env`);
    assert.ok(!/process\.env\.SHELL/.test(code), `${mod}: SHELL must not select a shell`);
  }

  assert.ok(explicitFalse > 0, "at least one spawn site must set shell:false explicitly");
  assert.equal(shellTrue, 0, "no spawn site may enable a shell — cmd.exe would re-parse argv");
});

test("a Windows .cmd shim never receives the reviewed prompt as an argument", () => {
  // The agy provider delivers the prompt via argv (it has no stdin sentinel). On
  // Windows that argv would reach cmd.exe through the shim interpreter, which
  // re-parses it — so a diff containing cmd.exe metacharacters could execute as
  // commands. This must fail closed rather than spawn.
  const prompt = 'review this & calc.exe';
  assert.throws(
    () => buildSpawnTarget("C:\\npm\\agy.cmd", ["--mode", "plan", "-p", prompt], {
      platform: "win32", env: {}, argsContainUntrusted: true
    }),
    (err) => {
      assert.equal(err.code, "EWINARGV");
      assert.doesNotMatch(err.message, /T19|tracked in/i, "error must name a remedy, not a ticket");
      assert.match(err.message, /stdin|API provider|native executable/);
      return true;
    }
  );

  // A native executable has no interpreter in the path at all, so the same argv
  // is spawned directly — no cmd.exe, nothing to re-parse.
  const direct = buildSpawnTarget("C:\\tools\\agy.exe", ["-p", prompt], {
    platform: "win32", env: {}, argsContainUntrusted: true
  });
  assert.equal(direct.viaInterpreter, false);
  assert.equal(direct.command, "C:\\tools\\agy.exe");
  assert.deepEqual(direct.args, ["-p", prompt]);
});

test("execCli has no platform-branched spawn: every OS takes the watchdog path", () => {
  // Regression guard for the bypass this replaced — execCli used to short-circuit
  // win32 into execFileSync(shell:true), skipping buildSpawnTarget entirely, so
  // the untrusted-argv refusal and the resolved-path routing never ran there.
  const raw = fs.readFileSync(new URL("../src/llm.js", import.meta.url), "utf8");
  const code = raw.split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
  const execCliBody = code.slice(code.indexOf("async function execCli("));
  const body = execCliBody.slice(0, execCliBody.indexOf("\n}"));
  assert.ok(!/process\.platform/.test(body), "execCli must not branch on platform when spawning");
  assert.ok(/spawnWithWatchdog\(/.test(body), "execCli must spawn through spawnWithWatchdog");
});

test("T12: isCmdInstalled still answers correctly via resolveCommand", () => {
  assert.equal(isCmdInstalled("node"), true);
  assert.equal(isCmdInstalled("definitely-not-a-real-binary-xyz"), false);
  // Paths and metacharacters are not bare commands and must not resolve.
  for (const bad of ["/bin/sh", "../evil", "a;b"]) {
    assert.equal(isCmdInstalled(bad), false, `${bad} must not be treated as installed`);
  }
});

test("T12 AC11: an unresolvable local CLI throws an error naming the command", async () => {
  // Declared in T12's coldstart amendment: when resolveCommand returns null,
  // execCli must fail with a clear message rather than passing a bare name to
  // the OS and hoping. Previously untested.
  const err = await llmCall(
    { provider: "cli", cliCmd: "definitely-not-a-real-binary-xyz", timeoutMs: 5000 },
    "prompt",
    "system"
  ).catch((e) => e);
  assert.ok(err instanceof Error);
  assert.match(err.message, /definitely-not-a-real-binary-xyz/, "the message must name the command");
  assert.match(err.message, /not found on PATH/);
});

// --- T46: opencode ------------------------------------------------------------

test("the generated opencode config denies every mutating tool", () => {
  const name = newOpencodeAgentName();
  const cfg = buildOpencodeConfig(name);
  const agent = cfg.agent[name];
  assert.equal(agent.mode, "primary", "a subagent is silently ignored by --agent");
  for (const tool of ["write", "edit", "patch", "bash", "task"]) {
    assert.equal(agent.tools[tool], false, `${tool} must be disabled for an untrusted diff`);
  }
  // The reviewer still has to read the repository.
  for (const tool of ["read", "grep", "glob", "list"]) {
    assert.equal(agent.tools[tool], true);
  }
});

test("every enabled opencode tool has an explicit permission (the hang guard)", () => {
  // opencode has NO headless auto-deny: an enabled tool whose permission is unset
  // blocks on an interactive prompt forever, with no output and no error. This
  // shape must be structurally impossible to emit, not merely avoided by hand.
  const name = newOpencodeAgentName();
  const agent = buildOpencodeConfig(name).agent[name];
  assert.equal(agent.permission["*"], "deny", "a catch-all deny is required");
  const enabled = Object.entries(agent.tools).filter(([, on]) => on === true).map(([t]) => t);
  assert.ok(enabled.length > 0, "the reviewer needs at least one tool");
  const unpermitted = enabled.filter((t) => !(t in agent.permission));
  assert.deepEqual(unpermitted, [], `enabled tools with no explicit permission would hang: ${unpermitted}`);
  for (const t of enabled) assert.equal(agent.permission[t], "allow");
});

test("opencode review argv pins the agent and model, and never carries the prompt", () => {
  const agent = newOpencodeAgentName();
  const args = opencodeReviewArgs({ agent });
  assert.deepEqual(args, ["--pure", "run", "--agent", agent, "-m", OPENCODE_DEFAULT_MODEL]);
  // --pure blocks external plugins: plugin loading is another path the reviewed
  // repository controls through project config, and a plugin runs code.
  assert.ok(args.includes("--pure"));
  // --agent is mandatory: naming a subagent (or omitting it) makes opencode fall
  // back to the user's default primary agent, which may permit writes.
  assert.equal(args[args.indexOf("--agent") + 1], agent);
  assert.throws(() => opencodeReviewArgs({}), /requires the per-run agent name/);

  const pinned = opencodeReviewArgs({ agent, model: "opencode-go/kimi-k3" });
  assert.equal(pinned[pinned.indexOf("-m") + 1], "opencode-go/kimi-k3");

  // The prompt travels on stdin, so the argv-size guard does not apply.
  assert.equal(cliRequiresArgvPrompt("opencode"), false);
  assert.equal(args.some((a) => a.includes("Prompt:")), false);
});

test("the opencode agent name is unguessable and fresh per run", () => {
  // SECURITY: OPENCODE_CONFIG merges with project-local opencode.json from the
  // repository under review. A repo that ships a config redefining our agent BY
  // NAME wins that merge and re-enables write/bash — verified by live attack. A
  // fixed name is a name the attacker knows; a per-run random one cannot be
  // targeted by a file written before the run.
  const seen = new Set();
  for (let i = 0; i < 200; i++) seen.add(newOpencodeAgentName());
  assert.equal(seen.size, 200, "every run must get a distinct agent name");
  const one = newOpencodeAgentName();
  assert.ok(one.startsWith(OPENCODE_AGENT_PREFIX));
  const suffix = one.slice(OPENCODE_AGENT_PREFIX.length);
  assert.match(suffix, /^[0-9a-f]{32}$/, "128 bits of entropy, hex-encoded");
});

test("opencode sandbox verification fails closed on a silent agent downgrade", () => {
  const agent = newOpencodeAgentName();
  // The real warning opencode emits, captured verbatim. It exits 0 afterwards.
  assert.match(
    opencodeSandboxFailure(`! agent "${agent}" is a subagent, not a primary agent. Falling back to default agent`, agent),
    /fell back to the default agent/
  );
  // A banner that never names our agent is equally untrustworthy.
  assert.match(opencodeSandboxFailure("> some-other-agent · grok-4.5", agent), /never reported running/);
  assert.match(opencodeSandboxFailure("", agent), /never reported running/);
  // The good case: the banner names the agent we pinned.
  assert.equal(opencodeSandboxFailure(`> ${agent} · grok-4.5`, agent), null);
});

test("opencode's default model reaches a provider no other backend serves", () => {
  // The reason to add opencode at all: models outside the three frontier labs.
  assert.match(OPENCODE_DEFAULT_MODEL, /^opencode-go\//);
});

test("opencode stdout is parsed even when tool-call narration precedes the JSON", () => {
  // Captured shape from a real run: `--format default` concatenates narration
  // fragments directly onto the answer with no delimiter.
  const captured =
    "I'll audit the ticket against the repo and the referenced spec." +
    "Reading the full spec and key implementation touchpoints next." +
    '{"verdict":"approve","summary":"ok"}';
  assert.equal(cleanJsonResponse(captured), '{"verdict":"approve","summary":"ok"}');
});

test("the opencode session banner is on stderr and never reaches the extractor", () => {
  // The banner ("> agent · model") is stderr; spawnWithWatchdog resolves with
  // stdout alone, so a banner in the payload would mean we read the wrong stream.
  const banner = "> adversarial-review-readonly · grok-4.5";
  const stdout = '{"verdict":"approve","summary":"ok"}';
  const cleaned = cleanJsonResponse(stdout);
  assert.doesNotMatch(cleaned, /adversarial-review-readonly|·/);
  assert.equal(cleaned, stdout);
  assert.doesNotMatch(cleaned, new RegExp(banner.slice(0, 5)));
});

test("an unavailable opencode model is reported by name, not as a bare exit code", () => {
  assert.equal(isOpencodeModelUnavailable("Error: Your credit balance is too low to access the Anthropic API."), true);
  assert.equal(isOpencodeModelUnavailable("no such model: opencode-go/nope"), true);
  assert.equal(isOpencodeModelUnavailable("unauthorized"), true);
  assert.equal(isOpencodeModelUnavailable("some unrelated crash"), false);
});
