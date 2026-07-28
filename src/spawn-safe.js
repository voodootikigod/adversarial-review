// Safe process spawning primitives.
//
// Two concerns live here, both ported from the upstream Codex plugin
// (Robbyfuu/codex-plugin-cc, commits c1cc2b4 and 109ff6d — see
// docs/peer-port-plan.md sections A1 and A4):
//
//  1. Resolving a command to an absolute path so every spawn site can use
//     shell:false on every platform.
//  2. Terminating a process TREE without ever signalling a stale or recycled
//     pid.
//
// Both are prerequisites for the anti-hang watchdog (T13): a watchdog that
// kills only the direct child leaves the CLI's own grandchildren running, which
// is the hang it exists to end.

import { spawnSync } from "child_process";
import path from "path";
import { isInsideTrustRoot, reviewTrustRoot } from "./trust-root.js";
import { resolveCommand } from "./resolve-command.js";

// Re-exported: this was resolveCommand's original home, and callers import it here.
export { resolveCommand };

/**
 * Resolve a command to a canonical absolute path OUTSIDE the repository under
 * review, or null.
 *
 * THE resolver for every child process this tool starts. A bare name is not a
 * command, it is a lookup performed in an environment the reviewed repository can
 * influence: Windows searches the current directory (the repo) before PATH, and
 * npm/npx put ./node_modules/.bin at the front of PATH on every platform. Any
 * spawn site that skips this — including probes, version checks, and helpers that
 * "just" read a number — hands the repository a way to run code as the reviewer,
 * usually before the sandbox meant to contain it exists.
 */
export function resolveTrustedCommand(cmd) {
  return resolveCommand(cmd, { excludeRoots: [reviewTrustRoot()] });
}

// Windows batch shims (.cmd/.bat) are NOT executable images: CreateProcess
// cannot run them, they require the command interpreter. npm installs
// codex/claude/agy exactly that way, so the shim must be routed through
// cmd.exe.
//
// This interpreter route is NOT argument-safe. shell:false stops Node from
// building a command string, but cmd.exe still re-parses everything after /c
// under its own quoting rules, so an explicit argv array does not restore
// metacharacter safety.
//
// Callers therefore must not put attacker-influenceable data in argv on this
// path. The distinction is authorship, not quantity: invocation flags are
// constants authored in this repository, while the reviewed prompt is untrusted.
// Callers declare which they are passing via `argsContainUntrusted`; only the
// untrusted case is refused, so our own flags still reach npm-installed CLIs.
//
// `/d` skips AutoRun registry commands, `/s` fixes quote handling, `/c` runs and
// exits. The interpreter itself is chosen by interpreterPath below, which never
// returns a bare name; SHELL is never used.
const BATCH_EXTENSIONS = new Set([".cmd", ".bat"]);

/** Is `resolvedPath` a Windows batch shim, i.e. reachable only through cmd.exe? */
export function isWindowsBatchShim(resolvedPath, { platform = process.platform } = {}) {
  return platform === "win32" && BATCH_EXTENSIONS.has(path.extname(String(resolvedPath)).toLowerCase());
}

export class WindowsArgvUnsafeError extends Error {
  constructor(message) {
    super(message);
    this.name = "WindowsArgvUnsafeError";
    this.code = "EWINARGV";
  }
}

// Last-resort interpreter location, used when the environment supplies nothing
// trustworthy. A literal, not a default parameter, so no env value can shadow it.
const DEFAULT_SYSTEM_ROOT = "C:\\Windows";

