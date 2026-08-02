// Anti-hang process invocation.
//
// Ported in spirit from the upstream Codex plugin's watchdog
// (Robbyfuu/codex-plugin-cc, commit 5545215 — see docs/peer-port-plan.md A2),
// adapted for a standalone CLI that reads raw stdout from four different local
// agents rather than a structured JSON-RPC event stream.
//
// TWO INDEPENDENT GUARDS, NOT ONE.
//
// The obvious design — reset a timer on every chunk, kill when it expires —
// is wrong, and upstream documented why: a long-running operation emits a start
// event and then NOTHING until it completes, so "no output for N seconds" kills
// healthy work. Our exposure is worse than theirs, because we have no structured
// events at all: a local agent can legitimately spend minutes on a silent tool
// call.
//
// So:
//   idleMs  — a fast, well-diagnosed error in the common case (a truly wedged
//             process emits nothing at all). An optimisation.
//   maxMs   — a hard ceiling that fires regardless of activity. THE backstop,
//             and the only thing that can end a run that is producing output
//             forever.
//
// The ceiling is mandatory; the idle guard must never be the only one. The idle
// window is also clamped strictly below the ceiling, because otherwise a caller
// passing a short --timeout would get an idle window that can never fire,
// silently collapsing the design back to a single guard.

import { spawn } from "child_process";
import { StringDecoder } from "string_decoder";
import path from "path";
import { resolveCommand, terminateProcessTree, buildSpawnTarget, sanitizedSpawnEnv } from "./spawn-safe.js";

export const DEFAULT_IDLE_TIMEOUT_MS = 180 * 1000;
export const DEFAULT_MAX_MS = 900 * 1000;
export const DEFAULT_MAX_BUFFER = 10 * 1024 * 1024;

export class ExecIdleError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "ExecIdleError";
    this.code = "EIDLE";
    Object.assign(this, details);
  }
}

export class ExecTimeoutError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "ExecTimeoutError";
    this.code = "ETIMEDOUT";
    Object.assign(this, details);
  }
}

export class ExecBufferError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "ExecBufferError";
    this.code = "EBUFFER";
    Object.assign(this, details);
  }
}

/**
 * Effective guard windows. The ceiling is the caller's timeout when given; the
 * idle window is clamped strictly below it so both guards can actually fire.
 */
export function resolveWindows({ timeoutMs, idleTimeoutMs } = {}) {
  const maxMs = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_MAX_MS;

  // The idle guard is OPT-IN. It was originally on by default at 180s, and
  // dogfooding immediately proved that wrong: we invoke codex with
  // --output-last-message, which suppresses its event stream, so a healthy
  // codex review is legitimately silent for minutes and got killed mid-run.
  //
  // This is the failure mode the two-guard design was meant to avoid, and a
  // default cannot distinguish "silent because wedged" from "silent because
  // working" without the per-item signal we do not have. Killing healthy work
  // is strictly worse than waiting for the ceiling, so the ceiling is the
  // default backstop and the idle guard is enabled only when a caller asks.
  if (!Number.isFinite(idleTimeoutMs) || idleTimeoutMs <= 0) {
    return { maxMs, idleMs: null };
  }

  // Strictly below the ceiling; never below 1s. Without the clamp a short
  // --timeout would leave an idle window that can never fire.
  const idleMs = Math.max(1000, Math.min(idleTimeoutMs, Math.floor(maxMs * 0.9)));
  return { maxMs, idleMs };
}

/**
 * Spawn a command, pipe `input` to stdin, and return its buffered stdout.
 *
 * Rejects with EIDLE (no output for the idle window), ETIMEDOUT (hard ceiling),
 * EBUFFER (output exceeded maxBuffer), or a plain Error on non-zero exit. EVERY
 * rejection carries the stdout/stderr captured so far — T14 parses that stderr
 * for resume ids, and discarding it would make that impossible.
 *
 * The setTimeout/clearTimeout seams exist so the timing behaviour is testable
 * with fake timers instead of real wall-clock sleeps.
 */
// ALLOWLIST, deliberately not a denylist.
//
// sanitizedSpawnEnv only sanitizes PATH — it does NOT strip NODE_OPTIONS,
// LD_PRELOAD, DYLD_INSERT_LIBRARIES, BASH_ENV, GIT_* and the rest, because until
// now nothing could add them: the child simply inherited a fixed environment. This
// seam is the first thing that can put a variable INTO a child, so enumerating
// what may pass is the only version of it that stays safe as callers are added.
// A denylist here would have to grow to cover every loader and interpreter hook on
// every platform, and would be wrong by omission the first time one is missed.
const ENV_OVERRIDE_ALLOWLIST = new Set(["OPENCODE_CONFIG"]);

