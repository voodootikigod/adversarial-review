import { execFileSync } from "child_process";
import fs from "fs";
import path from "path";
import { log } from "./utils.js";

// Robustly extract JSON from a model response, even if wrapped in prose or a markdown fence.
export function cleanJsonResponse(text) {
  let cleaned = text.trim();

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
    cleaned = cleaned.substring(startIdx, endIdx + 1);
  }

  if (cleaned.startsWith("```json")) {
    cleaned = cleaned.slice(7);
  } else if (cleaned.startsWith("```")) {
    cleaned = cleaned.slice(3);
  }
  if (cleaned.endsWith("```")) {
    cleaned = cleaned.slice(0, -3);
  }

  return cleaned.trim();
}

// Check if a shell command is installed and executable.
function isCmdInstalled(cmd) {
  if (!/^[A-Za-z0-9._-]+$/.test(cmd)) {
    return false;
  }
  const pathDirs = (process.env.PATH || "").split(path.delimiter).filter(Boolean);
  return pathDirs.some((dir) => {
    const candidate = path.join(dir, cmd);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return fs.statSync(candidate).isFile();
    } catch {
      return false;
    }
  });
}

function execCli(cliCmd, args, input = null) {
  return execFileSync(cliCmd, args, {
    input,
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
    maxBuffer: 10 * 1024 * 1024,
    timeout: 10 * 60 * 1000
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
  } else {
    const knownApis = ["gemini", "openai", "anthropic"];
    if (!knownApis.includes(provider)) {
      if (isCmdInstalled(provider)) {
        cliCmd = provider;
        provider = "cli";
      } else {
        throw new Error(`Provider CLI command "${provider}" is not installed or available in PATH.`);
      }
    }
  }

  if (provider === "gemini") {
    apiKey = process.env.GEMINI_API_KEY;
  } else if (provider === "openai") {
    apiKey = process.env.OPENAI_API_KEY;
  } else if (provider === "anthropic") {
    apiKey = process.env.ANTHROPIC_API_KEY;
  }

  if (provider !== "cli" && !apiKey) {
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
    }
  }

  if (provider === "cli") {
    log.info(`Using local CLI agent: ${cliCmd} (active subscription/session)`);
  } else {
    log.info(`Using LLM provider: ${provider} (model: ${model})`);
  }

  return { provider, model, apiKey, cliCmd };
}

// Universal LLM call wrapper with retry/backoff for API providers.
export async function llmCall(config, prompt, systemInstruction = "", jsonMode = false) {
  const { provider, model, apiKey, cliCmd } = config;

  if (provider === "cli") {
    return callCliLLM(cliCmd, prompt, systemInstruction);
  }

  let retries = 3;
  let delay = 1000;

  while (retries > 0) {
    try {
      if (provider === "gemini") {
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
        const body = {
          contents: [{ role: "user", parts: [{ text: prompt }] }],
          systemInstruction: systemInstruction ? { parts: [{ text: systemInstruction }] } : undefined,
          generationConfig: jsonMode ? { responseMimeType: "application/json" } : undefined
        };
        const res = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body)
        });
        if (!res.ok) throw new Error(`Gemini API error (${res.status}): ${await res.text()}`);
        const data = await res.json();
        if (!data.candidates?.[0]?.content?.parts) {
          throw new Error("Invalid response format from Gemini API: " + JSON.stringify(data));
        }
        return data.candidates[0].content.parts[0].text;
      } else if (provider === "openai") {
        const res = await fetch("https://api.openai.com/v1/chat/completions", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
          body: JSON.stringify({
            model,
            messages: [
              ...(systemInstruction ? [{ role: "system", content: systemInstruction }] : []),
              { role: "user", content: prompt }
            ],
            response_format: jsonMode ? { type: "json_object" } : undefined
          })
        });
        if (!res.ok) throw new Error(`OpenAI API error (${res.status}): ${await res.text()}`);
        const data = await res.json();
        return data.choices[0].message.content;
      } else if (provider === "anthropic") {
        const res = await fetch("https://api.anthropic.com/v1/messages", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-api-key": apiKey,
            "anthropic-version": "2023-06-01"
          },
          body: JSON.stringify({
            model,
            messages: [{ role: "user", content: prompt }],
            system: systemInstruction || undefined,
            max_tokens: 8000
          })
        });
        if (!res.ok) throw new Error(`Anthropic API error (${res.status}): ${await res.text()}`);
        const data = await res.json();
        return data.content[0].text;
      }
    } catch (err) {
      retries--;
      if (retries === 0) throw err;
      log.warn(`LLM call failed: ${err.message}. Retrying in ${delay}ms...`);
      await new Promise((resolve) => setTimeout(resolve, delay));
      delay *= 2;
    }
  }
}