// The command interpreter must be an ABSOLUTE, trusted path, for exactly the
// reason taskkillPath below is: Windows resolves an unqualified executable name
// against the CURRENT DIRECTORY before the system directories, and our current
// directory is the untrusted repository under review. A bare "cmd.exe" would let
// a repo that ships cmd.exe run as the reviewer — and it would run BEFORE the
// trusted CLI it was supposed to launch, so resolving the CLI safely buys
// nothing.
//
// EVERY candidate is validated the same way, including the SystemRoot-derived
// one: a relative SystemRoot ("." or "tools") yields a relative command that
// Windows resolves from the repository, and an absolute SystemRoot can still
// point INTO it. Validating only ComSpec would leave that path wide open.
// Candidates are tried in order of specificity and the first trusted one wins;
// if none is trustworthy we fail closed rather than guess.
//
// Reached only from the win32 branch, so Windows path semantics apply even when
// this runs on a POSIX host under the `platform` test seam — path.join would
// otherwise emit "C:\Windows/System32/cmd.exe", which path.isAbsolute rejects.
// Default containment check for an interpreter candidate. On a non-Windows host
// this is always false, and deliberately so: the trust root is a POSIX path, a
// Windows path can never be inside it, and handing "C:\Windows\..." to the POSIX
// resolver would treat it as a RELATIVE name and resolve it against the cwd —
// the repository — refusing every interpreter on a false positive. The real
// containment check runs where it means something, and the `isInsideRoot` seam
// exercises the refusal path everywhere else.
function interpreterInsideTrustRoot(candidate) {
  if (process.platform !== "win32") return false;
  return isInsideTrustRoot(candidate);
}

export function interpreterPath(env = process.env, { isInsideRoot = interpreterInsideTrustRoot } = {}) {
  const configuredRoot = env.SystemRoot || env.SYSTEMROOT;
  const candidates = [
    env.ComSpec || env.COMSPEC,
    configuredRoot ? path.win32.join(configuredRoot, "System32", "cmd.exe") : null,
    path.win32.join(DEFAULT_SYSTEM_ROOT, "System32", "cmd.exe")
  ];

  for (const candidate of candidates) {
    if (!candidate || !path.win32.isAbsolute(candidate)) continue;
    let inside;
    try {
      inside = isInsideRoot(candidate);
    } catch {
      // A trust root that cannot be established is not a licence to trust the
      // value — treat the candidate as untrusted and move on.
      inside = true;
    }
    if (!inside) return candidate;
  }

  throw new WindowsArgvUnsafeError(
    "Refusing to launch the Windows command interpreter: no absolute interpreter path outside " +
    "the repository under review could be established. Check ComSpec and SystemRoot — a relative " +
    "value, or one pointing inside the repository, lets the reviewed code run as the reviewer."
  );
}

