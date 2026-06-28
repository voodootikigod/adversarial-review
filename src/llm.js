import { execFileSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { log } from "./utils.js";
import { sanitizeSchemaForProvider } from "./schema-validate.js";

const DEFAULT_TIMEOUT_MS = 120 * 1000;
// Conservative argv-size guard: macOS caps a single argument well below Linux's
// ARG_MAX; past this we refuse the argv fallback rather than fail with E2BIG.
const MAX_ARGV_PROMPT_BYTES = 100 * 1024;

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

// Check if a shell command is installed and executable.
export function isCmdInstalled(cmd) {
  if (!/^[A-Za-z0-9._-]+$/.test(cmd)) {
    return false;
  }
  const pathDirs = (process.env.PATH || "").split(path.delimiter).filter(Boolean);
  const extensions = process.platform === "win32"
    ? (process.env.PATHEXT || ".EXE;.CMD;.BAT;.COM").split(";").map(ext => ext.toLowerCase())
    : [""];

  return pathDirs.some((dir) => {
    for (const ext of extensions) {
      const file = ext && cmd.toLowerCase().endsWith(ext) ? cmd : `${cmd}${ext}`;
      const candidate = path.join(dir, file);
      try {
        fs.accessSync(candidate, fs.constants.X_OK);
        if (fs.statSync(candidate).isFile()) {
          return true;
        }
      } catch {
        // Continue
      }
    }
    return false;
  });
}

function execCli(cliCmd, args, input = null) {
  return execFileSync(cliCmd, args, {
    input,
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
    maxBuffer: 10 * 1024 * 1024,
    timeout: 10 * 60 * 1000,
    shell: process.platform === "win32"
  }).trim();
}

export function cliFallbackArgs(cliCmd, fullPrompt) {
  // claude and agy are Claude-Code-compatible: they need -p (print mode) when
  // the prompt is passed as a command-line argument.
  if (cliCmd === "claude" || cliCmd === "agy") return ["-p", fullPrompt];
  return [fullPrompt];
}

// Invoke the Codex CLI non-interactively via `codex exec`.
// Uses --output-last-message to capture only the final agent response (not the
// full JSONL event stream), and --output-schema when a JSON Schema is provided
// so Codex enforces the output shape natively rather than relying on scraping.
// The prompt is piped via stdin (`-`) to avoid argv size limits on large diffs;
// the argv path is used as a fallback if stdin is rejected.
function callCodexCli(fullPrompt, schema) {
  // Create a private temp directory so path prediction / symlink race attacks
  // against shared /tmp are not possible; the directory is owned by this process.
  const privateDir = fs.mkdtempSync(path.join(os.tmpdir(), "adv-review-codex-"));
  const outFile = path.join(privateDir, "out.txt");
  const schemaFile = schema ? path.join(privateDir, "schema.json") : null;

  try {
    // wx flag: exclusive create — fails if the file already exists (defense in depth
    // inside the already-private directory).
    if (schemaFile) fs.writeFileSync(schemaFile, JSON.stringify(schema), { mode: 0o600, flag: "wx" });

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
      execCli("codex", [...baseArgs, "-"], fullPrompt);
    } catch (stdinErr) {
      if (Buffer.byteLength(fullPrompt) > MAX_ARGV_PROMPT_BYTES) {
        const stderr = stdinErr.stderr?.toString("utf8").trim() || "";
        throw new Error(
          `Codex rejected the prompt on stdin, and the prompt is too large ` +
            `(${Buffer.byteLength(fullPrompt)} bytes) to pass as a command-line argument. ` +
            `Lower --max-bytes, narrow the scope, or use an API provider.` +
            (stderr ? `\n${stderr}` : "")
        );
      }
      // Argv fallback: pass prompt as positional argument
      log.substep("Codex stdin path failed, retrying as argument...");
      try {
        execCli("codex", [...baseArgs, fullPrompt]);
      } catch (argvErr) {
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
function callCliLLM(cliCmd, prompt, systemInstruction, schema = null) {
  let fullPrompt = "";
  if (systemInstruction) {
    fullPrompt += `System Instructions:\n${systemInstruction}\n\n`;
  }
  fullPrompt += `Prompt:\n${prompt}`;

  log.step(`Invoking local subscription agent via command: "${cliCmd}"...`);

  if (cliCmd === "codex") {
    return callCodexCli(fullPrompt, schema);
  }

  // agy is a Claude-Code-compatible CLI: it must run in -p (print) mode reading
  // the prompt from the `-` stdin sentinel. A bare `agy` invocation would launch
  // interactively and hang until the subprocess timeout.
  const primaryArgs = cliCmd === "agy" ? ["-p", "-"] : [];

  try {
    return execCli(cliCmd, primaryArgs, fullPrompt);
  } catch (err) {
    if (Buffer.byteLength(fullPrompt) > MAX_ARGV_PROMPT_BYTES) {
      const stderr = err.stderr?.toString("utf8").trim() || "";
      throw new Error(
        `Local CLI agent "${cliCmd}" rejected the prompt on stdin, and the prompt is too large ` +
          `(${Buffer.byteLength(fullPrompt)} bytes) to pass as a command-line argument. ` +
          `Lower --max-bytes, narrow the scope, or use an API provider.` +
          (stderr ? `\n${stderr}` : "")
      );
    }
    try {
      log.substep(`Stdin piping not supported by ${cliCmd}, retrying as argument...`);
      return execCli(cliCmd, cliFallbackArgs(cliCmd, fullPrompt));
    } catch (err2) {
      const stderr = err2.stderr?.toString("utf8") || err.stderr?.toString("utf8") || "";
      const suffix = stderr.trim() ? `\n${stderr.trim()}` : "";
      throw new Error(`Failed to execute local CLI agent "${cliCmd}": ${err2.message || err.message}${suffix}`);
    }
  }
}

// Resolve the LLM provider from flags, environment variables, or an installed local CLI agent.
export function configureLLM(args) {
  let provider = args.provider;
  let apiKey = null;
  let cliCmd = null;

  if (!provider) {
    const isClaudeCodeEnv = !!(process.env.CLAUDECODE || process.env.CLAUDE_CODE);
    const isCursorEnv = process.env.TERM_PROGRAM === "cursor";

    if (isClaudeCodeEnv) {
      // Builder is Claude. Try to find a non-Claude/Anthropic critic to break the monoculture.
      if (process.env.GEMINI_API_KEY) {
        provider = "gemini";
      } else if (process.env.OPENAI_API_KEY) {
        provider = "openai";
      } else if (isCmdInstalled("codex")) {
        provider = "cli";
        cliCmd = "codex";
      } else if (isCmdInstalled("agy")) {
        provider = "cli";
        cliCmd = "agy";
      } else {
        // Fall back to Claude/Anthropic if nothing else is available
        if (process.env.ANTHROPIC_API_KEY) {
          provider = "anthropic";
        } else if (isCmdInstalled("claude")) {
          provider = "cli";
          cliCmd = "claude";
        } else {
          throw new Error(
            "No LLM configuration found.\n" +
            "Set an API key (ANTHROPIC_API_KEY, GEMINI_API_KEY, or OPENAI_API_KEY),\n" +
            "or install a local CLI agent (claude, codex, or agy).\n" +
            "Or run with --prompt-only to just print the prompt."
          );
        }
        log.warn("Running in Claude Code, but fell back to Claude for review.");
        log.info("This review is not a pure adversarial review (same provider). To minimize bias, we will execute it in a fresh, isolated context window.");
      }
    } else if (isCursorEnv) {
      // Builder is likely Cursor (OpenAI/Claude). Try to find an independent critic first.
      if (process.env.GEMINI_API_KEY) {
        provider = "gemini";
      } else if (process.env.ANTHROPIC_API_KEY) {
        provider = "anthropic";
      } else if (process.env.OPENAI_API_KEY) {
        provider = "openai";
      } else if (isCmdInstalled("agy")) {
        provider = "cli";
        cliCmd = "agy";
      } else if (isCmdInstalled("claude")) {
        provider = "cli";
        cliCmd = "claude";
      } else if (isCmdInstalled("codex")) {
        provider = "cli";
        cliCmd = "codex";
      } else {
        // Default to Cursor's local proxy if no independent options are available
        provider = "cursor";
        log.warn("Running in Cursor, but fell back to Cursor's local LLM proxy.");
        log.info("This review is not a pure adversarial review (same provider). To minimize bias, we will execute it in a fresh, isolated context window.");
      }
    } else {
      // Default auto-detection order (Anthropic > Gemini > OpenAI > Local CLI agents)
      if (process.env.ANTHROPIC_API_KEY) {
        provider = "anthropic";
      } else if (process.env.GEMINI_API_KEY) {
        provider = "gemini";
      } else if (process.env.OPENAI_API_KEY) {
        provider = "openai";
      } else if (isCmdInstalled("claude")) {
        provider = "cli";
        cliCmd = "claude";
      } else if (isCmdInstalled("codex")) {
        provider = "cli";
        cliCmd = "codex";
      } else if (isCmdInstalled("agy")) {
        provider = "cli";
        cliCmd = "agy";
      } else {
        throw new Error(
          "No LLM configuration found.\n" +
          "Set an API key (ANTHROPIC_API_KEY, GEMINI_API_KEY, or OPENAI_API_KEY),\n" +
          "or install a local CLI agent (claude, codex, or agy).\n" +
          "Or run with --prompt-only to just print the prompt."
        );
      }
    }
  } else {
    const knownApis = ["gemini", "openai", "anthropic", "cursor"];
    if (!knownApis.includes(provider)) {
      if (isCmdInstalled(provider)) {
        cliCmd = provider;
        provider = "cli";
      } else {
        throw new Error(`Provider CLI command "${provider}" is not installed or available in PATH.`);
      }
    }
  }

  // Resolve API Key (CLI flag > LLM_API_KEY > provider-specific env var)
  apiKey = args.apiKey || process.env.LLM_API_KEY;
  if (!apiKey) {
    if (provider === "gemini") {
      apiKey = process.env.GEMINI_API_KEY;
    } else if (provider === "openai") {
      apiKey = process.env.OPENAI_API_KEY;
    } else if (provider === "anthropic") {
      apiKey = process.env.ANTHROPIC_API_KEY;
    } else if (provider === "cursor") {
      apiKey = process.env.OPENAI_API_KEY || "dummy";
    }
  }

  // Resolve API Base URL (CLI flag > provider-specific env var > default)
  let apiBase = args.apiBase;
  if (!apiBase) {
    if (provider === "openai") {
      apiBase = process.env.OPENAI_API_BASE || process.env.OPENAI_BASE_URL || "https://api.openai.com/v1";
    } else if (provider === "anthropic") {
      apiBase = process.env.ANTHROPIC_API_BASE || process.env.ANTHROPIC_BASE_URL || "https://api.anthropic.com/v1";
    } else if (provider === "gemini") {
      apiBase = process.env.GEMINI_API_BASE || process.env.GEMINI_BASE_URL || "https://generativelanguage.googleapis.com";
    } else if (provider === "cursor") {
      apiBase = "http://127.0.0.1:8765/v1";
    }
  }

  const isCustomBase = !!(args.apiBase ||
    (provider === "openai" && (process.env.OPENAI_API_BASE || process.env.OPENAI_BASE_URL)) ||
    (provider === "anthropic" && (process.env.ANTHROPIC_API_BASE || process.env.ANTHROPIC_BASE_URL)) ||
    (provider === "gemini" && (process.env.GEMINI_API_BASE || process.env.GEMINI_BASE_URL))
  );

  if (provider !== "cli" && !apiKey && !isCustomBase && provider !== "cursor") {
    throw new Error(`Provider "${provider}" requested but corresponding API key is not set in environment.`);
  }

  let model = args.model;
  if (!model && provider !== "cli") {
    // Gate quality tracks model tier — default to the strong tier of each
    // provider, not the cheap one. Override with --model for cost control.
    if (provider === "gemini") {
      model = "gemini-2.5-pro";
    } else if (provider === "openai") {
      model = "gpt-5";
    } else if (provider === "anthropic") {
      model = "claude-sonnet-4-6";
    } else if (provider === "cursor") {
      model = "gpt-4o";
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
    : DEFAULT_TIMEOUT_MS;

  if (provider === "cli") {
    log.info(`Using local CLI agent: ${cliCmd} (active subscription/session)`);
  } else {
    log.info(`Using LLM provider: ${provider} (model: ${model})`);
  }

  return { provider, model, apiKey, cliCmd, apiBase, customHeaders, timeoutMs };
}

// ─── Multi-provider selection (--providers) ─────────────────────────────────

// Family token → provider family. Diversity is keyed on FAMILY, not provider id.
const TOKEN_FAMILY = {
  gpt: "openai", openai: "openai", codex: "openai",
  claude: "anthropic", anthropic: "anthropic",
  gemini: "gemini", agy: "gemini"
};

// Ordered concrete candidates per family: prefer the API (key present) over the
// local CLI, mirroring the single-provider auto-detection bias.
const FAMILY_CANDIDATES = {
  openai: [{ kind: "api", provider: "openai", envKeys: ["OPENAI_API_KEY"] }, { kind: "cli", cliCmd: "codex" }],
  anthropic: [{ kind: "api", provider: "anthropic", envKeys: ["ANTHROPIC_API_KEY"] }, { kind: "cli", cliCmd: "claude" }],
  gemini: [{ kind: "api", provider: "gemini", envKeys: ["GEMINI_API_KEY"] }, { kind: "cli", cliCmd: "agy" }]
};

// The family of the agent running this review, so auto-selection never picks the
// builder's own family (a same-family critic is not an independent verdict).
export function builderFamily() {
  if (process.env.CLAUDECODE || process.env.CLAUDE_CODE) return "anthropic";
  if (process.env.TERM_PROGRAM === "cursor") return "openai";
  return null;
}

// Resolve a single --providers token to a concrete, REACHABLE provider config.
// Returns { id, family, config } with config=null when nothing in the family is
// reachable (no API key and no installed CLI).
export function resolveProviderToken(token, args = {}) {
  const id = String(token).toLowerCase();
  const family = TOKEN_FAMILY[id] || null;
  // Each family resolves with its OWN credentials. A generic --api-key / LLM_API_KEY
  // is NOT proof that a given family's API is reachable (an OpenAI key cannot auth
  // Gemini), so it must never force API mode or skip a working CLI fallback. We pass
  // the matched family key explicitly and suppress the generic override.
  const build = (provider, apiKey = null) => ({
    id,
    family,
    config: { ...configureLLM({ ...args, provider, providers: undefined, apiKey }), id }
  });

  if (family) {
    for (const cand of FAMILY_CANDIDATES[family]) {
      if (cand.kind === "api") {
        const matched = cand.envKeys.find((e) => process.env[e]);
        if (matched) return build(cand.provider, process.env[matched]);
      }
      if (cand.kind === "cli" && isCmdInstalled(cand.cliCmd)) {
        return build(cand.cliCmd);
      }
    }
    return { id, family, config: null };
  }
  // Unknown token: treat as a raw local CLI command if installed.
  if (isCmdInstalled(id)) return build(id);
  return { id, family: null, config: null };
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

  const resolved = tokens.map((t) => resolveProviderToken(t, args));
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
    `requested provider(s) were reachable. Reviewer diversity is reduced — this result reflects ` +
    `${sel.reachableCount} provider(s), not the diversity you asked for.`
  );
}

function apiError(provider, status, bodyText) {
  const err = new Error(`${provider} API error (${status}): ${bodyText}`);
  err.status = status;
  return err;
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
  const { provider, model, apiKey, cliCmd, apiBase, customHeaders, timeoutMs } = config;

  if (provider === "cli") {
    return callCliLLM(cliCmd, prompt, systemInstruction, schema);
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
        if (!res.ok) throw apiError("Gemini", res.status, await res.text());
        const data = await res.json();
        const candidate = data.candidates?.[0];
        if (!candidate?.content?.parts) {
          throw new Error("Invalid response format from Gemini API: " + JSON.stringify(data));
        }
        if (candidate.finishReason === "MAX_TOKENS") throw truncationError("Gemini");
        return candidate.content.parts.map((p) => p.text || "").join("");
      } else if (provider === "openai" || provider === "cursor") {
        const url = `${apiBase.replace(/\/$/, "")}/chat/completions`;
        const headers = {
          "Content-Type": "application/json",
          ...customHeaders
        };
        if (apiKey) {
          headers["Authorization"] = `Bearer ${apiKey}`;
        }
        let responseFormat;
        if (schema) {
          responseFormat =
            provider === "openai" && !strictSchemaUnsupported
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
            if (retries === 0) throw apiError("OpenAI", res.status, text);
            continue;
          }
          throw apiError(provider === "cursor" ? "Cursor" : "OpenAI", res.status, text);
        }
        const data = await res.json();
        const choice = data.choices?.[0];
        if (!choice?.message) {
          throw new Error(`Invalid response format from ${provider} API: ` + JSON.stringify(data));
        }
        if (choice.finish_reason === "length") throw truncationError("OpenAI");
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
        if (!res.ok) throw apiError("Anthropic", res.status, await res.text());
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
      log.warn(`LLM call failed: ${errorMsg}. Retrying in ${delay}ms...`);
      await new Promise((resolve) => setTimeout(resolve, delay));
      delay *= 2;
    } finally {
      clearTimeout(timeoutId);
    }
  }
}
