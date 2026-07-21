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
import fs from "fs";
import path from "path";

// Only bare command tokens are resolvable. A path separator or shell
// metacharacter reaching a spawn site is a bug in the caller, not a lookup to
// perform — rejecting it here keeps that from becoming an injection.
const BARE_COMMAND = /^[A-Za-z0-9._-]+$/;

/**
 * Resolve a bare command name to an absolute executable path, or null.
 *
 * The `platform`/`env` seam exists so the Windows PATHEXT behaviour is testable
 * on a POSIX machine; production callers pass neither.
 */
export function resolveCommand(cmd, { platform = process.platform, env = process.env } = {}) {
  if (typeof cmd !== "string" || !BARE_COMMAND.test(cmd)) return null;

  const pathDirs = (env.PATH || "").split(path.delimiter).filter(Boolean);
  // On Windows a bare name does not identify a file: `claude` is `claude.cmd`
  // for anything installed by npm. Resolving the real filename ourselves is
  // what lets us drop `shell: true`, which was only ever there to make the
  // shell perform this lookup for us.
  const extensions = platform === "win32"
    ? (env.PATHEXT || ".EXE;.CMD;.BAT;.COM").split(";").filter(Boolean).map((e) => e.toLowerCase())
    : [""];

  for (const dir of pathDirs) {
    for (const ext of extensions) {
      const file = ext && cmd.toLowerCase().endsWith(ext) ? cmd : `${cmd}${ext}`;
      const candidate = path.join(dir, file);
      try {
        // On win32 the X_OK bit is not meaningful, so existence + regular file
        // is the strongest check available there.
        if (platform !== "win32") fs.accessSync(candidate, fs.constants.X_OK);
        if (fs.statSync(candidate).isFile()) return path.resolve(candidate);
      } catch {
        // Not this candidate; keep looking.
      }
    }
  }
  return null;
}

// Windows batch shims (.cmd/.bat) are NOT executable images: CreateProcess
// cannot run them, they require the command interpreter. npm installs
// codex/claude/agy exactly that way, so the shim must be routed through
// cmd.exe.
//
// IMPORTANT — THIS IS NOT ARGUMENT-SAFE, AND DOES NOT CLAIM TO BE.
// An earlier revision asserted that passing an explicit argv array (rather than
// shell:true) restored metacharacter safety. That is false: Node serializes
// these args into a command line and cmd.exe re-parses everything after /c
// under its own quoting rules. Using shell:false avoids Node's string-building,
// not cmd.exe's parsing.
//
// So callers MUST NOT pass attacker-influenceable data as argv on this path.
// The distinction is authorship, not quantity: our own invocation flags are
// constants authored in this repository, while the reviewed prompt is untrusted
// and travels over stdin on the primary path. Callers declare which they are
// passing via `argsContainUntrusted`, and only the untrusted case is refused.
//
// An earlier revision refused ALL arguments, which rejected our own flags too
// and broke every npm-installed CLI on Windows — worse than the unsafe
// behaviour it replaced. Full Windows handling, including verifying any of this
// on an actual Windows runner, is tracked in T19.
//
// `/d` skips AutoRun registry commands, `/s` fixes quote handling, `/c` runs and
// exits. ComSpec is the documented interpreter location; SHELL is never used.
const BATCH_EXTENSIONS = new Set([".cmd", ".bat"]);

export class WindowsArgvUnsafeError extends Error {
  constructor(message) {
    super(message);
    this.name = "WindowsArgvUnsafeError";
    this.code = "EWINARGV";
  }
}

// What may cross a cmd.exe command line. Our own invocation flags are authored
// here and contain none of it; the reviewed prompt is the untrusted value, and
// on the primary path it travels over stdin, which cmd.exe never parses.
const CMD_METACHARACTERS = /[&|<>^"%!()]/;

export function buildSpawnTarget(
  resolvedPath,
  args = [],
  { platform = process.platform, env = process.env, argsContainUntrusted = true } = {}
) {
  if (platform === "win32" && BATCH_EXTENSIONS.has(path.extname(resolvedPath).toLowerCase())) {
    // Refuse only when a caller wants to put ATTACKER-INFLUENCEABLE data on the
    // command line — that is the argv fallback, which embeds the whole prompt.
    // Refusing every argument instead would reject our own constant flags and
    // break every npm-installed CLI on Windows, which is worse than the unsafe
    // behaviour it replaced.
    if (argsContainUntrusted && args.length > 0) {
      throw new WindowsArgvUnsafeError(
        `Cannot safely pass untrusted arguments to the Windows batch shim "${resolvedPath}": ` +
        `cmd.exe re-parses them and this path is not argument-safe. ` +
        `The prompt must travel over stdin. Tracked in T19.`
      );
    }
    // Belt and braces: even "trusted" flags must be metacharacter-free, so a
    // future edit to the flag builders cannot quietly reintroduce the hole.
    const offender = args.find((a) => CMD_METACHARACTERS.test(String(a)));
    if (offender !== undefined) {
      throw new WindowsArgvUnsafeError(
        `Refusing to pass argument ${JSON.stringify(offender)} to the Windows batch shim ` +
        `"${resolvedPath}": it contains cmd.exe metacharacters. Tracked in T19.`
      );
    }
    const comspec = env.ComSpec || env.COMSPEC || "cmd.exe";
    return { command: comspec, args: ["/d", "/s", "/c", resolvedPath, ...args], viaInterpreter: true };
  }
  return { command: resolvedPath, args, viaInterpreter: false };
}

// taskkill must be an ABSOLUTE path. Windows resolves a bare executable name
// against the CURRENT DIRECTORY before PATH, and our current directory is the
// untrusted repository under review — so a repo shipping taskkill.exe would be
// executed with the reviewer's privileges the moment a guard fired.
function taskkillPath(env = process.env) {
  const root = env.SystemRoot || env.SYSTEMROOT || "C:\\Windows";
  return path.join(root, "System32", "taskkill.exe");
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
  const runCommandImpl = options.runCommandImpl ?? runCommand;

  if (!isPidAlive(pid, killImpl)) {
    return { attempted: false, delivered: false, method: null };
  }

  if (platform === "win32") {
    const result = runCommandImpl(taskkillPath(options.env), ["/PID", String(pid), "/T", "/F"]);
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
