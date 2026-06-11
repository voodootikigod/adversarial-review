// ANSI escape-code helpers for terminal styling without external packages.
export const colors = {
  reset: (text) => `${text}\x1b[0m`,
  bold: (text) => `\x1b[1m${text}\x1b[22m`,
  dim: (text) => `\x1b[2m${text}\x1b[22m`,
  red: (text) => `\x1b[31m${text}\x1b[39m`,
  green: (text) => `\x1b[32m${text}\x1b[39m`,
  yellow: (text) => `\x1b[33m${text}\x1b[39m`,
  blue: (text) => `\x1b[34m${text}\x1b[39m`,
  magenta: (text) => `\x1b[35m${text}\x1b[39m`,
  cyan: (text) => `\x1b[36m${text}\x1b[39m`,
  gray: (text) => `\x1b[90m${text}\x1b[39m`
};

export const HELP_TEXT = `
${colors.bold("ADVERSARIAL REVIEW")}
Skeptical, ship/no-ship code review of a git diff or branch.
The reviewer's job is to break confidence in the change, not validate it.

${colors.bold("Usage:")}
  npx adversarial-review [options] [focus text...]
  (or: npx adv-review [options] [focus text...])

${colors.bold("Examples:")}
  npx adversarial-review                          # review uncommitted working tree
  npx adversarial-review --base main              # review current branch vs main
  npx adversarial-review "focus on the auth path" # working tree + focus area
  npx adversarial-review --prompt-only > p.txt    # just emit the prompt, no LLM call

${colors.bold("Options:")}
  --base <ref>          Review the current branch against <ref> (merge-base...HEAD).
  --scope <mode>        auto (default) | working-tree | branch.
  --prompt-only         Print the assembled prompt to stdout and exit (no LLM call).
  --json                Print the raw JSON result instead of a rendered report.
  --max-files <n>       Inline-diff cutoff by changed-file count (default 50).
  --max-bytes <n>       Inline-diff cutoff by diff size in bytes (default 262144).
  --context-lines <n>   Diff context lines passed to git diff -U<n> (default 10).
  --include-files       Also inline full post-change file contents (budgeted).
  --allow-summary-review Allow API providers to review summary-only large diffs.
  --fail-on <severity>  Gate threshold: critical | high | medium (default) | low.
  --min-confidence <x>  Findings below this confidence don't gate (default 0.5).
  --fail-on-empty       Exit 1 (instead of 0) when there is nothing to review.
  --verify              Second adversarial pass that tries to refute each finding;
                        refuted findings are dropped (1 extra call per finding).
  --passes <n>          Run the review n times and merge findings (default 1).
  --allow-secrets       Send the payload even if the secret scan finds likely
                        credentials in the diff (off by default).
  --timeout <seconds>   Per-request API timeout (default 120).
  --provider <name>     Force provider: anthropic | openai | gemini | cursor | <local-cli-cmd>.
  --model <name>        Force the model name.
  --api-base <url>      Override the active provider's API base URL.
  --api-key <key>       Override the active provider's API key.
  --headers <json>      Inject custom JSON headers into the LLM request.
  -h, --help            Show this help message.

${colors.bold("LLM selection (when not --prompt-only):")}
  Auto-detected in order: ANTHROPIC_API_KEY, GEMINI_API_KEY, OPENAI_API_KEY,
  then a local CLI agent (claude, codex, gemini). Override with --provider.

${colors.bold("Environment Variables:")}
  ANTHROPIC_API_KEY     Use the Anthropic API.
  GEMINI_API_KEY        Use the Gemini API.
  OPENAI_API_KEY        Use the OpenAI API.
  OPENAI_API_BASE       Override base URL for OpenAI provider.
  ANTHROPIC_API_BASE    Override base URL for Anthropic provider.
  GEMINI_API_BASE       Override base URL for Gemini provider.
  LLM_API_KEY           Override API key for the active provider.
  LLM_HEADERS           JSON string of custom headers to inject.

${colors.bold("Exit codes:")}
  0  approve            No material adversarial finding.
  2  needs-attention    At least one material finding worth blocking on.
  1  error              Could not complete the review.
`;