// What may cross a cmd.exe command line, for a token that is ALWAYS quoted.
//
// Quoting neutralizes the separators and redirections (& | < > ^) and block
// syntax (parentheses) — they are literal inside a quoted token. Three things
// survive quoting and so remain refused: the quote character itself (it ends the
// token), % (variable expansion happens inside quotes), and ! (delayed expansion
// when it is enabled). Control characters go too: CR and LF END a command to
// cmd.exe, so an argument containing one starts another command outright.
//
// One policy now covers the shim path and the arguments, because both are quoted
// the same way. Splitting them was what rejected "C:\\Program Files (x86)" and,
// on the argument side, Codex's own --output-last-message path under a TEMP
// directory like "C:\\Users\\Jane (Work)\\AppData\\Local\\Temp".
const CMD_UNSAFE_IN_QUOTES = /["%!]|[\x00-\x1f\x7f]/;

// Quote one token of a cmd.exe command string. EVERY token is quoted, not just
// the ones containing spaces: the quoting is what makes the permitted characters
// (& | < > ^ parentheses) literal, so a token that skipped it would be parsed as
// command syntax. Nothing reaching here contains a quote or a control character —
// the guard above has already run — so wrapping is sufficient with no escaping.
function quoteForCmd(token) {
  return `"${token}"`;
}

export function buildSpawnTarget(
  resolvedPath,
  args = [],
  // isInsideRoot is a seam so the ComSpec trust decision is testable without a
  // real Windows repository; production callers pass none of these.
  { platform = process.platform, env = process.env, argsContainUntrusted = true, isInsideRoot = interpreterInsideTrustRoot } = {}
) {
  if (isWindowsBatchShim(resolvedPath, { platform })) {
    // Refuse only when a caller wants to put ATTACKER-INFLUENCEABLE data on the
    // command line — the argv prompt form, which embeds the whole reviewed diff.
    // Refusing every argument instead would reject our own constant flags and
    // break every npm-installed CLI on Windows.
    if (argsContainUntrusted && args.length > 0) {
      throw new WindowsArgvUnsafeError(
        `Cannot safely pass untrusted arguments to the Windows batch shim "${resolvedPath}": ` +
        `cmd.exe re-parses them, so the reviewed diff could execute as commands. ` +
        `Use a provider whose prompt travels over stdin (claude, codex), an API provider, ` +
        `or install this CLI as a native executable rather than an npm .cmd shim.`
      );
    }
    // The shim path and every argument land on the same command line after /c and
    // are quoted the same way, so one policy governs both. Checked separately only
    // to report the right remedy: a bad path is where the CLI is installed, a bad
    // argument is something we generated.
    if (CMD_UNSAFE_IN_QUOTES.test(resolvedPath)) {
      throw new WindowsArgvUnsafeError(
        `Cannot launch the Windows batch shim "${resolvedPath}" through cmd.exe: its path ` +
        `contains a quote, %, !, or a control character, which survive quoting and are read ` +
        `as command syntax. Install this CLI under a path without them, install it as a ` +
        `native executable rather than an npm .cmd shim, or use an API provider.`
      );
    }
    // Belt and braces: a future edit to the flag builders must not be able to
    // reintroduce the hole just by declaring its arguments trusted.
    const offender = args.find((a) => CMD_UNSAFE_IN_QUOTES.test(String(a)));
    if (offender !== undefined) {
      throw new WindowsArgvUnsafeError(
        `Refusing to pass argument ${JSON.stringify(offender)} to the Windows batch shim ` +
        `"${resolvedPath}": it contains a quote, %, !, or a control character, which survive ` +
        `cmd.exe quoting.`
      );
    }
    // `/s` removes the FIRST and LAST quote of the string following `/c`. Passing
    // the path and flags as separate Node arguments produces exactly one quote
    // pair — the one around the path — so /s strips it and cmd.exe then splits
    // "C:\Program Files (x86)\...\claude.cmd" at the first space and tries to run
    // "C:\Program". The fix is the outer pair cmd.exe expects to consume: build
    // the command string ourselves, wrap the whole thing in quotes, and pass it
    // verbatim so Node does not re-escape our quoting. This is the same shape
    // Node itself uses for shell:true on Windows.
    const command = [resolvedPath, ...args.map(String)].map(quoteForCmd).join(" ");
    return {
      command: interpreterPath(env, { isInsideRoot }),
      args: ["/d", "/s", "/c", `"${command}"`],
      viaInterpreter: true,
      // Node must not requote: it would backslash-escape the quotes above.
      windowsVerbatimArguments: true
    };
  }
  return { command: resolvedPath, args, viaInterpreter: false };
}

// taskkill must be an ABSOLUTE, TRUSTED path, for the same reason the command
// interpreter must be: Windows resolves a bare executable name against the
// CURRENT DIRECTORY before PATH, and our current directory is the untrusted
// repository under review — so a repo shipping taskkill.exe would be executed
// with the reviewer's privileges the moment a guard fired.
//
// SystemRoot is an environment value and gets the same validation as ComSpec: a
// relative value ('.') resolves inside the repository, and an absolute one can
// point into it. Returns null when no trusted taskkill can be established;
// callers fall back to direct process termination rather than guess.
export function taskkillPath(env = process.env, { isInsideRoot = interpreterInsideTrustRoot } = {}) {
  const configuredRoot = env.SystemRoot || env.SYSTEMROOT;
  const candidates = [
    configuredRoot ? path.win32.join(configuredRoot, "System32", "taskkill.exe") : null,
    path.win32.join(DEFAULT_SYSTEM_ROOT, "System32", "taskkill.exe")
  ];
  for (const candidate of candidates) {
    if (!candidate || !path.win32.isAbsolute(candidate)) continue;
    let inside;
    try {
      inside = isInsideRoot(candidate);
    } catch {
      inside = true;
    }
    if (!inside) return candidate;
  }
  return null;
}

/**
 * Is `pid` currently alive? Probe with signal 0; ESRCH means gone. Any other
 * error (notably EPERM) means the process exists and we merely cannot signal it.
 *
 * Requires pid > 0. `kill(0, …)` and `kill(-0, …)` are process-GROUP relative
 * and would target the CALLER'S OWN group — meaningless as a liveness probe and
 * dangerous as a kill. Requiring a positive pid makes that structurally
 * impossible rather than merely unlikely.
 */
export function isPidAlive(pid, killImpl = process.kill.bind(process)) {
  if (typeof pid !== "number" || !Number.isFinite(pid) || pid <= 0) return false;
  try {
    killImpl(pid, 0);
    return true;
  } catch (error) {
    if (error && error.code === "ESRCH") return false;
    return true;
  }
}

// Minimal spawnSync wrapper used only for taskkill. shell:false unconditionally
// — never selected from the environment.
function runCommand(command, args = [], options = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    stdio: "pipe",
    shell: false,
    windowsHide: true,
    ...options
  });
  return {
    status: result.status ?? null,
    error: result.error ?? null,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? ""
  };
}

