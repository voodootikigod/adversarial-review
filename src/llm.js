import { execFileSync } from "child_process";
import fs from "fs";
import path from "path";
import { log } from "./utils.js";

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
function isCmdInstalled(cmd) {
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

function cliFallbackArgs(cliCmd, fullPrompt) {
  if (cliCmd === "claude") return ["-p", fullPrompt];
  if (cliCmd === "codex") return ["exec", fullPrompt];
  return [fullPrompt];
}

// Invoke a local CLI agent (claude, codex, gemini, ...) by piping the prompt to stdin.
function callCliLLM(cliCmd, prompt, systemInstruction) {
  let fullPrompt = "";
  if (systemInstruction) {
    fullPrompt += `System Instructions:\n${systemInstruction}\n\n`;
  }
  fullPrompt += `Prompt:\n${prompt}`;

  log.step(`Invoking local subscription agent via command: "${cliCmd}"...`);

  try {
    return execCli(cliCmd, [], fullPrompt);
  } catch (err) {
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
      } else if (isCmdInstalled("gemini")) {
        provider = "cli";
        cliCmd = "gemini";
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
            "or install a local CLI agent (claude, codex, or gemini).\n" +
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
      } else if (isCmdInstalled("gemini")) {
        provider = "cli";
        cliCmd = "gemini";
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
      } else if (isCmdInstalled("gemini")) {
        provider = "cli";
        cliCmd = "gemini";
      } else {
        throw new Error(
          "No LLM configuration found.\n" +
          "Set an API key (ANTHROPIC_API_KEY, GEMINI_API_KEY, or OPENAI_API_KEY),\n" +
          "or install a local CLI agent (claude, codex, or gemini).\n" +
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
    if (provider === "gemini") {
      model = "gemini-2.5-flash";
    } else if (provider === "openai") {
      model = "gpt-4o";
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

  if (provider === "cli") {
    log.info(`Using local CLI agent: ${cliCmd} (active subscription/session)`);
  } else {
    log.info(`Using LLM provider: ${provider} (model: ${model})`);
  }

  return { provider, model, apiKey, cliCmd, apiBase, customHeaders };
}

// Universal LLM call wrapper with retry/backoff for API providers.
export async function llmCall(config, prompt, systemInstruction = "", jsonMode = false) {
  const { provider, model, apiKey, cliCmd, apiBase, customHeaders } = config;

  if (provider === "cli") {
    return callCliLLM(cliCmd, prompt, systemInstruction);
  }

  let retries = 3;
  let delay = 1000;

  while (retries > 0) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 60000);

    try {
      if (provider === "gemini") {
        let url = `${apiBase.replace(/\/$/, "")}/v1beta/models/${model}:generateContent`;
        if (apiKey) {
          url += `?key=${apiKey}`;
        }
        const body = {
          contents: [{ role: "user", parts: [{ text: prompt }] }],
          systemInstruction: systemInstruction ? { parts: [{ text: systemInstruction }] } : undefined,
          generationConfig: jsonMode ? { responseMimeType: "application/json" } : undefined
        };
        const headers = {
          "Content-Type": "application/json",
          ...customHeaders
        };
        const res = await fetch(url, {
          method: "POST",
          headers,
          body: JSON.stringify(body),
          signal: controller.signal
        });
        if (!res.ok) throw new Error(`Gemini API error (${res.status}): ${await res.text()}`);
        const data = await res.json();
        if (!data.candidates?.[0]?.content?.parts) {
          throw new Error("Invalid response format from Gemini API: " + JSON.stringify(data));
        }
        return data.candidates[0].content.parts[0].text;
      } else if (provider === "openai" || provider === "cursor") {
        const url = `${apiBase.replace(/\/$/, "")}/chat/completions`;
        const headers = {
          "Content-Type": "application/json",
          ...customHeaders
        };
        if (apiKey) {
          headers["Authorization"] = `Bearer ${apiKey}`;
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
            response_format: jsonMode ? { type: "json_object" } : undefined
          }),
          signal: controller.signal
        });
        if (!res.ok) throw new Error(`${provider === "cursor" ? "Cursor" : "OpenAI"} API error (${res.status}): ${await res.text()}`);
        const data = await res.json();
        return data.choices[0].message.content;
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
        const res = await fetch(url, {
          method: "POST",
          headers,
          body: JSON.stringify({
            model,
            messages: [{ role: "user", content: prompt }],
            system: systemInstruction || undefined,
            max_tokens: 8000
          }),
          signal: controller.signal
        });
        if (!res.ok) throw new Error(`Anthropic API error (${res.status}): ${await res.text()}`);
        const data = await res.json();
        return data.content[0].text;
      }
    } catch (err) {
      const isTimeout = err.name === "AbortError";
      const errorMsg = isTimeout ? "request timed out after 60s" : err.message;
      retries--;
      if (retries === 0) throw new Error(isTimeout ? `LLM call failed: ${errorMsg}` : err.message);
      log.warn(`LLM call failed: ${errorMsg}. Retrying in ${delay}ms...`);
      await new Promise((resolve) => setTimeout(resolve, delay));
      delay *= 2;
    } finally {
      clearTimeout(timeoutId);
    }
  }
}