// Minimal argument parser tailored to the review CLI.
export function parseArgs(argv) {
  const args = {
    base: null,
    scope: "auto",
    promptOnly: false,
    json: false,
    maxFiles: 50,
    maxBytes: 256 * 1024,
    contextLines: 10,
    includeFiles: false,
    allowSummaryReview: false,
    failOn: "medium",
    minConfidence: 0.5,
    failOnEmpty: false,
    verify: false,
    passes: 1,
    allowSecrets: false,
    timeout: 120,
    provider: null,
    model: null,
    apiBase: null,
    apiKey: null,
    headers: null,
    help: false,
    focus: "",
    errors: []
  };

  const focusParts = [];

  function readValue(option, index) {
    const value = argv[index + 1];
    if (!value || value.startsWith("-")) {
      args.errors.push(`${option} requires a value.`);
      return { value: null, nextIndex: index };
    }
    return { value, nextIndex: index + 1 };
  }

  function readEqualsValue(option, arg) {
    const value = arg.slice(option.length + 1);
    if (!value) args.errors.push(`${option} requires a value.`);
    return value || null;
  }

  function parseNonNegativeInteger(option, value) {
    if (value === null) return null;
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed < 0) {
      args.errors.push(`${option} must be a non-negative integer.`);
      return null;
    }
    return parsed;
  }

  function parsePositiveInteger(option, value) {
    const parsed = parseNonNegativeInteger(option, value);
    if (parsed === 0) {
      args.errors.push(`${option} must be a positive integer.`);
      return null;
    }
    return parsed;
  }

  function parseSeverity(option, value) {
    if (value === null) return null;
    if (!["critical", "high", "medium", "low"].includes(value)) {
      args.errors.push(`${option} must be one of: critical, high, medium, low.`);
      return null;
    }
    return value;
  }

  function parseUnitFraction(option, value) {
    if (value === null) return null;
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
      args.errors.push(`${option} must be a number between 0 and 1.`);
      return null;
    }
    return parsed;
  }

  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "-h" || arg === "--help") {
      args.help = true;
    } else if (arg === "--prompt-only") {
      args.promptOnly = true;
    } else if (arg === "--json") {
      args.json = true;
    } else if (arg === "--allow-summary-review") {
      args.allowSummaryReview = true;
    } else if (arg === "--include-files") {
      args.includeFiles = true;
    } else if (arg === "--fail-on-empty") {
      args.failOnEmpty = true;
    } else if (arg === "--verify") {
      args.verify = true;
    } else if (arg === "--allow-secrets") {
      args.allowSecrets = true;
    } else if (arg === "--context-lines") {
      const result = readValue("--context-lines", i);
      args.contextLines = parseNonNegativeInteger("--context-lines", result.value);
      i = result.nextIndex;
    } else if (arg.startsWith("--context-lines=")) {
      args.contextLines = parseNonNegativeInteger("--context-lines", readEqualsValue("--context-lines", arg));
    } else if (arg === "--fail-on") {
      const result = readValue("--fail-on", i);
      args.failOn = parseSeverity("--fail-on", result.value);
      i = result.nextIndex;
    } else if (arg.startsWith("--fail-on=")) {
      args.failOn = parseSeverity("--fail-on", readEqualsValue("--fail-on", arg));
    } else if (arg === "--min-confidence") {
      const result = readValue("--min-confidence", i);
      args.minConfidence = parseUnitFraction("--min-confidence", result.value);
      i = result.nextIndex;
    } else if (arg.startsWith("--min-confidence=")) {
      args.minConfidence = parseUnitFraction("--min-confidence", readEqualsValue("--min-confidence", arg));
    } else if (arg === "--passes") {
      const result = readValue("--passes", i);
      args.passes = parsePositiveInteger("--passes", result.value);
      i = result.nextIndex;
    } else if (arg.startsWith("--passes=")) {
      args.passes = parsePositiveInteger("--passes", readEqualsValue("--passes", arg));
    } else if (arg === "--timeout") {
      const result = readValue("--timeout", i);
      args.timeout = parsePositiveInteger("--timeout", result.value);
      i = result.nextIndex;
    } else if (arg.startsWith("--timeout=")) {
      args.timeout = parsePositiveInteger("--timeout", readEqualsValue("--timeout", arg));
    } else if (arg === "--base") {
      const result = readValue("--base", i);
      args.base = result.value;
      i = result.nextIndex;
    } else if (arg.startsWith("--base=")) {
      args.base = readEqualsValue("--base", arg);
    } else if (arg === "--scope") {
      const result = readValue("--scope", i);
      args.scope = result.value;
      i = result.nextIndex;
    } else if (arg.startsWith("--scope=")) {
      args.scope = readEqualsValue("--scope", arg);
    } else if (arg === "--max-files") {
      const result = readValue("--max-files", i);
      args.maxFiles = parseNonNegativeInteger("--max-files", result.value);
      i = result.nextIndex;
    } else if (arg.startsWith("--max-files=")) {
      args.maxFiles = parseNonNegativeInteger("--max-files", readEqualsValue("--max-files", arg));
    } else if (arg === "--max-bytes") {
      const result = readValue("--max-bytes", i);
      args.maxBytes = parseNonNegativeInteger("--max-bytes", result.value);
      i = result.nextIndex;
    } else if (arg.startsWith("--max-bytes=")) {
      args.maxBytes = parseNonNegativeInteger("--max-bytes", readEqualsValue("--max-bytes", arg));
    } else if (arg === "--provider") {
      const result = readValue("--provider", i);
      args.provider = result.value;
      i = result.nextIndex;
    } else if (arg.startsWith("--provider=")) {
      args.provider = readEqualsValue("--provider", arg);
    } else if (arg === "--model") {
      const result = readValue("--model", i);
      args.model = result.value;
      i = result.nextIndex;
    } else if (arg.startsWith("--model=")) {
      args.model = readEqualsValue("--model", arg);
    } else if (arg === "--api-base") {
      const result = readValue("--api-base", i);
      args.apiBase = result.value;
      i = result.nextIndex;
    } else if (arg.startsWith("--api-base=")) {
      args.apiBase = readEqualsValue("--api-base", arg);
    } else if (arg === "--api-key") {
      const result = readValue("--api-key", i);
      args.apiKey = result.value;
      i = result.nextIndex;
    } else if (arg.startsWith("--api-key=")) {
      args.apiKey = readEqualsValue("--api-key", arg);
    } else if (arg === "--headers") {
      const result = readValue("--headers", i);
      args.headers = result.value;
      i = result.nextIndex;
    } else if (arg.startsWith("--headers=")) {
      args.headers = readEqualsValue("--headers", arg);
    } else if (arg === "--") {
      focusParts.push(...argv.slice(i + 1));
      break;
    } else if (arg.startsWith("-")) {
      args.errors.push(`Unknown option "${arg}".`);
    } else {
      focusParts.push(arg);
    }
  }

  args.focus = focusParts.join(" ").trim();
  return args;
}

// Custom log helpers for clean console output.
export const log = {
  info: (msg) => console.error(`${colors.blue("ℹ")} ${msg}`),
  success: (msg) => console.error(`${colors.green("✔")} ${msg}`),
  warn: (msg) => console.error(`${colors.yellow("⚠")} ${msg}`),
  error: (msg) => console.error(`${colors.red("✖")} ${msg}`),
  step: (msg) => console.error(`  ${colors.dim("▪")} ${msg}`),
  substep: (msg) => console.error(`    ${colors.gray("↳")} ${msg}`),
  errorTrace: (err) => console.error(colors.red(err.stack || err.message || err))
};
