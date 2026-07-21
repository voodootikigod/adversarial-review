import { execFileSync } from "child_process";
import { resolveCommand } from "./spawn-safe.js";
import { spawnWithWatchdog } from "./exec-watchdog.js";
import fs from "fs";
import os from "os";
import path from "path";
import { log } from "./utils.js";
import { sanitizeSchemaForProvider } from "./schema-validate.js";

const DEFAULT_TIMEOUT_MS = 120 * 1000;

// Linux kernels cap a *single* argument at MAX_ARG_STRLEN (PAGE_SIZE * 32 = 128 KiB
// on 4 KiB pages). That is the binding constraint for one huge prompt arg even when
// total ARG_MAX is larger (often ~2 MiB). macOS has no equivalent per-arg cap —
// its ARG_MAX is typically 1 MiB for args+env combined.
const LINUX_MAX_ARG_STRLEN = 128 * 1024;
const DEFAULT_ARGV_OVERHEAD_BYTES = 16 * 1024; // argv entries other than the prompt + margin
const PLATFORM_ARG_MAX_DEFAULTS = {
  darwin: 1024 * 1024,
  linux: 2 * 1024 * 1024,
  win32: 32 * 1024, // CreateProcess command-line limit is ~32K characters
};

let cachedProbedArgMax = undefined; // undefined = not probed yet; null = probe failed

function environmentBlockBytes(env = process.env) {
  let n = 0;
  for (const [key, value] of Object.entries(env)) {
    n += Buffer.byteLength(key) + 1 + Buffer.byteLength(value ?? "") + 1;
  }
  return n;
}