/**
 * Merge caller-supplied variables into the sanitized environment. Additive only:
 * returns a new object, never mutates the sanitized env, and accepts only keys on
 * the allowlist above. Values must be caller-generated — nothing derived from the
 * reviewed diff or from repository content may be routed through here.
 */
export function applyEnvOverrides(env, overrides) {
  if (!overrides || typeof overrides !== "object") return env;
  const merged = { ...env };
  for (const [key, value] of Object.entries(overrides)) {
    if (!ENV_OVERRIDE_ALLOWLIST.has(key)) {
      throw new Error(
        `Refusing to set "${key}" in a child environment: only ` +
          `${[...ENV_OVERRIDE_ALLOWLIST].join(", ")} may be overridden. Loader and ` +
          `interpreter hooks (NODE_OPTIONS, LD_PRELOAD, BASH_ENV, GIT_*) would let a ` +
          `child run code the trust boundary is meant to exclude.`
      );
    }
    if (value == null) continue;
    merged[key] = String(value);
  }
  return merged;
}

export function spawnWithWatchdog(cmd, args = [], options = {}) {
  const {
    input = null,
    timeoutMs,
    idleTimeoutMs,
    maxBuffer = DEFAULT_MAX_BUFFER,
    streamStdout = false,
    // Explicit, never inferred: the caller knows whether argv carries the
    // reviewed prompt (argv fallback) or only our own constant flags.
    argsContainUntrusted = true,
    // Extra environment for the child, applied ON TOP OF the sanitized env — it
    // can only ADD variables, never weaken the trust boundary. Keys that carry
    // that boundary (PATH and its casings) are dropped, so an override cannot
    // reintroduce a repository-local directory into the child's lookup path.
    // Values must be caller-generated: nothing derived from the reviewed diff or
    // from repository content may be routed through here.
    envOverrides = null,
    setTimeoutImpl = setTimeout,
    clearTimeoutImpl = clearTimeout,
    spawnImpl = spawn,
    terminateImpl = terminateProcessTree,
    // Progress goes to STDERR. stdout carries the --json result and the --loop
    // NDJSON event stream, and interleaving raw provider output into it produces
    // unparseable machine output for every CI consumer.
    stdoutSink = (chunk) => process.stderr.write(chunk),
    // Observe stderr as it arrives, including on runs that exit 0. Observation
    // only: it cannot alter the resolved value or suppress an error.
    onStderr = null
  } = options;

  const { maxMs, idleMs } = resolveWindows({ timeoutMs, idleTimeoutMs });

  return new Promise((resolve, reject) => {
    // Accept either a bare command name (resolved here) or a path the caller
    // already resolved. execCli resolves first so it can raise a better error,
    // and re-running the bare-name guard on that absolute path would reject it.
    const resolved = path.isAbsolute(cmd) ? cmd : resolveCommand(cmd);
    if (!resolved) {
      reject(new Error(`Command "${cmd}" was not found on PATH.`));
      return;
    }

    let stdout = "";
    let stderr = "";
    let byteCount = 0;
    // Per-chunk Buffer.toString() corrupts any multibyte code point split
    // across chunk boundaries, substituting replacement characters. A review can
    // stay valid JSON while its evidence or file paths are silently mutated —
    // and mutated evidence then fails grounding and loses confidence. Decode
    // incrementally so split sequences are carried to the next chunk.
    const outDecoder = new StringDecoder("utf8");
    const errDecoder = new StringDecoder("utf8");
    let settled = false;
    let idleTimer = null;
    let hardTimer = null;

    // Route Windows .cmd/.bat shims through the interpreter explicitly.
    const target = buildSpawnTarget(resolved, args, { argsContainUntrusted });
    const child = spawnImpl(target.command, target.args, {
      stdio: ["pipe", "pipe", "pipe"],
      shell: false,
      windowsHide: true,
      // Set only for the cmd.exe shim route, which quotes its own command string
      // for /s. Node would otherwise backslash-escape those quotes and cmd.exe
      // would split a spaced shim path at the first space.
      windowsVerbatimArguments: target.windowsVerbatimArguments === true,
      // The child does its OWN lookups (env-shebang interpreters, .cmd wrappers
      // falling back to a bare node) from what it inherits — see sanitizedSpawnEnv.
      env: applyEnvOverrides(sanitizedSpawnEnv(), envOverrides),
      // Own process group so terminateProcessTree can signal the whole tree.
      detached: process.platform !== "win32"
    });

    const clearTimers = () => {
      if (idleTimer !== null) { clearTimeoutImpl(idleTimer); idleTimer = null; }
      if (hardTimer !== null) { clearTimeoutImpl(hardTimer); hardTimer = null; }
    };

    // One-shot and terminal: once we settle, no further callback may fire.
    const settle = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimers();
      fn(value);
    };

    const kill = () => {
      const pid = child.pid;
      // SIGTERM is a REQUEST; a process that traps or ignores it keeps running.
      // The child is detached, so it outlives us — and we reject immediately
      // after this, whereupon the CLI calls process.exit(). A deferred
      // escalation timer is therefore UNREACHABLE: it was scheduled, unref-ed,
      // and never ran. Escalate synchronously instead. The process has already
      // been judged hung, and terminateProcessTree stays gated on liveness, so
      // the SIGKILL is a no-op if SIGTERM already worked.
      try { terminateImpl(pid); } catch { /* already gone */ }
      // The SIGKILL must NOT re-gate on the direct child: SIGTERM often reaps
      // the group leader while a descendant ignores it, and a liveness probe on
      // the dead leader would then skip signalling the still-live group.
      try { terminateImpl(pid, { signal: "SIGKILL", requireAlive: false }); } catch { /* already gone */ }
    };

    const failWith = (ErrCls, message, extra) => {
      kill();
      settle(reject, new ErrCls(message, { stdout, stderr, ...extra }));
    };

    const armIdle = () => {
      if (settled || idleMs === null) return; // opt-in; see resolveWindows
      if (idleTimer !== null) clearTimeoutImpl(idleTimer);
      idleTimer = setTimeoutImpl(() => {
        idleTimer = null;
        failWith(
          ExecIdleError,
          `No output from "${cmd}" for ${Math.round(idleMs / 1000)}s; treating it as hung. ` +
          `Retry with --timeout <larger>, or --stream to watch it work.`,
          { idleMs }
        );
      }, idleMs);
      idleTimer?.unref?.();
    };

    hardTimer = setTimeoutImpl(() => {
      hardTimer = null;
      failWith(
        ExecTimeoutError,
        `"${cmd}" exceeded ${Math.round(maxMs / 1000)}s; retry with --timeout <larger>.`,
        { timeoutMs: maxMs }
      );
    }, maxMs);
    hardTimer?.unref?.();

    const onChunk = (which) => (buf) => {
      if (settled) return;
      // maxBuffer is documented in BYTES; string .length counts UTF-16 units.
      byteCount += Buffer.isBuffer(buf) ? buf.length : Buffer.byteLength(String(buf));
      const text = which === "stdout" ? outDecoder.write(buf) : errDecoder.write(buf);
      if (which === "stdout") {
        stdout += text;
        if (text && streamStdout) stdoutSink(text);
      } else {
        stderr += text;
        // A rejection carries stderr, but a SUCCESS resolves with stdout alone —
        // so a caller that must inspect stderr on a clean exit (an agent CLI that
        // warns about a silent sandbox downgrade and then exits 0) has no other
        // way to see it. Optional, and never changes the resolve shape.
        if (text && onStderr) onStderr(text);
      }
      if (byteCount > maxBuffer) {
        failWith(
          ExecBufferError,
          `"${cmd}" produced more than ${maxBuffer} bytes of output; aborting.`,
          { maxBuffer }
        );
        return;
      }
      // Any byte on either stream is evidence of life.
      armIdle();
    };

    child.stdout?.on("data", onChunk("stdout"));
    child.stderr?.on("data", onChunk("stderr"));

    child.on("error", (err) => {
      settle(reject, Object.assign(err, { stdout, stderr }));
    });

    child.on("close", (code, signal) => {
      if (settled) return;
      if (code === 0) {
        settle(resolve, stdout.trim());
        return;
      }
      const err = new Error(
        `"${cmd}" exited with ${signal ? `signal ${signal}` : `code ${code}`}.` +
        (stderr.trim() ? `\n${stderr.trim()}` : "")
      );
      Object.assign(err, { stdout, stderr, code, signal });
      settle(reject, err);
    });

    // ALWAYS close stdin, even with no input. execFileSync closes it for you;
    // spawn does not. A CLI reading from an open, never-closed stdin waits
    // forever — the argv-fallback path (input === null) hung and then answered
    // conversationally instead of reviewing.
    if (child.stdin) {
      child.stdin.on("error", () => { /* child may exit before we finish writing */ });
      child.stdin.end(input ?? "", "utf8");
    }

    armIdle();
  });
}
