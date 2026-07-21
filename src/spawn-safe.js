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
  const extensions = platform !== "win32"
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
  const runCommandImpl = options.runCommandImpl ?? runCommand;

  if (!isPidAlive(pid, killImpl)) {
    return { attempted: false, delivered: false, method: null };
  }

  if (platform === "win32") {
    const result = runCommandImpl("taskkill", ["/PID", String(pid), "/T", "/F"]);
    if (!result.error && result.status === 0) {
      return { attempted: true, delivered: true, method: "taskkill" };
    }
    const combined = `${result.stderr}\n${result.stdout}`.trim();
    if (!result.error && looksLikeMissingProcess(combined)) {
      return { attempted: true, delivered: false, method: "taskkill" };
    }
    if (result.error?.code === "ENOENT") {
      try {
        killImpl(pid, "SIGTERM");
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
    killImpl(-pid, "SIGTERM");
    return { attempted: true, delivered: true, method: "process-group" };
  } catch (error) {
    if (error?.code === "ESRCH") {
      return { attempted: true, delivered: false, method: "process-group" };
    }
    // No process group (or not permitted to signal it) — fall back to the child.
    try {
      killImpl(pid, "SIGTERM");
      return { attempted: true, delivered: true, method: "process" };
    } catch (innerError) {
      if (innerError?.code === "ESRCH") return { attempted: true, delivered: false, method: "process" };
      throw innerError;
    }
  }
}