function probeArgMax() {
  if (cachedProbedArgMax !== undefined) return cachedProbedArgMax;
  try {
    const out = execFileSync("getconf", ["ARG_MAX"], {
      encoding: "utf8",
      timeout: 2000,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    const n = Number.parseInt(out, 10);
    cachedProbedArgMax = Number.isFinite(n) && n > 0 ? n : null;
  } catch {
    cachedProbedArgMax = null;
  }
  return cachedProbedArgMax;
}

/**
 * Maximum prompt size safe to pass as a single argv element on this platform.
 * Prefer probing `getconf ARG_MAX`; fall back to platform defaults. On Linux the
 * per-argument MAX_ARG_STRLEN ceiling wins over total ARG_MAX.
 *
 * Injectable options exist for unit tests. When overriding `platform` for a
 * cross-platform check, also inject `argMax` — `probeArgMax()` always runs
 * against the host OS.
 */
export function maxArgvPromptBytes({
  platform = process.platform,
  argMax = undefined,
  envBytes = undefined,
  overheadBytes = DEFAULT_ARGV_OVERHEAD_BYTES,
} = {}) {
  const probed = argMax !== undefined ? argMax : probeArgMax();
  const platformDefault = PLATFORM_ARG_MAX_DEFAULTS[platform] ?? PLATFORM_ARG_MAX_DEFAULTS.linux;
  const totalArgMax = probed ?? platformDefault;

  // Windows CreateProcess command-line and environment limits are separate;
  // do not subtract the env block from the ~32K argv budget.
  const env = platform === "win32"
    ? 0
    : (envBytes !== undefined ? envBytes : environmentBlockBytes());
  const totalBudget = totalArgMax - env - overheadBytes;

  // Linux: a single argument cannot exceed MAX_ARG_STRLEN regardless of ARG_MAX.
  if (platform === "linux") {
    // 1 KiB safety margin for NUL terminator + kernel accounting rounding.
    const perArgBudget = LINUX_MAX_ARG_STRLEN - 1024;
    return Math.max(0, Math.min(perArgBudget, totalBudget));
  }

  return Math.max(0, totalBudget);
}

function argvTooLargeMessage(cliLabel, promptBytes, limitBytes) {
  return (
    `${cliLabel} rejected the prompt on stdin, and the prompt (${promptBytes} bytes) ` +
    `exceeds this platform's argv limit (~${limitBytes} bytes). ` +
    `Lower --max-bytes, narrow the scope, or use an API provider.`
  );
}

function isE2BigError(err) {
  return err?.code === "E2BIG" || err?.errno === os.constants.errno.E2BIG;
}

// Robustly extract JSON from a model response, even if wrapped in prose or a markdown fence.
export function cleanJsonResponse(text) {
  let cleaned = text.trim();

  // Try parsing the raw text directly in case it's clean JSON
  try {
    JSON.parse(cleaned);
    return cleaned;
  } catch {}

  // Strategy 1: Extract markdown JSON code block
  const jsonBlockMatch = cleaned.match(/```json\s*([\s\S]*?)\s*```/);
  if (jsonBlockMatch) {
    const candidate = jsonBlockMatch[1].trim();
    try {
      JSON.parse(candidate);
      return candidate;
    } catch {}
  }

  // Strategy 2: Extract generic code block
  const genericBlockMatch = cleaned.match(/```\s*([\s\S]*?)\s*```/);
  if (genericBlockMatch) {
    const candidate = genericBlockMatch[1].trim();
    try {
      JSON.parse(candidate);
      return candidate;
    } catch {}
  }

  // Strategy 3: Falling back to outer bounds index locator
  const firstBrace = cleaned.indexOf("{");
  const firstBracket = cleaned.indexOf("[");
  let startIdx = -1;
  let endIdx = -1;

  if (firstBrace !== -1 && (firstBracket === -1 || firstBrace < firstBracket)) {
    startIdx = firstBrace;
    endIdx = cleaned.lastIndexOf("}");
  } else if (firstBracket !== -1) {
    startIdx = firstBracket;
    endIdx = cleaned.lastIndexOf("]");
  }

  if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
    const candidate = cleaned.substring(startIdx, endIdx + 1).trim();
    try {
      JSON.parse(candidate);
      return candidate;
    } catch {}

    // Fallback cleanup if the boundary extraction left fences inside
    let temp = candidate;
    if (temp.startsWith("```json")) {
      temp = temp.slice(7);
    } else if (temp.startsWith("```")) {
      temp = temp.slice(3);
    }
    if (temp.endsWith("```")) {
      temp = temp.slice(0, -3);
    }
    temp = temp.trim();
    try {
      JSON.parse(temp);
      return temp;
    } catch {}

    return candidate;
  }

  return cleaned;
}

// Check if a shell command is installed and executable. Thin boolean wrapper
// over resolveCommand, which does the PATH/PATHEXT walk and returns the path
// the spawn sites actually need.
export function isCmdInstalled(cmd) {
  return resolveCommand(cmd) !== null;
}

async function execCli(cliCmd, args, input = null, timeoutMs = 10 * 60 * 1000, { stream = false } = {}) {
  // SECURITY: shell:false on every platform. This previously passed
  // `shell: process.platform === "win32"`, which handed every argument to
  // cmd.exe for re-parsing on Windows and lost argv metacharacter safety.
  //
  // That flag was not gratuitous — it was how npm-installed `.cmd` shims got
  // resolved. So it cannot simply be removed: resolveCommand performs that
  // lookup explicitly (PATH + PATHEXT) and we spawn the resolved absolute path,
  // which removes the only reason the shell was needed.
  const resolved = resolveCommand(cliCmd);
  if (!resolved) {
    throw new Error(
      `Local CLI agent "${cliCmd}" was not found on PATH. Install it, or pass --provider <other>.`
    );
  }
  return spawnWithWatchdog(resolved, args, {
    input,
    timeoutMs,
    streamStdout: stream
  });
}

// Claude-Code-compatible CLIs (claude, agy): always use print mode (-p) with the
// stdin sentinel (-). For review, also force plan/read-only mode so an untrusted
// diff cannot prompt-inject writes (mirrors Codex --sandbox read-only). Flag name
// is per-CLI: claude uses --permission-mode; agy uses --mode. Opt out with
// --allow-unsandboxed-cli when an older CLI rejects plan mode.
export function isCursorAgentCli(cliCmd) {
  return cliCmd === "agent" || cliCmd === "cursor-agent";
}

/** Plan/read-only sandbox flags for a local CLI (empty when unsandboxed or unknown). */
export function cliSandboxArgs(cliCmd, { allowUnsandboxedCli = false } = {}) {
  if (allowUnsandboxedCli) return [];
  if (cliCmd === "claude") return ["--permission-mode", "plan"];
  if (cliCmd === "agy" || isCursorAgentCli(cliCmd)) return ["--mode", "plan"];
  return [];
}

/**
 * Detect an unknown-flag rejection in CLI stderr (Go flag package, common CLIs).
 * Returns a clear error string, or null if stderr does not look like a flag rejection.
 */
export function describeUnknownFlagRejection(cliCmd, stderr) {
  const text = (stderr || "").toString();
  // Go's flag package: "flags provided but not defined: -permission-mode"
  // (one leading dash is stripped in the echo; the caller passed --permission-mode).
  const goMatch = text.match(/flags provided but not defined:\s*-{0,2}(\S+)/i);
  if (goMatch) {
    return `provider "${cliCmd}" rejected flag "--${goMatch[1].replace(/^-+/, "")}"`;
  }
  const unknownMatch = text.match(/unknown (?:flag|option)[:\s]+-{0,2}(\S+)/i);
  if (unknownMatch) {
    return `provider "${cliCmd}" rejected flag "--${unknownMatch[1].replace(/^-+/, "")}"`;
  }
  return null;
}

function envNonEmpty(name) {
  const v = process.env[name];
  if (v == null) return null;
  const s = String(v).trim();
  return s ? s : null;
}

function gatewayCredential() {
  return envNonEmpty("AI_GATEWAY_API_KEY") || envNonEmpty("VERCEL_OIDC_TOKEN");
}

function resolveCursorAgentCmd() {
  if (isCmdInstalled("agent")) return "agent";
  if (isCmdInstalled("cursor-agent")) return "cursor-agent";
  return null;
}

export function cliReviewArgs(cliCmd, { allowUnsandboxedCli = false, model = null } = {}) {
  if (isCursorAgentCli(cliCmd)) {
    // Cursor Agent CLI: -p alone grants write/shell tools — force --mode plan
    // for review isolation (same intent as claude --permission-mode / agy --mode).
    const args = ["-p", "--trust", "--output-format", "text"];
    args.push(...cliSandboxArgs(cliCmd, { allowUnsandboxedCli }));
    if (model) args.push("--model", model);
    args.push("-");
    return args;
  }
  if (cliCmd !== "claude" && cliCmd !== "agy") return [];
  const args = [...cliSandboxArgs(cliCmd, { allowUnsandboxedCli }), "-p", "-"];
  return args;
}

export function cliFallbackArgs(cliCmd, fullPrompt, { allowUnsandboxedCli = false, model = null } = {}) {
  if (isCursorAgentCli(cliCmd)) {
    const args = ["-p", "--trust", "--output-format", "text"];
    args.push(...cliSandboxArgs(cliCmd, { allowUnsandboxedCli }));
    if (model) args.push("--model", model);
    args.push(fullPrompt);
    return args;
  }
  // claude and agy are Claude-Code-compatible: they need -p (print mode) when
  // the prompt is passed as a command-line argument.
  if (cliCmd === "claude" || cliCmd === "agy") {
    return [...cliSandboxArgs(cliCmd, { allowUnsandboxedCli }), "-p", fullPrompt];
  }
  return [fullPrompt];
}

// Invoke the Codex CLI non-interactively via `codex exec`.
// Uses --output-last-message to capture only the final agent response (not the
// full JSONL event stream), and --output-schema when a JSON Schema is provided
// so Codex enforces the output shape natively rather than relying on scraping.
// The prompt is piped via stdin (`-`) to avoid argv size limits on large diffs;
// the argv path is used as a fallback if stdin is rejected.
async function callCodexCli(fullPrompt, schema, timeoutMs = 10 * 60 * 1000, { stream = false } = {}) {
  // Create a private temp directory so path prediction / symlink race attacks
  // against shared /tmp are not possible; the directory is owned by this process.
  const privateDir = fs.mkdtempSync(path.join(os.tmpdir(), "adv-review-codex-"));
  const outFile = path.join(privateDir, "out.txt");
  const schemaFile = schema ? path.join(privateDir, "schema.json") : null;

  try {
    // wx flag: exclusive create — fails if the file already exists (defense in depth
    // inside the already-private directory).
    if (schemaFile) fs.writeFileSync(schemaFile, JSON.stringify(sanitizeSchemaForProvider(schema)), { mode: 0o600, flag: "wx" });

    const baseArgs = [
      "exec",
      // Harden against prompt-injection in untrusted diffs: enforce read-only sandbox so
      // the nested agent cannot write files or run commands, ignore project/user .rules
      // that could be weaponized, and run ephemerally (no session persistence).
      "--sandbox", "read-only",
      "--ignore-rules",
      "--ephemeral",
      "--output-last-message", outFile,
    ];
    if (schemaFile) baseArgs.push("--output-schema", schemaFile);

    try {
      // Primary path: pipe prompt via stdin. Codex's non-interactive exec accepts `-` as
      // the positional prompt argument to signal "read from stdin" (per `codex exec --help`:
      // "If not provided as an argument (or if `-` is used), instructions are read from
      // stdin"). We rely on execFileSync's `input` option to wire the full prompt payload
      // to that stdin pipe, so the review content is never truncated by argv size limits.
      await execCli("codex", [...baseArgs, "-"], fullPrompt, timeoutMs, { stream });
    } catch (stdinErr) {
      if (stdinErr.code === "ETIMEDOUT") {
        throw new Error(`Failed to execute codex: exceeded --timeout ${Math.floor(timeoutMs / 1000)}s; retry with --timeout <larger>`);
      }
      const promptBytes = Buffer.byteLength(fullPrompt);
      const argvLimit = maxArgvPromptBytes();
      if (promptBytes > argvLimit) {
        const stderr = stdinErr.stderr?.toString("utf8").trim() || "";
        throw new Error(
          argvTooLargeMessage("Codex", promptBytes, argvLimit) + (stderr ? `\n${stderr}` : "")
        );
      }
      // Argv fallback: pass prompt as positional argument
      log.substep("Codex stdin path failed, retrying as argument...");
      try {
        await execCli("codex", [...baseArgs, fullPrompt], null, timeoutMs, { stream });
      } catch (argvErr) {
        if (argvErr.code === "ETIMEDOUT") {
          throw new Error(`Failed to execute codex: exceeded --timeout ${Math.floor(timeoutMs / 1000)}s; retry with --timeout <larger>`);
        }
        if (isE2BigError(argvErr)) {
          throw new Error(argvTooLargeMessage("Codex", promptBytes, argvLimit));
        }
        const stderr = argvErr.stderr?.toString("utf8") || stdinErr.stderr?.toString("utf8") || "";
        throw new Error(
          `Failed to execute codex: ${argvErr.message || stdinErr.message}` +
            (stderr.trim() ? `\n${stderr.trim()}` : "")
        );
      }
    }

    return fs.readFileSync(outFile, "utf8").trim();
  } finally {
    // Remove the entire private directory and its contents in one pass.
    try { fs.rmSync(privateDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

// Invoke a local CLI agent (claude, agy, ...) by piping the prompt to stdin.
async function callCliLLM(cliCmd, prompt, systemInstruction, schema = null, { timeoutMs = 10 * 60 * 1000, allowUnsandboxedCli = false, model = null, stream = false } = {}) {
  let fullPrompt = "";
  if (systemInstruction) {
    fullPrompt += `System Instructions:\n${systemInstruction}\n\n`;
  }
  fullPrompt += `Prompt:\n${prompt}`;

  log.step(`Invoking local subscription agent via command: "${cliCmd}"...`);

  if (cliCmd === "codex") {
    return callCodexCli(fullPrompt, schema, timeoutMs, { stream });
  }

  // claude: -p + stdin `-` + --permission-mode plan.
  // agy: -p + stdin `-` + --mode plan.
  // agent/cursor-agent: -p + stdin `-` + --mode plan + --trust (Cursor CLI).
  // A bare invocation launches interactively and hangs until timeout.
  const primaryArgs = cliReviewArgs(cliCmd, { allowUnsandboxedCli, model });
  const fallbackOpts = { allowUnsandboxedCli, model };

  try {
    return await execCli(cliCmd, primaryArgs, fullPrompt, timeoutMs, { stream });
  } catch (err) {
    if (err.code === "ETIMEDOUT") {
      throw new Error(`Failed to execute local CLI agent "${cliCmd}": exceeded --timeout ${Math.floor(timeoutMs / 1000)}s; retry with --timeout <larger>`);
    }
    const stderr = err.stderr?.toString("utf8") || "";
    // Unknown-flag rejections must surface clearly — not as a prompt-size / argv error.
    // Retrying argv would pass the same bad flag and fail the same way.
    const flagRejection = describeUnknownFlagRejection(cliCmd, stderr);
    if (flagRejection) {
      throw new Error(flagRejection + (stderr.trim() ? `\n${stderr.trim()}` : ""));
    }
    const promptBytes = Buffer.byteLength(fullPrompt);
    const argvLimit = maxArgvPromptBytes();
    if (promptBytes > argvLimit) {
      throw new Error(
        argvTooLargeMessage(`Local CLI agent "${cliCmd}"`, promptBytes, argvLimit) +
          (stderr.trim() ? `\n${stderr.trim()}` : "")
      );
    }
    try {
      log.substep(`Stdin piping not supported by ${cliCmd}, retrying as argument...`);
      return await execCli(cliCmd, cliFallbackArgs(cliCmd, fullPrompt, fallbackOpts), null, timeoutMs, { stream });
    } catch (err2) {
      if (err2.code === "ETIMEDOUT") {
        throw new Error(`Failed to execute local CLI agent "${cliCmd}": exceeded --timeout ${Math.floor(timeoutMs / 1000)}s; retry with --timeout <larger>`);
      }
      if (isE2BigError(err2)) {
        throw new Error(argvTooLargeMessage(`Local CLI agent "${cliCmd}"`, promptBytes, argvLimit));
      }
      const stderr2 = err2.stderr?.toString("utf8") || stderr;
      const flagRejection2 = describeUnknownFlagRejection(cliCmd, stderr2);
      if (flagRejection2) {
        throw new Error(flagRejection2 + (stderr2.trim() ? `\n${stderr2.trim()}` : ""));
      }
      const suffix = stderr2.trim() ? `\n${stderr2.trim()}` : "";
      throw new Error(`Failed to execute local CLI agent "${cliCmd}": ${err2.message || err.message}${suffix}`);
    }
  }
}

const NO_LLM_CONFIG_MSG =
  "No LLM configuration found.\n" +
  "Set an API key (ANTHROPIC_API_KEY, GEMINI_API_KEY, OPENAI_API_KEY, or AI_GATEWAY_API_KEY),\n" +
  "or install a local CLI agent (claude, codex, agy, or agent).\n" +
  "Or run with --prompt-only to just print the prompt.";

// Resolve the LLM provider from flags, environment variables, or an installed local CLI agent.
export function configureLLM(args) {
  let provider = args.provider;
  let apiKey = null;
  let cliCmd = null;
  // When auto-detect picks the Gateway inside a builder IDE, prefer a model
  // family that is NOT the builder's (transport ≠ diversity family).
  let gatewayPreferModel = null;

  if (!provider) {
    const isClaudeCodeEnv = !!(process.env.CLAUDECODE || process.env.CLAUDE_CODE);
    const isCursorEnv = process.env.TERM_PROGRAM === "cursor";
    const gw = gatewayCredential();

    if (isClaudeCodeEnv) {
      // Builder is Claude. Prefer a non-Anthropic critic.
      if (envNonEmpty("GEMINI_API_KEY")) {
        provider = "gemini";
      } else if (envNonEmpty("OPENAI_API_KEY")) {
        provider = "openai";
      } else if (gw) {
        provider = "vercel";
        gatewayPreferModel = "openai/gpt-5";
      } else if (isCmdInstalled("codex")) {
        provider = "cli";
        cliCmd = "codex";
      } else if (isCmdInstalled("agy")) {
        provider = "cli";
        cliCmd = "agy";
      } else if (resolveCursorAgentCmd()) {
        provider = "cli";
        cliCmd = resolveCursorAgentCmd();
      } else if (envNonEmpty("ANTHROPIC_API_KEY")) {
        provider = "anthropic";
        log.warn("Running in Claude Code, but fell back to Claude for review.");
        log.info("This review is not a pure adversarial review (same provider). To minimize bias, we will execute it in a fresh, isolated context window.");
      } else if (isCmdInstalled("claude")) {
        provider = "cli";
        cliCmd = "claude";
        log.warn("Running in Claude Code, but fell back to Claude for review.");
        log.info("This review is not a pure adversarial review (same provider). To minimize bias, we will execute it in a fresh, isolated context window.");
      } else {
        throw new Error(NO_LLM_CONFIG_MSG);
      }
    } else if (isCursorEnv) {
      // Builder is Cursor. Prefer an independent critic, then the official agent CLI.
      if (envNonEmpty("GEMINI_API_KEY")) {
        provider = "gemini";
      } else if (envNonEmpty("ANTHROPIC_API_KEY")) {
        provider = "anthropic";
      } else if (envNonEmpty("OPENAI_API_KEY")) {
        provider = "openai";
      } else if (gw) {
        provider = "vercel";
        gatewayPreferModel = "anthropic/claude-sonnet-4.6";
      } else if (isCmdInstalled("agy")) {
        provider = "cli";
        cliCmd = "agy";
      } else if (isCmdInstalled("claude")) {
        provider = "cli";
        cliCmd = "claude";
      } else if (isCmdInstalled("codex")) {
        provider = "cli";
        cliCmd = "codex";
      } else if (resolveCursorAgentCmd()) {
        provider = "cli";
        cliCmd = resolveCursorAgentCmd();
        log.warn("Running in Cursor, but fell back to the Cursor Agent CLI for review.");
        log.info("This review is not a pure adversarial review (same provider). To minimize bias, we will execute it in a fresh, isolated context window.");
      } else {
        throw new Error(NO_LLM_CONFIG_MSG);
      }
    } else {
      // Default auto-detection order (Anthropic > Gemini > OpenAI > Gateway > Local CLIs)
      if (envNonEmpty("ANTHROPIC_API_KEY")) {
        provider = "anthropic";
      } else if (envNonEmpty("GEMINI_API_KEY")) {
        provider = "gemini";
      } else if (envNonEmpty("OPENAI_API_KEY")) {
        provider = "openai";
      } else if (gw) {
        provider = "vercel";
      } else if (isCmdInstalled("claude")) {
        provider = "cli";
        cliCmd = "claude";
      } else if (isCmdInstalled("codex")) {
        provider = "cli";
        cliCmd = "codex";
      } else if (isCmdInstalled("agy")) {
        provider = "cli";
        cliCmd = "agy";
      } else if (resolveCursorAgentCmd()) {
        provider = "cli";
        cliCmd = resolveCursorAgentCmd();
      } else {
        throw new Error(NO_LLM_CONFIG_MSG);
      }
    }
  } else {
    // Normalize alias: gateway → vercel (Gateway is a transport id).
    if (provider === "gateway") provider = "vercel";

    // Cursor tokens resolve to the official Agent CLI (not a localhost HTTP proxy).
    if (provider === "cursor" || provider === "agent" || provider === "cursor-agent") {
      if (provider === "cursor") {
        cliCmd = resolveCursorAgentCmd();
      } else {
        cliCmd = isCmdInstalled(provider) ? provider : null;
      }
      if (!cliCmd) {
        throw new Error(
          `Cursor Agent CLI not found on PATH (tried \`agent\` / \`cursor-agent\`).\n` +
          `Install the Cursor CLI, run \`agent login\` (or set CURSOR_API_KEY), then retry.\n` +
          `For a third-party OpenAI-compatible proxy, use --provider openai --api-base <url>.`
        );
      }
      provider = "cli";
    } else {
      const knownApis = ["gemini", "openai", "anthropic", "vercel"];
      if (!knownApis.includes(provider)) {
        if (isCmdInstalled(provider)) {
          cliCmd = provider;
          provider = "cli";
        } else {
          throw new Error(`Provider CLI command "${provider}" is not installed or available in PATH.`);
        }
      }
    }
  }

  // Resolve API Key (CLI flag > LLM_API_KEY > provider-specific env var)
  apiKey = args.apiKey || envNonEmpty("LLM_API_KEY");
  if (!apiKey) {
    if (provider === "gemini") {
      apiKey = envNonEmpty("GEMINI_API_KEY");
    } else if (provider === "openai") {
      apiKey = envNonEmpty("OPENAI_API_KEY");
    } else if (provider === "anthropic") {
      apiKey = envNonEmpty("ANTHROPIC_API_KEY");
    } else if (provider === "vercel") {
      apiKey = gatewayCredential();
    }
  }

  // Resolve API Base URL (CLI flag > provider-specific env var > default)
  let apiBase = args.apiBase;
  if (!apiBase) {
    if (provider === "openai") {
      apiBase = envNonEmpty("OPENAI_API_BASE") || envNonEmpty("OPENAI_BASE_URL") || "https://api.openai.com/v1";
    } else if (provider === "anthropic") {
      apiBase = envNonEmpty("ANTHROPIC_API_BASE") || envNonEmpty("ANTHROPIC_BASE_URL") || "https://api.anthropic.com/v1";
    } else if (provider === "gemini") {
      apiBase = envNonEmpty("GEMINI_API_BASE") || envNonEmpty("GEMINI_BASE_URL") || "https://generativelanguage.googleapis.com";
    } else if (provider === "vercel") {
      apiBase = envNonEmpty("AI_GATEWAY_API_BASE") || envNonEmpty("AI_GATEWAY_BASE_URL") || "https://ai-gateway.vercel.sh/v1";
    }
  }

  const isCustomBase = !!(args.apiBase ||
    (provider === "openai" && (envNonEmpty("OPENAI_API_BASE") || envNonEmpty("OPENAI_BASE_URL"))) ||
    (provider === "anthropic" && (envNonEmpty("ANTHROPIC_API_BASE") || envNonEmpty("ANTHROPIC_BASE_URL"))) ||
    (provider === "gemini" && (envNonEmpty("GEMINI_API_BASE") || envNonEmpty("GEMINI_BASE_URL"))) ||
    (provider === "vercel" && (envNonEmpty("AI_GATEWAY_API_BASE") || envNonEmpty("AI_GATEWAY_BASE_URL")))
  );

  if (provider !== "cli" && !apiKey && !isCustomBase) {
    const hint = provider === "openai"
      ? `\nIf you meant Vercel AI Gateway, use --provider vercel (AI_GATEWAY_API_KEY).`
      : "";
    throw new Error(`Provider "${provider}" requested but corresponding API key is not set in environment.${hint}`);
  }

  let model = args.model;
  if (!model && provider !== "cli") {
    // Gate quality tracks model tier — default to the strong tier of each
    // provider, not the cheap one. Override with --model for cost control.
    // Gateway models use provider/model ids.
    if (provider === "gemini") {
      model = "gemini-2.5-pro";
    } else if (provider === "openai") {
      model = "gpt-5";
    } else if (provider === "anthropic") {
      model = "claude-sonnet-4-6";
    } else if (provider === "vercel") {
      model = gatewayPreferModel || "anthropic/claude-sonnet-4.6";
    }
  }

  // Resolve custom headers
  let customHeaders = {};
  if (process.env.LLM_HEADERS) {
    try {
      customHeaders = JSON.parse(process.env.LLM_HEADERS);
    } catch (e) {
      log.warn(`Failed to parse LLM_HEADERS environment variable: ${e.message}`);
    }
  }
  if (args.headers) {
    try {
      customHeaders = { ...customHeaders, ...JSON.parse(args.headers) };
    } catch (e) {
      log.warn(`Failed to parse --headers CLI argument: ${e.message}`);
    }
  }

  const timeoutMs = Number.isSafeInteger(args.timeout) && args.timeout > 0
    ? args.timeout * 1000
    : (provider === "cli" ? 2400 * 1000 : DEFAULT_TIMEOUT_MS);

  if (provider === "cli") {
    log.info(`Using local CLI agent: ${cliCmd} (active subscription/session)`);
  } else {
    log.info(`Using LLM provider: ${provider} (model: ${model})`);
  }

  const allowUnsandboxedCli = !!args.allowUnsandboxedCli;

  return { provider, model, apiKey, cliCmd, apiBase, customHeaders, timeoutMs, allowUnsandboxedCli, stream: !!args.stream };
}

// ─── Multi-provider selection (--providers) ─────────────────────────────────

// Family token → provider family. Diversity is keyed on FAMILY, not provider id.
// `cursor` / `agent` are intentionally NOT multi-provider families: the Cursor
// Agent CLI can route to openai/anthropic models, so counting it as an
// independent family would fake diversity. Single-provider: --provider cursor|agent.
// Vercel AI Gateway is a TRANSPORT (provider id `vercel`), not a diversity family.
const TOKEN_FAMILY = {
  gpt: "openai", openai: "openai", codex: "openai",
  claude: "anthropic", anthropic: "anthropic",
  gemini: "gemini", agy: "gemini"
};

// Tokens that are the NAME of a local CLI binary. Naming one is an explicit request
// for that on-host CLI, so it resolves CLI-only and is NEVER silently upgraded to
// the family's API (which would send the diff off-host despite the user's intent).
// Their family label is still used for diversity grouping.
const CLI_ONLY_TOKENS = new Set(["codex", "claude", "agy", "agent", "cursor-agent"]);

// Default Vercel AI Gateway model ids per diversity family (provider/model form).
export const GATEWAY_FAMILY_MODELS = {
  openai: "openai/gpt-5",
  anthropic: "anthropic/claude-sonnet-4.6",
  gemini: "google/gemini-2.5-pro"
};

// Ordered concrete candidates per family:
// native API key → Gateway (one-key multi-family) → local CLI.
const FAMILY_CANDIDATES = {
  openai: [
    { kind: "api", provider: "openai", envKeys: ["OPENAI_API_KEY"] },
    { kind: "gateway" },
    { kind: "cli", cliCmd: "codex" }
  ],
  anthropic: [
    { kind: "api", provider: "anthropic", envKeys: ["ANTHROPIC_API_KEY"] },
    { kind: "gateway" },
    { kind: "cli", cliCmd: "claude" }
  ],
  gemini: [
    { kind: "api", provider: "gemini", envKeys: ["GEMINI_API_KEY"] },
    { kind: "gateway" },
    { kind: "cli", cliCmd: "agy" }
  ]
};

// The family of the agent running this review, so auto-selection never picks the
// builder's own family (a same-family critic is not an independent verdict).
export function builderFamily() {
  if (process.env.CLAUDECODE || process.env.CLAUDE_CODE) return "anthropic";
  if (process.env.TERM_PROGRAM === "cursor") return "openai";
  // Antigravity (the `agy` CLI) runs Gemini-family models; exclude that family
  // from auto-selection so the critic isn't the builder's own family.
  if (process.env.ANTIGRAVITY_AGENT || process.env.ANTIGRAVITY_CONVERSATION_ID) return "gemini";
  return null;
}

// Resolve a single --providers token to a concrete, REACHABLE provider config.
// Returns { id, family, config } with config=null when nothing in the family is
// reachable (no API key and no installed CLI).
export function resolveProviderToken(token, args = {}, { allowApiKeyFallback = false } = {}) {
  const id = String(token).toLowerCase();
  const family = TOKEN_FAMILY[id] || null;
  // Each family resolves with its OWN credentials. A *generic* LLM_API_KEY is NOT
  // proof that a given family's API is reachable (an OpenAI key cannot auth Gemini),
  // so it never forces API mode. An *explicit* --api-key (args.apiKey) IS honored —
  // but only when a single family is requested (allowApiKeyFallback), so it can't be
  // blindly applied across families. Family-specific env keys always win.
  const build = (provider, apiKey = null) => ({
    id,
    family,
    config: { ...configureLLM({ ...args, provider, providers: undefined, apiKey }), id }
  });

  // Explicit local-CLI token: resolve to that CLI only, never the family API.
  if (CLI_ONLY_TOKENS.has(id)) {
    return isCmdInstalled(id) ? build(id) : { id, family, config: null };
  }

  if (family) {
    for (const cand of FAMILY_CANDIDATES[family]) {
      if (cand.kind === "api") {
        const matched = cand.envKeys.find((e) => envNonEmpty(e));
        const key = matched ? envNonEmpty(matched) : (allowApiKeyFallback && args.apiKey ? args.apiKey : null);
        if (key) return build(cand.provider, key);
      }
      if (cand.kind === "gateway") {
        const key = gatewayCredential();
        if (key) {
          const gwModel = GATEWAY_FAMILY_MODELS[family];
          return {
            id,
            family,
            config: {
              ...configureLLM({
                ...args,
                provider: "vercel",
                model: args.model || gwModel,
                providers: undefined,
                apiKey: key
              }),
              id
            }
          };
        }
      }
      if (cand.kind === "cli" && isCmdInstalled(cand.cliCmd)) {
        return build(cand.cliCmd);
      }
    }
    return { id, family, config: null };
  }
  // `cursor` is a single-provider alias for the Agent CLI — NOT the Cursor IDE
  // binary that often sits on PATH as `cursor`. Never treat that IDE shim as a
  // review provider (configureLLM would throw and abort --providers entirely).
  if (id === "cursor") {
    if (!resolveCursorAgentCmd()) return { id, family: null, config: null };
    return {
      id,
      family: null,
      config: { ...configureLLM({ ...args, provider: "cursor", providers: undefined }), id }
    };
  }
  // Unknown token: treat as a raw local CLI command if installed.
  if (isCmdInstalled(id)) return build(id);
  return { id, family: null, config: null };
}

// The local CLI that belongs to each family, for downgrading a non-inlinable API
// provider to its on-host CLI (which can inspect the repo) instead of dropping it.
const FAMILY_CLI = { openai: "codex", anthropic: "claude", gemini: "agy" };

// Return a CLI provider entry for `family` if its local CLI is installed, else null.
export function cliFallbackForFamily(family, args = {}) {
  const cliCmd = FAMILY_CLI[family];
  if (cliCmd && isCmdInstalled(cliCmd)) {
    return { id: cliCmd, family, config: { ...configureLLM({ ...args, provider: cliCmd, providers: undefined, apiKey: null }), id: cliCmd } };
  }
  return null;
}

// Resolve args.providers (an array of tokens, or the sentinel "auto") into the
// concrete set of reachable providers, plus under-satisfaction accounting (AC7).
export function selectProviders(args = {}) {
  const spec = args.providers;
  let tokens = [];
  let auto = false;
  if (spec === "auto") {
    auto = true;
    const exclude = builderFamily();
    tokens = ["openai", "anthropic", "gemini"].filter((f) => f !== exclude);
  } else if (Array.isArray(spec)) {
    tokens = spec;
  }

  // Diversity is measured in distinct FAMILIES — synonym tokens (gpt/openai)
  // collapse to one, so duplicates cannot inflate the quorum or fake under-
  // satisfaction. Unknown tokens (raw CLI commands) key on their own id.
  const familyKey = (t) => TOKEN_FAMILY[String(t).toLowerCase()] || String(t).toLowerCase();
  const requestedFamilies = new Set(tokens.map(familyKey));

  // An explicit --api-key is unambiguous only when a single family is requested.
  const allowApiKeyFallback = requestedFamilies.size === 1;
  const resolved = tokens.map((t) => resolveProviderToken(t, args, { allowApiKeyFallback }));
  const seen = new Set();
  const providers = [];
  for (const r of resolved) {
    if (!r.config) continue;
    const key = r.family || r.id;
    if (seen.has(key)) continue;
    seen.add(key);
    providers.push(r);
  }

  const requestedCount = requestedFamilies.size;
  const reachableCount = providers.length;
  // auto wants >=2 distinct families; explicit wants every requested family.
  const underSatisfied = auto ? reachableCount < 2 : reachableCount < requestedCount;
  return { providers, requestedCount, reachableCount, underSatisfied, auto };
}

// Loud notice (AC7) when fewer providers were reachable than requested. Returns
// null when the selection was fully satisfied. The verdict is NOT downgraded
// (R6 warn + proceed) — this message is the safeguard.
export function underSatisfiedNotice(sel) {
  if (!sel || !sel.underSatisfied) return null;
  return (
    `Under-satisfied multi-provider review: only ${sel.reachableCount} of ${sel.requestedCount} ` +
    `requested provider(s) contributed a result. Reviewer diversity is reduced — this result reflects ` +
    `${sel.reachableCount} provider(s), not the diversity you asked for.`
  );
}

function apiError(provider, status, bodyText, retryAfterMs = null) {
  const err = new Error(`${provider} API error (${status}): ${bodyText}`);
  err.status = status;
  if (retryAfterMs != null) err.retryAfterMs = retryAfterMs;
  return err;
}

// Parse Retry-After as seconds or HTTP-date. Cap waits so a hostile header cannot
// stall the gate indefinitely.
export function parseRetryAfterMs(headerValue, { now = Date.now(), capMs = 60_000 } = {}) {
  if (headerValue == null || headerValue === "") return null;
  const asNum = Number(headerValue);
  if (Number.isFinite(asNum) && asNum >= 0) return Math.min(asNum * 1000, capMs);
  const when = Date.parse(headerValue);
  if (!Number.isNaN(when)) return Math.min(Math.max(0, when - now), capMs);
  return null;
}

function retryWaitMs(err, fallbackDelay) {
  if (typeof err.retryAfterMs === "number" && err.retryAfterMs >= 0) return err.retryAfterMs;
  return fallbackDelay;
}

function truncationError(provider) {
  const err = new Error(
    `${provider} response was truncated by the output token limit before the JSON completed. ` +
      `Narrow the scope or lower --max-bytes so the review fits.`
  );
  err.noRetry = true;
  return err;
}

// Retry only failures that can plausibly succeed on a retry: rate limits,
// server errors, timeouts, and network-level failures. 4xx (bad request, bad
// key, bad model name) and truncation are deterministic — fail fast.
function isRetryable(err) {
  if (err.noRetry) return false;
  if (err.name === "AbortError") return true;
  if (typeof err.status === "number") return err.status === 429 || err.status >= 500;
  return true; // No status: fetch network error, DNS failure, etc.
}

// Universal LLM call wrapper with selective retry/backoff for API providers.
// When `schema` is provided, the provider's native structured-output mode is
// used (Anthropic forced tool-use, OpenAI strict json_schema, Gemini
// responseSchema) so well-formed JSON is enforced at the API layer, not by
// post-hoc text scraping.
export async function llmCall(config, prompt, systemInstruction = "", schema = null) {
  const { provider, model, apiKey, cliCmd, apiBase, customHeaders, timeoutMs, allowUnsandboxedCli, stream } = config;

  if (provider === "cli") {
    return callCliLLM(cliCmd, prompt, systemInstruction, schema, {
      timeoutMs: timeoutMs ?? DEFAULT_TIMEOUT_MS,
      allowUnsandboxedCli: !!allowUnsandboxedCli,
      model,
      stream: !!stream
    });
  }

  let retries = 3;
  let delay = 1000;
  // Custom OpenAI-compatible gateways may not support strict json_schema;
  // remember a rejection and degrade to json_object for the rest of the run.
  let strictSchemaUnsupported = false;

  while (retries > 0) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs ?? DEFAULT_TIMEOUT_MS);

    try {
      if (provider === "gemini") {
        // Tolerate custom bases that already include the version segment
        // (e.g. a gateway configured as https://proxy/gemini/v1beta).
        const base = apiBase.replace(/\/$/, "").replace(/\/v1(?:beta)?$/, "");
        const url = `${base}/v1beta/models/${model}:generateContent`;
        const body = {
          contents: [{ role: "user", parts: [{ text: prompt }] }],
          systemInstruction: systemInstruction ? { parts: [{ text: systemInstruction }] } : undefined,
          generationConfig: schema
            ? {
                responseMimeType: "application/json",
                responseSchema: sanitizeSchemaForProvider(schema, { extraDrop: ["additionalProperties"] })
              }
            : undefined
        };
        const headers = {
          "Content-Type": "application/json",
          ...customHeaders
        };
        if (apiKey) {
          // Header, not query string: a key in the URL leaks into proxy and
          // access logs and error messages.
          headers["x-goog-api-key"] = apiKey;
        }
        const res = await fetch(url, {
          method: "POST",
          headers,
          body: JSON.stringify(body),
          signal: controller.signal
        });
        if (!res.ok) {
          const bodyText = await res.text();
          throw apiError("Gemini", res.status, bodyText, parseRetryAfterMs(res.headers.get("retry-after")));
        }
        const data = await res.json();
        const candidate = data.candidates?.[0];
        if (!candidate?.content?.parts) {
          throw new Error("Invalid response format from Gemini API: " + JSON.stringify(data));
        }
        if (candidate.finishReason === "MAX_TOKENS") throw truncationError("Gemini");
        return candidate.content.parts.map((p) => p.text || "").join("");
      } else if (provider === "openai" || provider === "vercel") {
        // vercel (AI Gateway) shares the OpenAI Chat Completions client, including
        // strict json_schema with automatic degrade to json_object for gateways
        // that reject it.
        const url = `${apiBase.replace(/\/$/, "")}/chat/completions`;
        const headers = {
          "Content-Type": "application/json",
          ...customHeaders
        };
        if (apiKey) {
          headers["Authorization"] = `Bearer ${apiKey}`;
        }
        const label = provider === "vercel" ? "Vercel AI Gateway" : "OpenAI";
        let responseFormat;
        if (schema) {
          responseFormat =
            !strictSchemaUnsupported
              ? {
                  type: "json_schema",
                  json_schema: { name: "adversarial_review", strict: true, schema: sanitizeSchemaForProvider(schema) }
                }
              : { type: "json_object" };
        }
        const res = await fetch(url, {
          method: "POST",
          headers,
          body: JSON.stringify({
            model,
            messages: [
              ...(systemInstruction ? [{ role: "system", content: systemInstruction }] : []),
              { role: "user", content: prompt }
            ],
            response_format: responseFormat
          }),
          signal: controller.signal
        });
        if (!res.ok) {
          const text = await res.text();
          if (
            res.status === 400 &&
            schema &&
            !strictSchemaUnsupported &&
            /response_format|json_schema/i.test(text)
          ) {
            log.warn("Endpoint rejected strict json_schema output; degrading to json_object mode.");
            strictSchemaUnsupported = true;
            retries--; // The degraded re-attempt counts against the retry budget.
            if (retries === 0) throw apiError(label, res.status, text);
            continue;
          }
          throw apiError(label, res.status, text, parseRetryAfterMs(res.headers.get("retry-after")));
        }
        const data = await res.json();
        const choice = data.choices?.[0];
        if (!choice?.message) {
          throw new Error(`Invalid response format from ${label} API: ` + JSON.stringify(data));
        }
        if (choice.finish_reason === "length") throw truncationError(label);
        return choice.message.content;
      } else if (provider === "anthropic") {
        const url = `${apiBase.replace(/\/$/, "")}/messages`;
        const headers = {
          "Content-Type": "application/json",
          "anthropic-version": "2023-06-01",
          ...customHeaders
        };
        if (apiKey) {
          headers["x-api-key"] = apiKey;
        }
        const body = {
          model,
          messages: [{ role: "user", content: prompt }],
          system: systemInstruction || undefined,
          max_tokens: 16000
        };
        if (schema) {
          body.tools = [
            {
              name: "submit_review",
              description: "Submit the structured adversarial review result.",
              input_schema: sanitizeSchemaForProvider(schema, { keepConstraints: true })
            }
          ];
          body.tool_choice = { type: "tool", name: "submit_review" };
        }
        const res = await fetch(url, {
          method: "POST",
          headers,
          body: JSON.stringify(body),
          signal: controller.signal
        });
        if (!res.ok) {
          const bodyText = await res.text();
          throw apiError("Anthropic", res.status, bodyText, parseRetryAfterMs(res.headers.get("retry-after")));
        }
        const data = await res.json();
        if (data.stop_reason === "max_tokens") throw truncationError("Anthropic");
        const toolUse = Array.isArray(data.content) ? data.content.find((b) => b.type === "tool_use") : null;
        if (toolUse) return JSON.stringify(toolUse.input);
        const textBlock = Array.isArray(data.content) ? data.content.find((b) => b.type === "text") : null;
        if (!textBlock) {
          throw new Error("Invalid response format from Anthropic API: " + JSON.stringify(data));
        }
        return textBlock.text;
      } else {
        const err = new Error(`Unsupported provider in llmCall: "${provider}"`);
        err.noRetry = true;
        throw err;
      }
    } catch (err) {
      const isTimeout = err.name === "AbortError";
      const errorMsg = isTimeout ? `request timed out after ${(timeoutMs ?? DEFAULT_TIMEOUT_MS) / 1000}s` : err.message;
      if (!isRetryable(err)) {
        throw new Error(errorMsg);
      }
      retries--;
      if (retries === 0) throw new Error(`LLM call failed: ${errorMsg}`);
      const wait = retryWaitMs(err, delay);
      log.warn(`LLM call failed: ${errorMsg}. Retrying in ${wait}ms...`);
      await new Promise((resolve) => setTimeout(resolve, wait));
      delay *= 2;
    } finally {
      clearTimeout(timeoutId);
    }
  }
}
