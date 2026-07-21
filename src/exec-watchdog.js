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
import { resolveCommand, terminateProcessTree, buildSpawnTarget } from "./spawn-safe.js";

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
export function spawnWithWatchdog(cmd, args = [], options = {}) {
  const {
    input = null,
    timeoutMs,
    idleTimeoutMs,
    maxBuffer = DEFAULT_MAX_BUFFER,
    streamStdout = false,
    setTimeoutImpl = setTimeout,
    clearTimeoutImpl = clearTimeout,
    spawnImpl = spawn,
    terminateImpl = terminateProcessTree,
    // Progress goes to STDERR. stdout carries the --json result and the --loop
    // NDJSON event stream, and interleaving raw provider output into it produces
    // unparseable machine output for every CI consumer.
    stdoutSink = (chunk) => process.stderr.write(chunk)
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
    const target = buildSpawnTarget(resolved, args);
    const child = spawnImpl(target.command, target.args, {
      stdio: ["pipe", "pipe", "pipe"],
      shell: false,
      windowsHide: true,
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
      try { terminateImpl(child.pid); } catch { /* already gone */ }
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