function looksLikeMissingProcess(text) {
  return /not found|no running instance|cannot find|does not exist|no such process/i.test(text);
}

/**
 * Terminate a process and its descendants.
 *
 * POSIX signals the process GROUP (negative pid) so the CLI's own children die
 * with it, falling back to the bare pid. Windows uses `taskkill /T /F`, falling
 * back to a direct kill if taskkill is unavailable.
 *
 * Gated on liveness first: a stale pid from a killed run may have been REUSED by
 * an unrelated process, and signalling it would kill a bystander.
 */
export function terminateProcessTree(pid, options = {}) {
  const platform = options.platform ?? process.platform;
  const killImpl = options.killImpl ?? process.kill.bind(process);
  // SIGTERM by default; callers escalate to SIGKILL for a process that ignored it.
  const signal = options.signal ?? "SIGTERM";
  // A SIGKILL escalation deliberately skips the liveness gate: the leader may
  // already be reaped while descendants in the same group are still running.
  const requireAlive = options.requireAlive ?? true;
  const runCommandImpl = options.runCommandImpl ?? runCommand;

  if (requireAlive && !isPidAlive(pid, killImpl)) {
    return { attempted: false, delivered: false, method: null };
  }
  // Even when the gate is skipped, never signal a non-positive pid: kill(-0)
  // and kill(0) are group-relative and would target our OWN process group.
  if (typeof pid !== "number" || !Number.isFinite(pid) || pid <= 0) {
    return { attempted: false, delivered: false, method: null };
  }

  if (platform === "win32") {
    const taskkill = taskkillPath(options.env, options.isInsideRoot ? { isInsideRoot: options.isInsideRoot } : {});
    // No trusted taskkill means no tree kill — terminate the process directly
    // rather than run whatever the repository happens to have put there.
    if (!taskkill) {
      try {
        killImpl(pid, signal);
        return { attempted: true, delivered: true, method: "kill" };
      } catch (error) {
        if (error?.code === "ESRCH") return { attempted: true, delivered: false, method: "kill" };
        throw error;
      }
    }
    const result = runCommandImpl(taskkill, ["/PID", String(pid), "/T", "/F"]);
    if (!result.error && result.status === 0) {
      return { attempted: true, delivered: true, method: "taskkill" };
    }
    const combined = `${result.stderr}\n${result.stdout}`.trim();
    if (!result.error && looksLikeMissingProcess(combined)) {
      return { attempted: true, delivered: false, method: "taskkill" };
    }
    if (result.error?.code === "ENOENT") {
      try {
        killImpl(pid, signal);
        return { attempted: true, delivered: true, method: "kill" };
      } catch (error) {
        if (error?.code === "ESRCH") return { attempted: true, delivered: false, method: "kill" };
        throw error;
      }
    }
    if (result.error) throw result.error;
    return { attempted: true, delivered: false, method: "taskkill" };
  }

  try {
    killImpl(-pid, signal);
    return { attempted: true, delivered: true, method: "process-group" };
  } catch (error) {
    if (error?.code === "ESRCH") {
      return { attempted: true, delivered: false, method: "process-group" };
    }
    // No process group (or not permitted to signal it) — fall back to the child.
    try {
      killImpl(pid, signal);
      return { attempted: true, delivered: true, method: "process" };
    } catch (innerError) {
      if (innerError?.code === "ESRCH") return { attempted: true, delivered: false, method: "process" };
      throw innerError;
    }
  }
}
