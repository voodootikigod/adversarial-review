import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { colors } from "./utils.js";
import { llmCall, cleanJsonResponse } from "./llm.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");

export function loadAsset(name) {
  return fs.readFileSync(path.join(ROOT, name), "utf8");
}

// Fill the template placeholders with the collected context.
export function buildPrompt(context, focus) {
  const template = loadAsset("prompt-template.md");
  const vars = {
    TARGET_LABEL: context.label,
    USER_FOCUS: focus && focus.trim() ? focus.trim() : "No extra focus provided.",
    REVIEW_COLLECTION_GUIDANCE: context.collectionGuidance,
    REVIEW_INPUT: context.content
  };
  return template.replace(/\{\{(\w+)\}\}/g, (match, key) =>
    key in vars ? vars[key] : match
  );
}

// Minimal validation against the structural contract in schema.json.
export function validateResult(result) {
  const errors = [];
  if (!result || typeof result !== "object") {
    return ["result is not an object"];
  }
  if (!["approve", "needs-attention"].includes(result.verdict)) {
    errors.push(`verdict must be "approve" or "needs-attention" (got ${JSON.stringify(result.verdict)})`);
  }
  if (typeof result.summary !== "string" || !result.summary.length) {
    errors.push("summary must be a non-empty string");
  }
  if (!Array.isArray(result.findings)) {
    errors.push("findings must be an array");
  } else {
    result.findings.forEach((f, i) => {
      if (!["critical", "high", "medium", "low"].includes(f?.severity)) {
        errors.push(`findings[${i}].severity invalid`);
      }
      for (const field of ["title", "body", "file", "recommendation"]) {
        if (typeof f?.[field] !== "string") errors.push(`findings[${i}].${field} must be a string`);
      }
      if (!Number.isInteger(f?.line_start)) errors.push(`findings[${i}].line_start must be an integer`);
      if (!Number.isInteger(f?.line_end)) errors.push(`findings[${i}].line_end must be an integer`);
      if (typeof f?.confidence !== "number" || f.confidence < 0 || f.confidence > 1) {
        errors.push(`findings[${i}].confidence must be a number in [0,1]`);
      }
    });
  }
  if (!Array.isArray(result.next_steps)) {
    errors.push("next_steps must be an array");
  }
  return errors;
}

const SEVERITY_COLOR = {
  critical: colors.red,
  high: colors.red,
  medium: colors.yellow,
  low: colors.gray
};

// Render a human-readable report from a validated result.
export function renderReport(result, context) {
  const lines = [];
  const verdictBadge =
    result.verdict === "approve"
      ? colors.green(colors.bold(" APPROVE "))
      : colors.red(colors.bold(" NEEDS ATTENTION "));

  lines.push("");
  lines.push(`${verdictBadge}  ${colors.dim(context.label)}`);
  lines.push("");
  lines.push(colors.bold("Summary"));
  lines.push(`  ${result.summary}`);

  if (result.findings.length) {
    lines.push("");
    lines.push(colors.bold(`Findings (${result.findings.length})`));
    const order = { critical: 0, high: 1, medium: 2, low: 3 };
    const sorted = [...result.findings].sort((a, b) => order[a.severity] - order[b.severity]);
    for (const f of sorted) {
      const sev = (SEVERITY_COLOR[f.severity] || colors.gray)(f.severity.toUpperCase().padEnd(8));
      const conf = colors.dim(`conf ${f.confidence.toFixed(2)}`);
      lines.push("");
      lines.push(`  ${sev} ${colors.bold(f.title)}  ${conf}`);
      lines.push(`    ${colors.cyan(`${f.file}:${f.line_start}-${f.line_end}`)}`);
      for (const l of f.body.split("\n")) lines.push(`    ${l}`);
      lines.push(`    ${colors.green("→ fix:")} ${f.recommendation}`);
    }
  } else {
    lines.push("");
    lines.push(colors.dim("  No material adversarial findings."));
  }

  if (result.next_steps?.length) {
    lines.push("");
    lines.push(colors.bold("Next steps"));
    for (const s of result.next_steps) lines.push(`  • ${s}`);
  }
  lines.push("");
  return lines.join("\n");
}

// Run the LLM, parse and validate, retrying once with a stricter nudge on malformed JSON.
export async function runReview(config, prompt) {
  const schema = loadAsset("schema.json");
  const systemInstruction =
    "You are an adversarial software reviewer. Return ONLY a single JSON object — no prose, " +
    "no markdown fences — that conforms exactly to this JSON Schema:\n" +
    schema;

  let raw = await llmCall(config, prompt, systemInstruction, true);
  let parsed;
  try {
    parsed = JSON.parse(cleanJsonResponse(raw));
  } catch {
    const retryPrompt =
      prompt +
      "\n\nYour previous output was not valid JSON. Return ONLY the JSON object, nothing else.";
    raw = await llmCall(config, retryPrompt, systemInstruction, true);
    parsed = JSON.parse(cleanJsonResponse(raw));
  }

  const errors = validateResult(parsed);
  if (errors.length) {
    throw new Error("Model output failed schema validation:\n  - " + errors.join("\n  - "));
  }
  return parsed;
}
