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
  --provider <name>     Force provider: anthropic | openai | gemini | <local-cli-cmd>.
  --model <name>        Force the model name.
  -h, --help            Show this help message.

${colors.bold("LLM selection (when not --prompt-only):")}
  Auto-detected in order: ANTHROPIC_API_KEY, GEMINI_API_KEY, OPENAI_API_KEY,
  then a local CLI agent (claude, codex, gemini). Override with --provider.

${colors.bold("Environment Variables:")}
  ANTHROPIC_API_KEY     Use the Anthropic API.
  GEMINI_API_KEY        Use the Gemini API.
  OPENAI_API_KEY        Use the OpenAI API.

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
    provider: null,
    model: null,
    help: false,
    focus: ""
  };

  const focusParts = [];

  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "-h" || arg === "--help") {
      args.help = true;
    } else if (arg === "--prompt-only") {
      args.promptOnly = true;
    } else if (arg === "--json") {
      args.json = true;
    } else if (arg === "--base") {
      args.base = argv[++i];
    } else if (arg.startsWith("--base=")) {
      args.base = arg.split("=")[1];
    } else if (arg === "--scope") {
      args.scope = argv[++i];
    } else if (arg.startsWith("--scope=")) {
      args.scope = arg.split("=")[1];
    } else if (arg === "--max-files") {
      args.maxFiles = parseInt(argv[++i], 10);
    } else if (arg.startsWith("--max-files=")) {
      args.maxFiles = parseInt(arg.split("=")[1], 10);
    } else if (arg === "--max-bytes") {
      args.maxBytes = parseInt(argv[++i], 10);
    } else if (arg.startsWith("--max-bytes=")) {
      args.maxBytes = parseInt(arg.split("=")[1], 10);
    } else if (arg === "--provider") {
      args.provider = argv[++i];
    } else if (arg.startsWith("--provider=")) {
      args.provider = arg.split("=")[1];
    } else if (arg === "--model") {
      args.model = argv[++i];
    } else if (arg.startsWith("--model=")) {
      args.model = arg.split("=")[1];
    } else if (arg === "--") {
      focusParts.push(...argv.slice(i + 1));
      break;
    } else if (arg.startsWith("-")) {
      console.warn(colors.yellow(`Warning: Unknown option "${arg}"`));
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
