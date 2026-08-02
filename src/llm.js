import { execFileSync } from "child_process";
import { resolveCommand, resolveTrustedCommand, sanitizedSpawnEnv, isWindowsBatchShim } from "./spawn-safe.js";
import { commandKind } from "./resolve-command.js";
import { spawnWithWatchdog } from "./exec-watchdog.js";
import fs from "fs";
import os from "os";
import path from "path";
import crypto from "crypto";
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
  // Even a helper that only reads a number is a spawn. This one runs early — the
  // agy path calls it before execCli reaches the trusted-CLI check — so a bare
  // name here would execute a repository-supplied getconf ahead of every guard on
  // the branch. Without a trusted one, fall back to the platform default.
  const getconf = resolveTrustedCommand("getconf");
  if (!getconf) {
    cachedProbedArgMax = null;
    return cachedProbedArgMax;
  }
  try {
    const out = execFileSync(getconf, ["ARG_MAX"], {
      encoding: "utf8",
      timeout: 2000,
      stdio: ["ignore", "pipe", "ignore"],
      env: sanitizedSpawnEnv(),
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

// The review budget in milliseconds as a finite positive NUMBER, or null.
//
// Normalizing here, once, is what keeps three consumers agreeing: the watchdog
// that kills the process, the --print-timeout we hand the agent, and the message
// we print on overrun. A numeric string is coerced rather than rejected because
// every way this can diverge fails SILENTLY — the watchdog would substitute its
// own default while the agent was told a different number and the error blamed a
// third — so a config or env value arriving as "600000" must not be discarded.
// Callers must pass the normalized value to ALL of them, never the raw input.
export function normalizeTimeoutMs(timeoutMs) {
  const ms = typeof timeoutMs === "string" ? Number(timeoutMs.trim()) : timeoutMs;
  if (!Number.isFinite(ms) || ms <= 0) return null;
  return ms;
}

// The review budget in whole seconds, or null when no usable budget is known.
// Rounds UP so a sub-second budget still names a positive duration; both the flag
// we forward to the agent and the message we report on overrun read it from here,
// so the two can never disagree about what the budget was.
export function budgetSeconds(timeoutMs) {
  const ms = normalizeTimeoutMs(timeoutMs);
  return ms === null ? null : Math.max(1, Math.ceil(ms / 1000));
}

// Single wording for "the review ran out of time", whether the watchdog killed the
// process or the agent abandoned its own wait. `subject` names the thing that timed
// out, e.g. `codex` or `local CLI agent "agy"`. A missing/degenerate budget must not
// render as "NaNs" or "0s" — with no budget known, no --print-timeout was forwarded
// either, so the agent's own default is what actually fired.
export function timeoutExceededMessage(subject, timeoutMs) {
  const seconds = budgetSeconds(timeoutMs);
  return seconds === null
    ? `Failed to execute ${subject}: timed out with no --timeout budget set; retry with --timeout <seconds>`
    : `Failed to execute ${subject}: exceeded --timeout ${seconds}s; retry with --timeout <larger>`;
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

// Resolve a CLI command to a canonical, absolute, TRUSTED executable path, or null.
// "Trusted" means: it resolves on PATH AND does not live inside the git worktree
// under review (the trust root — NOT merely process.cwd(), so a monorepo-root
// node_modules/.bin shim is still refused when the tool runs from a nested
// package). npm/npx prepend ./node_modules/.bin to PATH, so a repository can
// otherwise expose a shim named claude/codex/agy that gets selected and spawned
// with the reviewer's privileges. Symlinks are resolved, so a link outside the
// tree whose target is inside is still refused. This is the SINGLE resolver used
// by fresh detection, cache reuse, and the spawn site (T22).
export function resolveTrustedCli(cmd) {
  // SKIP repo-local PATH entries and keep looking, rather than resolving to the
  // first match and then rejecting it. Rejecting made one repo-local binary hide
  // the real system CLI behind it: a dependency that installs its own `codex`
  // into node_modules/.bin — which npx puts first — made an installed
  // /usr/local/bin/codex report as unavailable, so the tool refused a provider
  // the user actually had. Excluding the trust root during the walk is both safer
  // and correct, since resolveCommand also canonicalizes and re-checks the target.
  return resolveTrustedCommand(cmd);
}

// Boolean form for the detection ladder: a repo-local CLI is NOT available.
export function isTrustedCliInstalled(cmd) {
  return resolveTrustedCli(cmd) !== null;
}

async function execCli(cliCmd, args, input = null, timeoutMs = 10 * 60 * 1000, { stream = false, argsContainUntrusted = true, envOverrides = null } = {}) {
  // SECURITY: no spawn site here selects a shell. A shell was once needed on
  // Windows so the interpreter would locate npm-installed `.cmd` shims, which are
  // not executable images. resolveCommand performs that lookup explicitly (PATH +
  // PATHEXT), and buildSpawnTarget routes a shim through the interpreter by its
  // resolved absolute path, so no argument is ever handed to cmd.exe for
  // re-parsing and no bare name is re-resolved against the current directory.
  //
  // Every platform takes the same spawnWithWatchdog path below, which applies the
  // `argsContainUntrusted` decision recorded by the caller: argv carrying the
  // reviewed prompt is refused on a Windows shim rather than executed.
  // TRUST GUARD — spawn
  // only a TRUSTED, canonical path: refuse to execute a CLI that resolves inside
  // the git worktree under review — npm/npx put ./node_modules/.bin on PATH, so a
  // reviewed repo could otherwise ship a shim that runs as the reviewer. Detection
  // already avoids selecting such a binary; this makes execution impossible even
  // if one slipped through.
  // Path-aware: configureLLM accepts a CLI named by path (--provider
  // /opt/tools/agy), and re-checking with the bare-name-only resolver rejected
  // every one of them, so a provider that configured cleanly failed at the first
  // review call with "not found on PATH". Ask the same resolver configuration
  // asked, then distinguish the two failures for the message.
  const trusted = resolveTrustedCli(cliCmd);
  if (!trusted && !resolvesAtAll(cliCmd)) {
    throw new Error(
      `Local CLI agent "${cliCmd}" was not found on PATH. Install it, or pass --provider <other>.`
    );
  }
  if (!trusted) {
    throw new Error(
      `Refusing to run local CLI agent "${cliCmd}": it resolves to an executable inside the ` +
        `working tree. A review provider must not be a repository-local binary — ` +
        `install it outside the repo, or pass --provider with a trusted provider.`
    );
  }

  return spawnWithWatchdog(trusted, args, {
    input,
    timeoutMs,
    streamStdout: stream,
    argsContainUntrusted,
    envOverrides
  });
}

// Claude-Code-compatible CLIs (claude, agy): always use print mode (-p) with the
// stdin sentinel (-). For review, also force plan/read-only mode so an untrusted
// diff cannot prompt-inject writes (mirrors Codex --sandbox read-only). Flag name
// is per-CLI: claude uses --permission-mode; agy uses --mode. Opt out with
// --allow-unsandboxed-cli when an older CLI rejects plan mode.
// Does this name identify an executable at all, trusted or not? Used only to
// tell "you have not installed it" apart from "it is inside the repository" —
// two very different problems that must not share one message.
function resolvesAtAll(cliCmd) {
  if (typeof cliCmd === "string" && (path.isAbsolute(cliCmd) || cliCmd.includes("/") || cliCmd.includes("\\"))) {
    try {
      return fs.statSync(path.resolve(cliCmd)).isFile();
    } catch {
      return false;
    }
  }
  return resolveCommand(cliCmd) !== null;
}

export function isCursorAgentCli(cliCmd) {
  const kind = commandKind(cliCmd);
  return kind === "agent" || kind === "cursor-agent";
}

// CLIs whose `-p` takes the prompt as its VALUE and have NO stdin `-` sentinel
// (that is a claude/codex convention). Both were verified to misread `-p -` as a
// prompt of literal "-" rather than a request to read stdin:
//   agy      → answers the literal "-" and ignores stdin, returning conversational
//              prose ("Hello! How can I help you today?") instead of the review JSON.
//   copilot  → replies "I notice your message is empty."
// Either way the review is lost, so these must always receive the prompt as the
// `-p` argument value.
const ARGV_PROMPT_CLIS = new Set(["agy", "copilot"]);

export function cliRequiresArgvPrompt(cliCmd) {
  return ARGV_PROMPT_CLIS.has(commandKind(cliCmd));
}

// agy's print mode has its OWN wait budget (`--print-timeout`, default 5m0s) that
// is independent of our watchdog. Left unset, agy aborts a long review at 5 minutes
// with "Error: timeout waiting for response" no matter how large a --timeout the
// user asked for (the CLI default for a local agent is 2400s) — the user's timeout
// silently does not apply. Pass the resolved budget through so agy honours it.
// Returns [] for CLIs without the flag, and when no budget is known.
export function cliPrintTimeoutArgs(cliCmd, timeoutMs) {
  if (commandKind(cliCmd) !== "agy") return [];
  const seconds = budgetSeconds(timeoutMs);
  if (seconds === null) return [];
  // Go duration literal; seconds granularity is enough for a review budget.
  return ["--print-timeout", `${seconds}s`];
}

/** True when CLI stderr shows the agent gave up waiting on its own response. */
export function isCliPrintTimeoutStderr(stderr) {
  return /timeout waiting for response/i.test((stderr || "").toString());
}

// A CLI that must carry the prompt in argv cannot be launched from a Windows npm
// `.cmd` shim: cmd.exe re-parses the command line, so buildSpawnTarget refuses
// the untrusted argv rather than let a reviewed diff execute. Such an install can
// never complete a review, so detection must skip it instead of selecting it and
// failing at spawn time — and an explicit request for it must say why.
export function cliUsableForReview(cliCmd, { platform = process.platform, resolve = resolveTrustedCli } = {}) {
  if (platform !== "win32" || !cliRequiresArgvPrompt(cliCmd)) return true;
  const resolved = resolve(cliCmd);
  if (!resolved) return false;
  return !isWindowsBatchShim(resolved, { platform });
}

// THE reachability predicate for a local CLI. Installed-and-trusted is not the
// same as able-to-review, and every selection path must ask the same question:
// auto-detection, --providers token resolution, the large-diff family downgrade,
// and cache reuse. Where one of them asks a weaker question, that path selects a
// provider the spawn site will refuse — and a --providers run aborts instead of
// continuing with the reviewers that do work.
export function cliReachableForReview(cliCmd) {
  return isTrustedCliInstalled(cliCmd) && cliUsableForReview(cliCmd);
}

export function cliUnusableMessage(cliCmd) {
  return (
    `Local CLI agent "${cliCmd}" is installed as a Windows .cmd shim, which cannot be used for ` +
    `review: it can only be launched through cmd.exe, and ${cliCmd} takes the prompt as a ` +
    `command-line argument, so the reviewed diff would be re-parsed as commands.\n` +
    `Use a provider whose prompt travels over stdin (--provider claude or --provider codex), ` +
    `an API provider, or install ${cliCmd} as a native executable.`
  );
}

/** Plan/read-only sandbox flags for a local CLI (empty when unsandboxed or unknown). */
export function cliSandboxArgs(cliCmd, { allowUnsandboxedCli = false } = {}) {
  if (allowUnsandboxedCli) return [];
  const kind = commandKind(cliCmd);
  if (kind === "claude") return ["--permission-mode", "plan"];
  // copilot's plan mode is a real read-only gate, not advisory: asked to create a
  // file it answers "Per plan mode rules, I outline the approach but don't execute
  // file changes" and writes nothing. Same intent as codex --sandbox read-only.
  if (kind === "agy" || kind === "copilot" || isCursorAgentCli(cliCmd)) return ["--mode", "plan"];
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
  // commander.js (copilot) quotes the flag: `error: unknown option '--foo'`.
  // Without consuming the quote, `-{0,2}` matches zero dashes, the capture keeps
  // the quotes, and the message reads `rejected flag "--'--foo'"`. Accept an
  // optional opening quote and stop the capture at the closing one.
  const unknownMatch = text.match(/unknown (?:flag|option)[:\s]+['"`]?-{0,2}([^'"`\s]+)/i);
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
  if (isTrustedCliInstalled("agent")) return "agent";
  if (isTrustedCliInstalled("cursor-agent")) return "cursor-agent";
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
  // Only claude uses the stdin `-` review form here. agy has no stdin sentinel
  // (see cliRequiresArgvPrompt) and is invoked with the prompt as the -p value via
  // cliFallbackArgs; it must NOT get a `-p -` form, which agy reads as the prompt "-".
  if (commandKind(cliCmd) !== "claude") return [];
  const args = [...cliSandboxArgs(cliCmd, { allowUnsandboxedCli })];
  if (model) args.push("--model", model);
  args.push("-p", "-");
  return args;
}

// INVARIANT: the prompt is always the LAST element, immediately preceded by the
// flag that consumes it (`-p`). agy parses with Go's flag package, which stops at
// the first non-flag argument — anything appended after the prompt is silently
// dropped, and anything inserted between `-p` and the prompt is consumed AS the
// prompt. New flags must be added before that trailing pair, never after it.
export function cliFallbackArgs(cliCmd, fullPrompt, { allowUnsandboxedCli = false, model = null, timeoutMs = null } = {}) {
  if (isCursorAgentCli(cliCmd)) {
    const args = ["-p", "--trust", "--output-format", "text"];
    args.push(...cliSandboxArgs(cliCmd, { allowUnsandboxedCli }));
    if (model) args.push("--model", model);
    args.push(fullPrompt);
    return args;
  }
  const kind = commandKind(cliCmd);
  // copilot: -s prints the agent response alone (no session stats), and the log/
  // color flags keep decoration out of stdout so the JSON extractor sees only the
  // answer. Verified to return a bare `{"ok":true}` for a JSON-only prompt.
  if (kind === "copilot") {
    const args = [...cliSandboxArgs(cliCmd, { allowUnsandboxedCli })];
    args.push("-s", "--no-color", "--log-level", "none");
    if (model) args.push("--model", model);
    args.push("-p", fullPrompt);
    return args;
  }
  // claude and agy are Claude-Code-compatible: they need -p (print mode) when
  // the prompt is passed as a command-line argument.
  if (kind === "claude" || kind === "agy") {
    const args = [...cliSandboxArgs(cliCmd, { allowUnsandboxedCli })];
    if (model) args.push("--model", model);
    args.push(...cliPrintTimeoutArgs(cliCmd, timeoutMs));
    args.push("-p", fullPrompt);
    return args;
  }
  return [fullPrompt];
}

// Invoke the Codex CLI non-interactively via `codex exec`.
// Uses --output-last-message to capture only the final agent response (not the
// full JSONL event stream), and --output-schema when a JSON Schema is provided
// so Codex enforces the output shape natively rather than relying on scraping.
// The prompt is piped via stdin (`-`) to avoid argv size limits on large diffs;
// the argv path is used as a fallback if stdin is rejected.
async function callCodexCli(fullPrompt, schema, timeoutMs = 10 * 60 * 1000, { stream = false, model = null } = {}) {
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
    // `codex exec` accepts `-m/--model`; forward a resolved cli:codex pin.
    if (model) baseArgs.push("--model", model);
    if (schemaFile) baseArgs.push("--output-schema", schemaFile);

    try {
      // Primary path: pipe prompt via stdin. Codex's non-interactive exec accepts `-` as
      // the positional prompt argument to signal "read from stdin" (per `codex exec --help`:
      // "If not provided as an argument (or if `-` is used), instructions are read from
      // stdin"). We rely on execFileSync's `input` option to wire the full prompt payload
      // to that stdin pipe, so the review content is never truncated by argv size limits.
      await execCli("codex", [...baseArgs, "-"], fullPrompt, timeoutMs, { stream, argsContainUntrusted: false });
    } catch (stdinErr) {
      if (stdinErr.code === "ETIMEDOUT") {
        throw Object.assign(new Error(timeoutExceededMessage("codex", timeoutMs)), { stdout: stdinErr.stdout, stderr: stdinErr.stderr, cause: stdinErr });
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
          throw Object.assign(new Error(timeoutExceededMessage("codex", timeoutMs)), { stdout: argvErr.stdout, stderr: argvErr.stderr, cause: argvErr });
        }
        if (isE2BigError(argvErr)) {
          throw Object.assign(new Error(argvTooLargeMessage("Codex", promptBytes, argvLimit)), { stdout: argvErr.stdout, stderr: argvErr.stderr, cause: argvErr });
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

// The agent name the generated opencode config declares. Passing it explicitly is
// mandatory: `--agent` naming something opencode considers a SUBAGENT does not fail
// closed — it warns ("agent X is a subagent, not a primary agent. Falling back to
// default agent") and proceeds under the user's own default, which on a normal
// install carries {"permission": "*", "action": "allow"}. That is full write and
// bash access applied to a prompt built from an untrusted diff.
//
// The name is also generated FRESH PER RUN, and that randomness is a security
// control, not cosmetics. OPENCODE_CONFIG merges rather than replaces, and the
// merge includes project-local `opencode.json` from the working directory — which
// during a review IS the repository under review. Verified by attack: a repo that
// ships an opencode.json redefining the review agent BY NAME with
// `tools:{write,bash}=true, permission:{"*":"allow"}` wins that merge, and a live
// run then wrote the file it was told to write. A fixed name is a name the
// attacker knows. A per-run random one cannot be targeted by a file written before
// the run. Verified separately: a hostile config that does NOT name our agent
// (top-level `tools`/`permission` instead) does not broaden it.
export const OPENCODE_AGENT_PREFIX = "adversarial-review-";

export function newOpencodeAgentName() {
  return `${OPENCODE_AGENT_PREFIX}${crypto.randomBytes(16).toString("hex")}`;
}

// Default gateway into opencode's non-frontier-lab providers, which is the reason
// to reach for opencode at all: models no other supported provider can serve.
// Overridable with --model. Always sent explicitly — see buildOpencodeConfig.
export const OPENCODE_DEFAULT_MODEL = "opencode-go/grok-4.5";

/**
 * The read-only agent definition handed to opencode via OPENCODE_CONFIG.
 *
 * This config MERGES into the user's own (verified — their agents remain visible
 * alongside ours), so it cannot rely on replacing anything they set. It works by
 * declaring its OWN agent whose per-agent tools and permissions are self-contained,
 * rather than by removing theirs.
 *
 * PERMISSION SEMANTICS — read the schema before changing this
 * (https://opencode.ai/config.json, $defs.PermissionConfig). Two things there are
 * easy to get wrong, and getting them wrong fails OPEN:
 *
 *   - There is no `write` or `patch` permission key. File modification is governed
 *     by `edit`. Denying "write" denies nothing; it is absorbed by
 *     additionalProperties and silently ignored.
 *   - `"*"` is NOT a wildcard. It is likewise just an unrecognized key. A config of
 *     `{ "*": "deny" }` does not deny anything by wildcard, and
 *     `{ "*": "allow", write: "deny" }` was verified to let the model write a file.
 *
 * A key left UNSET defaults to "ask", and an interactive prompt in a headless run
 * blocks forever with no output and no error — two runs were killed by an external
 * timeout at 400s and 500s before this was understood. So every key the schema
 * defines is enumerated explicitly below: nothing is left to default, and nothing
 * relies on a wildcard that does not exist.
 *
 * `tools: { write: false }` is NOT a security control — with a permissive permission
 * set the model wrote the file regardless. `permission` is what enforces; the
 * `tools` block is defense in depth and is not relied upon.
 *
 * Verified against the real CLI under this exact config: reading a file works,
 * writing one is blocked, and running a shell command is blocked.
 */
// Every key in $defs.PermissionConfig. An unlisted key defaults to "ask", which
// hangs a headless run — so this list must stay exhaustive. If opencode adds a new
// permission, a review may hang until the watchdog ceiling; that is the failure this
// list exists to prevent, and the drift shows up as a timeout, not a silent bypass.
const OPENCODE_PERMISSIONS = {
  // ALLOW only what inspects. Four read paths, nothing else — a permission whose
  // name contains "write" has no business in an agent documented as read-only,
  // however benign the state it touches looks.
  read: "allow", grep: "allow", glob: "allow", list: "allow",
  // Everything that mutates, executes, reaches the network, or escapes the worktree.
  edit: "deny", bash: "deny", task: "deny", webfetch: "deny", websearch: "deny",
  external_directory: "deny", question: "deny", doom_loop: "deny", skill: "deny",
  // todowrite mutates session/todo state, and `lsp` can drive a language server into
  // code actions and formatting. Neither was shown to be side-effect free, and an
  // unproven capability is denied rather than assumed harmless.
  todowrite: "deny", lsp: "deny"
};
export function buildOpencodeConfig(agentName = newOpencodeAgentName()) {
  return {
    $schema: "https://opencode.ai/config.json",
    agent: {
      [agentName]: {
        description: "Read-only adversarial reviewer (adversarial-review)",
        mode: "primary",
        tools: {
          write: false, edit: false, patch: false, bash: false, task: false,
          read: true, grep: true, glob: true, list: true
        },
        permission: { ...OPENCODE_PERMISSIONS }
      }
    }
  };
}

/** Argv for a review run. The prompt travels on stdin, so it never appears here. */
export function opencodeReviewArgs({ model = null, agent } = {}) {
  if (!agent) throw new Error("opencodeReviewArgs requires the per-run agent name");
  // `--pure` blocks external plugins. Plugin loading is another path the reviewed
  // repository controls through its own project config, and a plugin runs code —
  // the sandbox on tools would be irrelevant if the repo could load a plugin.
  // VERIFIED: OPENCODE_CONFIG MERGES into the user's config, it does not replace
  // it — with our config set, `opencode agent list` still shows every agent the
  // user defined, plus ours. So the user's default model WOULD be available.
  // Send `-m` anyway: inheriting their default would make the reviewing model, and
  // therefore the diversity of the review, depend on unrelated local config that
  // can change without notice. A review pins its own model.
  // `--format json` is REQUIRED, not a preference. Under the default formatter,
  // stdout is written for a terminal: piped, it interleaves tool-call framing into
  // the prose and arrives corrupted ("I need to check the line count.0aRead0epath/
  // Users/.../file.js"), so a review that used tools returned narration and no
  // parseable JSON. `--format json` emits one JSON event per line; the assistant's
  // answer is the concatenation of the `text` events (see extractOpencodeText).
  return ["--pure", "run", "--agent", agent, "-m", model || OPENCODE_DEFAULT_MODEL, "--format", "json"];
}

/**
 * Pull the assistant's answer out of opencode's `--format json` event stream.
 *
 * The stream is JSONL: `step_start`, one or more `text` parts, `step_finish`, plus
 * tool events. Only `text` parts are the answer — tool events carry file contents
 * and arguments, and folding those in would feed the reviewed repository's own
 * source back into the JSON extractor as if the model had written it.
 *
 * Falls back to the raw payload when nothing parses, so a plain-text reply (or a
 * future format change) still reaches the caller's JSON extraction rather than
 * silently becoming an empty review.
 */
export function extractOpencodeText(stdout) {
  const raw = (stdout || "").toString();
  const parts = [];
  let sawEvent = false;
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    let evt;
    try {
      evt = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (!evt || typeof evt.type !== "string") continue;
    sawEvent = true;
    if (evt.type === "text" && typeof evt.part?.text === "string") parts.push(evt.part.text);
  }
  // Falling back only when NOTHING parsed is not enough: a stream carrying step and
  // tool events but no `text` part would return "" and abort an otherwise successful
  // run — strictly worse than the plain-text case. Any time we end up with no answer,
  // hand back the raw payload and let the caller's JSON extraction try.
  const text = parts.join("").trim();
  if (!sawEvent || !text) return raw.trim();
  return text;
}

/** Argv that asks opencode which agents the MERGED config actually defines. */
export function opencodeAgentListArgs() {
  return ["--pure", "agent", "list"];
}

/**
 * Fail-closed PREFLIGHT: is our agent registered as `primary` in the merged config?
 *
 * opencode does not fail closed when `--agent` cannot be honored — it falls back to
 * the user's write-capable default and completes normally. Under `--format default`
 * it at least warns on stderr; under `--format json`, which the review requires (see
 * opencodeReviewArgs), stderr is EMPTY and the fallback is completely silent. There
 * is no post-hoc signal to check, so the check has to happen before the diff is ever
 * sent: `agent list` prints one `<name> (primary|subagent)` line per agent, computed
 * from the same merge the run will use. Verified to report `(subagent)` when a
 * project-local config downgrades the agent's mode.
 */
export function opencodeAgentIsPrimary(listing, agentName) {
  const line = new RegExp(`^\\s*${agentName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\((\\w+)\\)\\s*$`, "m");
  const m = (listing || "").toString().match(line);
  return m ? m[1] === "primary" : false;
}

/**
 * Invoke opencode non-interactively with a generated read-only config.
 *
 * The prompt goes over stdin (`opencode run` reads it with no sentinel argument),
 * so argv carries only our own constant flags and the argv-size guard does not
 * apply. Only stdout is returned: the session banner ("> agent · model") goes to
 * stderr and must never reach the JSON extractor.
 */
async function callOpencodeCli(cliCmd, fullPrompt, timeoutMs, { stream = false, model = null, allowUnsandboxedCli = false } = {}) {
  // Private temp dir, mirroring callCodexCli: owned by this process, so path
  // prediction and symlink races against a shared /tmp are not possible. It also
  // keeps the config OUTSIDE the worktree — a config inside the repository under
  // review would be one more thing a reviewed diff could rewrite.
  const privateDir = fs.mkdtempSync(path.join(os.tmpdir(), "adv-review-opencode-"));
  const configFile = path.join(privateDir, "opencode.json");

  // `opencode run` drops a project-local `.omo/` state directory into the PROJECT it
  // operates on — which is not necessarily the process cwd. Run from a package
  // subdirectory of a monorepo, cwd and the project root differ, and keying cleanup
  // to cwd alone leaves the real one behind. A reviewer must not leave untracked
  // files in the tree it just reviewed: `git status` surfaces them, and because
  // untracked content is part of the reviewed input, its own session state would
  // feed into the NEXT review. Watch both candidates, and remove only what this run
  // created — a pre-existing `.omo/` belongs to the user and is never touched.
  const stateDirs = opencodeStateDirCandidates();
  const statePreexisted = new Map(stateDirs.map((d) => [d, fs.existsSync(d)]));

  // Fresh per run: a name the reviewed repository cannot have named in advance.
  const agentName = newOpencodeAgentName();

  try {
    if (allowUnsandboxedCli) {
      // Opting out means running under the user's own agent config, which may
      // permit writes. Say so rather than letting it look sandboxed.
      log.warn("opencode is running WITHOUT the generated read-only config (--allow-unsandboxed-cli).");
    } else {
      // wx: exclusive create, defense in depth inside an already-private directory.
      fs.writeFileSync(configFile, JSON.stringify(buildOpencodeConfig(agentName), null, 2), { mode: 0o600, flag: "wx" });
    }

    // `--format json` is required on BOTH paths: it is what makes stdout
    // machine-readable at all (the default formatter interleaves tool framing into
    // the prose), and extractOpencodeText parses the result either way. Opting out
    // of the sandbox must not also opt out of a parseable review.
    const args = allowUnsandboxedCli
      ? ["--pure", "run", "-m", model || OPENCODE_DEFAULT_MODEL, "--format", "json"]
      : opencodeReviewArgs({ model, agent: agentName });
    const envOverrides = allowUnsandboxedCli ? null : { OPENCODE_CONFIG: configFile };

    // PREFLIGHT, before the diff is sent anywhere: confirm the merged config really
    // registers our agent as primary. If it does not, opencode would silently run
    // the review under the user's write-capable default agent instead — and under
    // --format json it does so with no warning on any stream, so this is the only
    // place the downgrade is observable.
    if (!allowUnsandboxedCli) {
      let listing = "";
      try {
        listing = await execCli(cliCmd, opencodeAgentListArgs(), null, Math.min(timeoutMs, 120_000), {
          argsContainUntrusted: false,
          envOverrides
        });
      } catch (err) {
        throw new Error(
          `Could not verify the opencode read-only sandbox (\`opencode agent list\` failed): ` +
            `${err.message}\nRefusing to send the diff to an unverified agent.`
        );
      }
      if (!opencodeAgentIsPrimary(listing, agentName)) {
        throw new Error(
          `opencode did not register the sandboxed agent "${agentName}" as primary, so the ` +
            `review would run under the default agent WITHOUT the read-only sandbox.\n` +
            `Refusing to send the diff. Pass --allow-unsandboxed-cli to accept that deliberately.`
        );
      }
    }

    try {
      const out = await execCli(cliCmd, args, fullPrompt, timeoutMs, {
        stream,
        argsContainUntrusted: false,
        envOverrides
      });
      return extractOpencodeText(out);
    } catch (err) {
      if (err.code === "ETIMEDOUT") {
        throw Object.assign(new Error(timeoutExceededMessage(`local CLI agent "${cliCmd}"`, timeoutMs)), { stdout: err.stdout, stderr: err.stderr, cause: err });
      }
      const stderr = err.stderr?.toString("utf8") || "";
      const flagRejection = describeUnknownFlagRejection(cliCmd, stderr);
      if (flagRejection) {
        throw Object.assign(new Error(flagRejection + (stderr.trim() ? `\n${stderr.trim()}` : "")), { stdout: err.stdout, stderr: err.stderr, cause: err });
      }
      // An unreachable or unauthenticated model is the most likely failure and
      // exits 1 with the reason only on stderr. Name the model and the command
      // that shows what IS authenticated, rather than surfacing a bare exit code.
      const chosen = model || OPENCODE_DEFAULT_MODEL;
      if (isOpencodeModelUnavailable(stderr)) {
        throw Object.assign(
          new Error(
            `opencode could not use model "${chosen}".\n` +
              `Run \`opencode auth list\` to see which providers are authenticated, ` +
              `then pass --model <provider/model> for one of them.` +
              (stderr.trim() ? `\n${stderr.trim()}` : "")
          ),
          { stdout: err.stdout, stderr: err.stderr, cause: err }
        );
      }
      const suffix = stderr.trim() ? `\n${stderr.trim()}` : "";
      throw Object.assign(new Error(`Failed to execute local CLI agent "${cliCmd}": ${err.message}${suffix}`), { stdout: err.stdout, stderr: err.stderr, cause: err });
    }
  } finally {
    try { fs.rmSync(privateDir, { recursive: true, force: true }); } catch { /* ignore */ }
    for (const dir of stateDirs) removeStateDirIfCreated(dir, statePreexisted.get(dir));
  }
}

/**
 * Remove a project-local state directory that THIS run created.
 *
 * `opencode run` drops a `.omo/` directory into the project it operates on, and
 * that directory follows the project rather than the process cwd — so it cannot be
 * relocated while the agent still needs to read the repository. Whether it appears
 * varies with the run, so this is written to be correct either way: absent is fine,
 * pre-existing is left strictly alone (it is the user's), and only a directory that
 * appeared during our run is removed. A symlink is never followed — removing one
 * could reach outside the worktree entirely.
 */
/**
 * Every directory opencode might root its `.omo/` state in: the process cwd, and
 * the git worktree root when that differs (running from a package subdirectory of a
 * monorepo is the ordinary case). Deduplicated, and degrades to cwd alone when the
 * repo root cannot be resolved — a cleanup helper must never be the thing that
 * fails a review.
 */
export function opencodeStateDirCandidates({ cwd = process.cwd(), repoRoot = null } = {}) {
  const roots = [cwd];
  let top = repoRoot;
  if (top === null) {
    try {
      const git = resolveTrustedCommand("git");
      if (git) {
        top = execFileSync(git, ["rev-parse", "--show-toplevel"], {
          cwd,
          encoding: "utf8",
          env: sanitizedSpawnEnv(),
          stdio: ["ignore", "pipe", "ignore"]
        }).trim();
      }
    } catch {
      top = null;
    }
  }
  if (top && top !== cwd) roots.push(top);
  return [...new Set(roots)].map((r) => path.join(r, ".omo"));
}

export function removeStateDirIfCreated(stateDir, preexisted) {
  if (preexisted) return false;
  try {
    const st = fs.lstatSync(stateDir);
    if (!st.isDirectory()) return false;
    fs.rmSync(stateDir, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

/** True when opencode stderr shows the model itself was the problem. */
export function isOpencodeModelUnavailable(stderr) {
  const text = (stderr || "").toString();
  return /credit balance is too low|no such model|model not found|unknown model|not authenticated|unauthorized|provider .* not found/i.test(text);
}

// Invoke a local CLI agent (claude, agy, ...) by piping the prompt to stdin.
const DEFAULT_CLI_TIMEOUT_MS = 10 * 60 * 1000;

async function callCliLLM(cliCmd, prompt, systemInstruction, schema = null, { timeoutMs: rawTimeoutMs = DEFAULT_CLI_TIMEOUT_MS, allowUnsandboxedCli = false, model = null, stream = false } = {}) {
  // Normalize ONCE, at the boundary. Everything downstream — the watchdog window,
  // the agent's own --print-timeout, and the overrun message — must read the same
  // number, or the process is killed at one budget while the agent was told
  // another and the error reports a third.
  // An unusable value resolves to the documented default rather than null, so no
  // consumer downstream has to invent one of its own.
  const timeoutMs = normalizeTimeoutMs(rawTimeoutMs) ?? DEFAULT_CLI_TIMEOUT_MS;
  let fullPrompt = "";
  if (systemInstruction) {
    fullPrompt += `System Instructions:\n${systemInstruction}\n\n`;
  }
  fullPrompt += `Prompt:\n${prompt}`;

  log.step(`Invoking local subscription agent via command: "${cliCmd}"...`);

  if (commandKind(cliCmd) === "codex") {
    return callCodexCli(fullPrompt, schema, timeoutMs, { stream, model });
  }

  if (commandKind(cliCmd) === "opencode") {
    return callOpencodeCli(cliCmd, fullPrompt, timeoutMs, { stream, model, allowUnsandboxedCli });
  }

  const fallbackOpts = { allowUnsandboxedCli, model, timeoutMs };

  // agy: the prompt MUST be the `-p` value (no stdin sentinel). Deliver it via
  // argv directly — there is no stdin path to try first. Guard the argv size.
  if (cliRequiresArgvPrompt(cliCmd)) {
    const promptBytes = Buffer.byteLength(fullPrompt);
    const argvLimit = maxArgvPromptBytes();
    if (promptBytes > argvLimit) {
      throw new Error(argvTooLargeMessage(`Local CLI agent "${cliCmd}"`, promptBytes, argvLimit));
    }
    try {
      return await execCli(cliCmd, cliFallbackArgs(cliCmd, fullPrompt, fallbackOpts), null, timeoutMs, { stream, argsContainUntrusted: true });
    } catch (err) {
      if (err.code === "ETIMEDOUT") {
        throw Object.assign(new Error(timeoutExceededMessage(`local CLI agent "${cliCmd}"`, timeoutMs)), { stdout: err.stdout, stderr: err.stderr, cause: err });
      }
      if (isE2BigError(err)) {
        throw Object.assign(new Error(argvTooLargeMessage(`Local CLI agent "${cliCmd}"`, promptBytes, argvLimit)), { stdout: err.stdout, stderr: err.stderr, cause: err });
      }
      const stderr = err.stderr?.toString("utf8") || "";
      // The agent aborted its own wait (agy --print-timeout). Report it as the
      // budget overrun it is, not as an opaque exit-1, so the fix is obvious.
      if (isCliPrintTimeoutStderr(stderr)) {
        throw Object.assign(new Error(timeoutExceededMessage(`local CLI agent "${cliCmd}"`, timeoutMs)), { stdout: err.stdout, stderr: err.stderr, cause: err });
      }
      const flagRejection = describeUnknownFlagRejection(cliCmd, stderr);
      if (flagRejection) {
        throw Object.assign(new Error(flagRejection + (stderr.trim() ? `\n${stderr.trim()}` : "")), { stdout: err.stdout, stderr: err.stderr, cause: err });
      }
      const suffix = stderr.trim() ? `\n${stderr.trim()}` : "";
      throw Object.assign(new Error(`Failed to execute local CLI agent "${cliCmd}": ${err.message}${suffix}`), { stdout: err.stdout, stderr: err.stderr, cause: err });
    }
  }

  // claude: -p + stdin `-` + --permission-mode plan.
  // agent/cursor-agent: -p + stdin `-` + --mode plan + --trust (Cursor CLI).
  // A bare invocation launches interactively and hangs until timeout.
  const primaryArgs = cliReviewArgs(cliCmd, { allowUnsandboxedCli, model });

  try {
    return await execCli(cliCmd, primaryArgs, fullPrompt, timeoutMs, { stream, argsContainUntrusted: false });
  } catch (err) {
    if (err.code === "ETIMEDOUT") {
      throw Object.assign(new Error(timeoutExceededMessage(`local CLI agent "${cliCmd}"`, timeoutMs)), { stdout: err.stdout, stderr: err.stderr, cause: err });
    }
    const stderr = err.stderr?.toString("utf8") || "";
    // Unknown-flag rejections must surface clearly — not as a prompt-size / argv error.
    // Retrying argv would pass the same bad flag and fail the same way.
    const flagRejection = describeUnknownFlagRejection(cliCmd, stderr);
    if (flagRejection) {
      throw Object.assign(new Error(flagRejection + (stderr.trim() ? `\n${stderr.trim()}` : "")), { stdout: err.stdout, stderr: err.stderr, cause: err });
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
        throw Object.assign(
          new Error(timeoutExceededMessage(`local CLI agent "${cliCmd}"`, timeoutMs)),
          { stdout: err2.stdout, stderr: err2.stderr, cause: err2 }
        );
      }
      if (isE2BigError(err2)) {
        throw Object.assign(new Error(argvTooLargeMessage(`Local CLI agent "${cliCmd}"`, promptBytes, argvLimit)), { stdout: err2.stdout, stderr: err2.stderr, cause: err2 });
      }
      const stderr2 = err2.stderr?.toString("utf8") || stderr;
      const flagRejection2 = describeUnknownFlagRejection(cliCmd, stderr2);
      if (flagRejection2) {
        throw Object.assign(new Error(flagRejection2 + (stderr2.trim() ? `\n${stderr2.trim()}` : "")), { stdout: err2.stdout, stderr: err2.stderr, cause: err2 });
      }
      const suffix = stderr2.trim() ? `\n${stderr2.trim()}` : "";
      throw Object.assign(
        new Error(`Failed to execute local CLI agent "${cliCmd}": ${err2.message || err.message}${suffix}`),
        { stdout: err2.stdout ?? err.stdout, stderr: err2.stderr ?? err.stderr, cause: err2 }
      );
    }
  }
}

const NO_LLM_CONFIG_MSG =
  "No LLM configuration found.\n" +
  "Set an API key (ANTHROPIC_API_KEY, GEMINI_API_KEY, OPENAI_API_KEY, or AI_GATEWAY_API_KEY),\n" +
  "or install a local CLI agent (claude, codex, agy, or agent).\n" +
  "Or run with --prompt-only to just print the prompt.";

// The detection ladder branches on the builder environment (Claude Code / Cursor /
// Antigravity / plain shell), and the reviewer-diversity constraint is derived from
// it. The resolution cache is keyed on this same context so a resolution is only
// ever reused in the environment it was resolved in — a resolution cached inside
// Claude Code can never be served to a plain-shell run (or vice versa), which is
// the primary defense against the cache silently picking the builder's own family.
export function builderContextKey(env = process.env) {
  if (env.CLAUDECODE || env.CLAUDE_CODE) return "claudecode";
  if (env.TERM_PROGRAM === "cursor") return "cursor";
  if (env.ANTIGRAVITY_AGENT || env.ANTIGRAVITY_CONVERSATION_ID) return "antigravity";
  return "default";
}

// The canonical, absolute, TRUSTED path a CLI command resolves to (or null if it
// is not found or is repo-local). Recorded in the cache so reuse can verify the
// SAME binary still resolves (identity), not merely that SOME binary of that name
// exists — and so a repo-local binary is never cached.
export function resolvedCliPath(cliCmd) {
  return cliCmd ? resolveTrustedCli(cliCmd) : null;
}

// The diversity family of a concrete resolution. API providers map to their own
// family; a local CLI maps via TOKEN_FAMILY (codex→openai, claude→anthropic,
// agy→gemini). `vercel` (a transport) and the routing Cursor Agent CLI have no
// fixed family — diversity for those is handled by gatewayPreferModel / the
// context key, so null here just means "no family-level guard applies".
export function familyForResolution(provider, cliCmd) {
  if (provider === "cli") return TOKEN_FAMILY[cliCmd] || null;
  if (provider === "anthropic" || provider === "openai" || provider === "gemini") return provider;
  return null;
}

// A cached resolution is reusable only if it is still REACHABLE and still
// preserves reviewer diversity. Any miss falls through to a full re-detection —
// this is the "unless the right path doesn't work, reprobe" fallback. The check
// is one PATH stat / env read, far cheaper than the full ladder.
export function cachedResolutionUsable(entry) {
  if (!entry || typeof entry !== "object") return false;
  const { provider, cliCmd } = entry;
  // Diversity guard (defense in depth on top of the context-keyed cache): never
  // serve a resolution whose family is the builder's own family. Recompute the
  // family from provider/cliCmd — the stored `family` field is advisory only, so
  // a forged or stale entry (e.g. family:null on an anthropic provider) cannot
  // slip a same-family critic past this guard.
  const family = familyForResolution(provider, cliCmd);
  if (family && family === builderFamily()) return false;
  if (provider === "cli") {
    if (typeof cliCmd !== "string") return false;
    // Supply-chain guard: do NOT trust a cached CLI by bare name. Re-resolve it
    // through the SAME trusted resolver used by fresh detection and the spawn site
    // (canonicalizes, rejects repo-local), and require it to still resolve to the
    // exact canonical path recorded when it was cached. A mismatch means the binary
    // was swapped or a higher-priority PATH entry now shadows it → fall back to
    // fresh detection. A cached entry without a recorded path is not reusable.
    if (typeof entry.cliPath !== "string" || entry.cliPath.length === 0) return false;
    const trusted = resolveTrustedCli(cliCmd);
    if (!trusted) return false;
    if (trusted !== entry.cliPath) return false;
    // A resolution cached before this CLI became unusable for review (or cached on
    // another platform) must not be replayed into a guaranteed spawn refusal.
    if (!cliUsableForReview(cliCmd)) return false;
    return true;
  }
  if (provider === "anthropic") return !!envNonEmpty("ANTHROPIC_API_KEY");
  if (provider === "gemini") return !!envNonEmpty("GEMINI_API_KEY");
  if (provider === "openai") return !!envNonEmpty("OPENAI_API_KEY");
  if (provider === "vercel") return !!gatewayCredential();
  return false;
}

// True when an API/gateway credential that OUTRANKS a local CLI in this builder
// context is now reachable. Used to stop a *cached CLI* resolution from shadowing
// a safe API provider that became available after the CLI was cached — a cached
// bare CLI name is re-resolved through the live PATH at spawn, so preferring a
// now-available API (which the fresh ladder would pick anyway) avoids that path.
// Cheap: env reads only, no PATH probing. Order mirrors the ladders in
// configureLLM — note ANTHROPIC ranks BELOW the CLIs inside Claude Code, so an
// ANTHROPIC key there must NOT preempt a cached codex/agy.
export function apiOutranksCliInContext(contextKey, { env = process.env } = {}) {
  const has = (n) => {
    const v = env[n];
    return v != null && String(v).trim() !== "";
  };
  const gw = has("AI_GATEWAY_API_KEY") || has("VERCEL_OIDC_TOKEN");
  const gem = has("GEMINI_API_KEY");
  const oai = has("OPENAI_API_KEY");
  const anth = has("ANTHROPIC_API_KEY");
  if (contextKey === "claudecode") return gem || oai || gw; // ANTHROPIC is below the CLIs here
  if (contextKey === "cursor") return gem || anth || oai || gw;
  return anth || gem || oai || gw; // default / antigravity: all APIs rank above local CLIs
}

// Look up a user-pinned model for a resolved provider from config.defaults.models.
// A local CLI is keyed as `cli:<cmd>` (falling back to the bare command name).
function configuredModelFor(config, provider, cliCmd) {
  const models = config?.defaults?.models;
  if (!models || typeof models !== "object") return null;
  if (provider === "cli") {
    return (cliCmd && (models[`cli:${cliCmd}`] || models[cliCmd])) || null;
  }
  return models[provider] || null;
}

// Resolve the LLM provider from flags, environment variables, or an installed local CLI agent.
export function configureLLM(args) {
  // Auto-detection (no explicit --provider) is the only path that may read/write
  // the resolution cache. An explicit provider — including every call made by the
  // --providers fan-out — is authoritative and never cached.
  const autoDetected = !args.provider;
  let provider = args.provider;
  let apiKey = null;
  let cliCmd = null;
  // Whether the resolution was served from the persisted cache (vs a fresh ladder
  // walk). Only a cache-sourced resolution is invalidated-and-retried on failure.
  let fromCache = false;
  // When auto-detect picks the Gateway inside a builder IDE, prefer a model
  // family that is NOT the builder's (transport ≠ diversity family).
  let gatewayPreferModel = null;

  if (!provider) {
    const isClaudeCodeEnv = !!(process.env.CLAUDECODE || process.env.CLAUDE_CODE);
    const isCursorEnv = process.env.TERM_PROGRAM === "cursor";
    const gw = gatewayCredential();

    // Exclusion set (populated by the fallback path after a provider fails): skip
    // the failed provider/CLI so the ladder ADVANCES to the next candidate instead
    // of reselecting the same one (e.g. an expired key still present in the env).
    const exP = new Set(args.exclude?.providers || []);
    const exC = new Set(args.exclude?.clis || []);
    const canGemini = () => !exP.has("gemini") && envNonEmpty("GEMINI_API_KEY");
    const canOpenai = () => !exP.has("openai") && envNonEmpty("OPENAI_API_KEY");
    const canAnthropic = () => !exP.has("anthropic") && envNonEmpty("ANTHROPIC_API_KEY");
    const canGw = () => !exP.has("vercel") && !!gw;
    const canCli = (c) => !exC.has(c) && isTrustedCliInstalled(c) && cliUsableForReview(c);
    const cursorAgent = resolveCursorAgentCmd();
    const canCursorAgent = () => (cursorAgent && !exC.has(cursorAgent)) ? cursorAgent : null;

    // Fast path: reuse a previously resolved provider for this exact builder
    // context if it is still reachable and still diverse. Falls through to the
    // full ladder on any miss (stale CLI, rotated key, family collision, or the
    // cached provider being in the exclusion set). A cached CLI additionally defers
    // to any API/gateway provider that now outranks local CLIs in this context — so
    // a stale CLI name can't shadow a safe API that became available since caching.
    const ctxKey = builderContextKey();
    const cached = args.config?.cache?.[ctxKey];
    const cliShadowedByApi = cached?.provider === "cli" && apiOutranksCliInContext(ctxKey);
    const cacheExcluded = cached && (exP.has(cached.provider) || (cached.cliCmd && exC.has(cached.cliCmd)));
    if (cached && cachedResolutionUsable(cached) && !cliShadowedByApi && !cacheExcluded) {
      provider = cached.provider;
      cliCmd = cached.cliCmd || null;
      gatewayPreferModel = cached.gatewayPreferModel || null;
      fromCache = true;
    } else if (isClaudeCodeEnv) {
      // Builder is Claude. Prefer a non-Anthropic critic.
      if (canGemini()) {
        provider = "gemini";
      } else if (canOpenai()) {
        provider = "openai";
      } else if (canGw()) {
        provider = "vercel";
        gatewayPreferModel = GATEWAY_FAMILY_MODELS.openai;
      } else if (canCli("codex")) {
        provider = "cli";
        cliCmd = "codex";
      } else if (canCli("agy")) {
        provider = "cli";
        cliCmd = "agy";
      } else if (canCursorAgent()) {
        provider = "cli";
        cliCmd = canCursorAgent();
      } else if (canAnthropic()) {
        provider = "anthropic";
        log.warn("Running in Claude Code, but fell back to Claude for review.");
        log.info("This review is not a pure adversarial review (same provider). To minimize bias, we will execute it in a fresh, isolated context window.");
      } else if (canCli("claude")) {
        provider = "cli";
        cliCmd = "claude";
        log.warn("Running in Claude Code, but fell back to Claude for review.");
        log.info("This review is not a pure adversarial review (same provider). To minimize bias, we will execute it in a fresh, isolated context window.");
      } else {
        throw new Error(NO_LLM_CONFIG_MSG);
      }
    } else if (isCursorEnv) {
      // Builder is Cursor. Prefer an independent critic, then the official agent CLI.
      if (canGemini()) {
        provider = "gemini";
      } else if (canAnthropic()) {
        provider = "anthropic";
      } else if (canOpenai()) {
        provider = "openai";
      } else if (canGw()) {
        provider = "vercel";
        gatewayPreferModel = GATEWAY_FAMILY_MODELS.anthropic;
      } else if (canCli("agy")) {
        provider = "cli";
        cliCmd = "agy";
      } else if (canCli("claude")) {
        provider = "cli";
        cliCmd = "claude";
      } else if (canCli("codex")) {
        provider = "cli";
        cliCmd = "codex";
      } else if (canCursorAgent()) {
        provider = "cli";
        cliCmd = canCursorAgent();
        log.warn("Running in Cursor, but fell back to the Cursor Agent CLI for review.");
        log.info("This review is not a pure adversarial review (same provider). To minimize bias, we will execute it in a fresh, isolated context window.");
      } else {
        throw new Error(NO_LLM_CONFIG_MSG);
      }
    } else {
      // Default auto-detection order (Anthropic > Gemini > OpenAI > Gateway > Local CLIs)
      if (canAnthropic()) {
        provider = "anthropic";
      } else if (canGemini()) {
        provider = "gemini";
      } else if (canOpenai()) {
        provider = "openai";
      } else if (canGw()) {
        provider = "vercel";
      } else if (canCli("claude")) {
        provider = "cli";
        cliCmd = "claude";
      } else if (canCli("codex")) {
        provider = "cli";
        cliCmd = "codex";
      } else if (canCli("agy")) {
        provider = "cli";
        cliCmd = "agy";
      } else if (canCursorAgent()) {
        provider = "cli";
        cliCmd = canCursorAgent();
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
        cliCmd = isTrustedCliInstalled(provider) ? provider : null;
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
        if (isTrustedCliInstalled(provider)) {
          // Installed but unable to complete a review is a DIFFERENT failure from
          // not installed, and it has a different remedy — say which one it is
          // here rather than letting it surface as a spawn refusal mid-review.
          if (!cliUsableForReview(provider)) throw new Error(cliUnusableMessage(provider));
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
  // Model precedence: --model flag > diversity choice (gatewayPreferModel, vercel
  // only) > user-pinned config default > hardcoded strong-tier default. The
  // diversity choice stays supreme so a config pin can never reintroduce the
  // builder's own family inside a builder IDE.
  const cfgModel = configuredModelFor(args.config, provider, cliCmd);
  if (!model && provider !== "cli") {
    // Gate quality tracks model tier — default to the strong tier of each
    // provider, not the cheap one. Override with --model for cost control.
    // Gateway models use provider/model ids.
    if (provider === "gemini") {
      model = cfgModel || "gemini-2.5-pro";
    } else if (provider === "openai") {
      model = cfgModel || "gpt-5";
    } else if (provider === "anthropic") {
      model = cfgModel || "claude-sonnet-4-6";
    } else if (provider === "vercel") {
      model = gatewayPreferModel || cfgModel || GATEWAY_FAMILY_MODELS.anthropic;
    }
  } else if (!model && provider === "cli" && cfgModel) {
    // A local CLI has no hardcoded default model; honor a config pin if present.
    model = cfgModel;
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

  // When the provider was auto-detected, hand back the concrete resolution so the
  // CLI can persist it to the global config cache and skip the detection ladder on
  // subsequent runs. `_autoResolution` is intentionally absent for explicit
  // providers (incl. the --providers fan-out), which must never be cached.
  const result = { provider, model, apiKey, cliCmd, apiBase, customHeaders, timeoutMs, allowUnsandboxedCli, stream: !!args.stream, _fromCache: fromCache };
  if (autoDetected) {
    result._autoResolution = {
      provider,
      cliCmd: cliCmd || null,
      // Record the canonical absolute path a CLI resolved to, so reuse can verify
      // the identical binary still resolves (PATH-hijack / binary-swap defense).
      cliPath: provider === "cli" ? resolvedCliPath(cliCmd) : null,
      family: familyForResolution(provider, cliCmd),
      model: model || null,
      gatewayPreferModel: gatewayPreferModel || null
    };
  }
  return result;
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
const CLI_ONLY_TOKENS = new Set(["codex", "claude", "agy", "agent", "cursor-agent", "copilot", "opencode"]);

// Default Vercel AI Gateway model ids per diversity family (provider/model form).
// THE single source of truth: every gateway model id in this file reads from here.
// Writing one inline again reintroduces the drift this map exists to prevent —
// test/gateway-model-drift.test.mjs fails the build if a literal reappears in src/.
//
// Pins track the strong tier of each family, not the cheap one, and not the
// `-pro`/`-opus` tier above it: gate quality tracks model tier, but so do cost and
// latency, and a review runs on every diff.
export const GATEWAY_FAMILY_MODELS = {
  openai: "openai/gpt-5.6-sol",
  anthropic: "anthropic/claude-sonnet-5",
  // Deliberately a generation behind its siblings, and NOT an oversight. The
  // Gateway catalog carries no stable 3.x *pro* text model: the 3.x line is
  // flash / flash-lite / image variants plus exactly one pro, and that one is
  // `google/gemini-3.1-pro-preview`. Moving off 2.5-pro would mean either
  // dropping to a weaker flash tier or pinning a preview model to a review gate.
  // Revisit when a stable `google/gemini-3.x-pro` ships — the drift test's
  // diagnostic will surface it.
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
    return cliReachableForReview(id) ? build(id) : { id, family, config: null };
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
      if (cand.kind === "cli" && cliReachableForReview(cand.cliCmd)) {
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
  if (cliReachableForReview(id)) return build(id);
  return { id, family: null, config: null };
}

// The local CLI that belongs to each family, for downgrading a non-inlinable API
// provider to its on-host CLI (which can inspect the repo) instead of dropping it.
const FAMILY_CLI = { openai: "codex", anthropic: "claude", gemini: "agy" };

// Return a CLI provider entry for `family` if its local CLI is installed, else null.
export function cliFallbackForFamily(family, args = {}) {
  const cliCmd = FAMILY_CLI[family];
  if (cliCmd && cliReachableForReview(cliCmd)) {
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
        // Preserve the HTTP status so the caller can classify an auth failure
        // (401/403) and invalidate a stale cache-sourced resolution (T21).
        const rethrown = new Error(errorMsg);
        if (typeof err.status === "number") rethrown.status = err.status;
        throw rethrown;
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
