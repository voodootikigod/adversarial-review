import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import {
  spawnWithWatchdog,
  resolveWindows,
  DEFAULT_IDLE_TIMEOUT_MS,
  DEFAULT_MAX_MS,
  DEFAULT_MAX_BUFFER
} from "../src/exec-watchdog.js";

// ─── window resolution ──────────────────────────────────────────────────────

test("T13 AC14: the configured timeout IS the ceiling; the default only fills in", () => {
  assert.deepEqual(resolveWindows({ timeoutMs: 60_000 }).maxMs, 60_000);
  assert.deepEqual(resolveWindows({}).maxMs, DEFAULT_MAX_MS);
});

test("T13 AC14: an explicitly requested idle window is clamped below the ceiling", () => {
  // Without the clamp, --timeout 60 with a 180s idle request leaves a guard
  // that can never fire — silently collapsing the design back to one guard.
  const { idleMs, maxMs } = resolveWindows({ timeoutMs: 60_000, idleTimeoutMs: 180_000 });
  assert.equal(maxMs, 60_000);
  assert.ok(idleMs < maxMs, `idle ${idleMs} must be < ceiling ${maxMs}`);
  assert.ok(idleMs > 0);
});

test("T13: the idle guard is OFF unless a caller explicitly asks for it", () => {
  // Dogfooding killed a healthy codex review: we invoke codex with
  // --output-last-message, which suppresses its event stream, so silence means
  // "working", not "wedged". No default can tell those apart without the
  // per-item signal we do not have, and killing healthy work is strictly worse
  // than waiting for the ceiling.
  assert.equal(resolveWindows({ timeoutMs: DEFAULT_MAX_MS }).idleMs, null);
  assert.equal(resolveWindows({}).idleMs, null);
  assert.equal(resolveWindows({ timeoutMs: 60_000, idleTimeoutMs: 0 }).idleMs, null);
  // ...but honored when requested.
  assert.equal(
    resolveWindows({ timeoutMs: 600_000, idleTimeoutMs: DEFAULT_IDLE_TIMEOUT_MS }).idleMs,
    DEFAULT_IDLE_TIMEOUT_MS
  );
});

// ─── fake-timer harness ─────────────────────────────────────────────────────
// Injected timers keep these tests instant and deterministic; real sleeps are
// what make spawn-heavy suites flaky under parallel load (.adlc T8).

function fakeClock() {
  let now = 0;
  let seq = 0;
  const timers = new Map();
  const setTimeoutImpl = (fn, ms) => {
    const id = ++seq;
    timers.set(id, { fn, at: now + ms });
    return { id, unref() { this.unrefed = true; return this; } };
  };
  const clearTimeoutImpl = (t) => { if (t) timers.delete(t.id); };
  const advance = (ms) => {
    const target = now + ms;
    for (;;) {
      let next = null;
      for (const [id, t] of timers) if (t.at <= target && (!next || t.at < next.t.at)) next = { id, t };
      if (!next) break;
      timers.delete(next.id);
      now = next.t.at;
      next.t.fn();
    }
    now = target;
  };
  return { setTimeoutImpl, clearTimeoutImpl, advance, pending: () => timers.size };
}

function fakeChild() {
  const child = new EventEmitter();
  child.pid = 4242;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = Object.assign(new EventEmitter(), { end() {} });
  return child;
}

function run(opts = {}) {
  const clock = fakeClock();
  const child = fakeChild();
  const terminated = [];
  const streamed = [];
  const promise = spawnWithWatchdog("node", [], {
    setTimeoutImpl: clock.setTimeoutImpl,
    clearTimeoutImpl: clock.clearTimeoutImpl,
    spawnImpl: () => child,
    terminateImpl: (pid) => terminated.push(pid),
    stdoutSink: (c) => streamed.push(c),
    ...opts
  });
  return { promise, child, clock, terminated, streamed };
}

// ─── success paths ──────────────────────────────────────────────────────────

test("T13 AC1: resolves with buffered stdout on a clean exit", async () => {
  const { promise, child } = run();
  child.stdout.emit("data", Buffer.from("hello "));
  child.stdout.emit("data", Buffer.from("world"));
  child.emit("close", 0, null);
  assert.equal(await promise, "hello world");
});

test("T13 AC2: input is written to the child's stdin", async () => {
  let written = null;
  const clock = fakeClock();
  const child = fakeChild();
  child.stdin.end = (data) => { written = data; };
  const promise = spawnWithWatchdog("node", [], {
    input: "PROMPT_PAYLOAD",
    setTimeoutImpl: clock.setTimeoutImpl,
    clearTimeoutImpl: clock.clearTimeoutImpl,
    spawnImpl: () => child,
    terminateImpl: () => {}
  });
  child.emit("close", 0, null);
  await promise;
  assert.equal(written, "PROMPT_PAYLOAD");
});

// ─── the two guards ─────────────────────────────────────────────────────────

test("T13 AC3: the idle guard fires when no output arrives", async () => {
  const { promise, clock, terminated } = run({ idleTimeoutMs: 1000, timeoutMs: 100_000 });
  clock.advance(1001);
  const err = await promise.catch((e) => e);
  assert.equal(err.code, "EIDLE");
  assert.deepEqual(terminated, [4242], "the process tree must be terminated");
});

test("T13 AC4: output resets the idle guard", async () => {
  const { promise, child, clock } = run({ idleTimeoutMs: 1000, timeoutMs: 100_000 });
  let settled = false;
  promise.then(() => { settled = true; }, () => { settled = true; });
  for (let i = 0; i < 5; i++) {
    clock.advance(800);
    child.stdout.emit("data", Buffer.from("tick"));
  }
  await Promise.resolve();
  assert.equal(settled, false, "steady output must not trip the idle guard");
  child.emit("close", 0, null);
  assert.equal(await promise, "tickticktickticktick");
});

test("T13 AC5: the hard ceiling fires even while output keeps arriving", async () => {
  // The test that proves the ceiling is independent of the idle guard.
  const { promise, child, clock, terminated } = run({ idleTimeoutMs: 1000, timeoutMs: 5000 });
  // Emit steadily past the ceiling: the idle guard keeps re-arming, so only the
  // ceiling can end this run.
  for (let i = 0; i < 20; i++) {
    clock.advance(400);
    child.stdout.emit("data", Buffer.from("."));
  }
  const err = await promise.catch((e) => e);
  assert.equal(err.code, "ETIMEDOUT", "a chatty but wedged process must still be killed");
  assert.deepEqual(terminated, [4242]);
});

test("T13 AC12: the idle message differs from the ceiling message and names the window", async () => {
  const a = run({ idleTimeoutMs: 2000, timeoutMs: 100_000 });
  a.clock.advance(2001);
  const idleErr = await a.promise.catch((e) => e);

  const b = run({ idleTimeoutMs: 1000, timeoutMs: 4000 });
  for (let i = 0; i < 20; i++) { b.clock.advance(400); b.child.stdout.emit("data", Buffer.from(".")); }
  const toErr = await b.promise.catch((e) => e);
  assert.notEqual(idleErr.message, toErr.message);
  assert.match(idleErr.message, /2s/, "idle message must name the idle window");
  assert.match(toErr.message, /4s/, "timeout message must name the ceiling");
});

// ─── bounded buffer ─────────────────────────────────────────────────────────

test("T13 AC6: exceeding maxBuffer fails loudly instead of growing unbounded", async () => {
  const { promise, child, terminated } = run({ maxBuffer: 32, timeoutMs: 100_000 });
  child.stdout.emit("data", Buffer.from("x".repeat(40)));
  const err = await promise.catch((e) => e);
  assert.equal(err.code, "EBUFFER");
  assert.match(err.message, /32/);
  assert.deepEqual(terminated, [4242]);
});

// ─── error payloads (cross-ticket contract with T14) ────────────────────────

test("T13 AC15: every rejection carries the stderr captured before the failure", async () => {
  const { promise, child, clock } = run({ idleTimeoutMs: 1000, timeoutMs: 100_000 });
  child.stderr.emit("data", Buffer.from("codex resume 01ABC"));
  clock.advance(1001);
  const err = await promise.catch((e) => e);
  assert.equal(err.code, "EIDLE");
  assert.match(err.stderr, /codex resume 01ABC/, "T14 parses this stderr for resume ids");
});

test("T13: a non-zero exit rejects with stdout and stderr attached", async () => {
  const { promise, child } = run();
  child.stdout.emit("data", Buffer.from("partial"));
  child.stderr.emit("data", Buffer.from("boom"));
  child.emit("close", 3, null);
  const err = await promise.catch((e) => e);
  assert.equal(err.code, 3);
  assert.equal(err.stdout, "partial");
  assert.match(err.stderr, /boom/);
});

// ─── streaming ──────────────────────────────────────────────────────────────

test("T13 AC8: streamStdout writes chunks through AND still returns them", async () => {
  const { promise, child, streamed } = run({ streamStdout: true });
  child.stdout.emit("data", Buffer.from("live "));
  child.stdout.emit("data", Buffer.from("output"));
  child.emit("close", 0, null);
  assert.equal(await promise, "live output");
  assert.deepEqual(streamed, ["live ", "output"]);
});

test("T13: stdout is not streamed unless asked", async () => {
  const { promise, child, streamed } = run({ streamStdout: false });
  child.stdout.emit("data", Buffer.from("quiet"));
  child.emit("close", 0, null);
  await promise;
  assert.deepEqual(streamed, []);
});

// ─── hygiene ────────────────────────────────────────────────────────────────

test("T13 AC9: timers are unref'd so a pending watchdog cannot hold the loop open", async () => {
  const unrefed = [];
  const clock = fakeClock();
  const wrapped = (fn, ms) => {
    const t = clock.setTimeoutImpl(fn, ms);
    const orig = t.unref.bind(t);
    t.unref = () => { unrefed.push(t.id); return orig(); };
    return t;
  };
  const child = fakeChild();
  const promise = spawnWithWatchdog("node", [], {
    idleTimeoutMs: 5000, // opt in so both timers exist for this check
    setTimeoutImpl: wrapped,
    clearTimeoutImpl: clock.clearTimeoutImpl,
    spawnImpl: () => child,
    terminateImpl: () => {}
  });
  child.emit("close", 0, null);
  await promise;
  assert.ok(unrefed.length >= 2, "both the idle and ceiling timers must be unref'd");
});

test("T13: settling is one-shot — a later close cannot re-settle", async () => {
  const { promise, child, clock, terminated } = run({ idleTimeoutMs: 1000, timeoutMs: 100_000 });
  clock.advance(1001);
  const err = await promise.catch((e) => e);
  assert.equal(err.code, "EIDLE");
  child.emit("close", 0, null); // must be ignored
  assert.deepEqual(terminated, [4242], "no second termination");
});

test("T13: all timers are cleared once settled", async () => {
  const { promise, child, clock } = run();
  child.emit("close", 0, null);
  await promise;
  assert.equal(clock.pending(), 0, "no dangling timers after settle");
});

// ─── real-process integration ───────────────────────────────────────────────
// Every test above injects a fake child, so the actual spawn path — command
// resolution, detached process group, stdio wiring, stdin piping — is otherwise
// unexercised. These use a real `node` subprocess.

test("T13: real subprocess round-trips stdin to stdout", async () => {
  const out = await spawnWithWatchdog(
    "node",
    ["-e", "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>process.stdout.write('got:'+d))"],
    { input: "PAYLOAD", timeoutMs: 30_000 }
  );
  assert.equal(out, "got:PAYLOAD");
});

test("T13: a real non-zero exit rejects with stderr attached", async () => {
  const err = await spawnWithWatchdog(
    "node",
    ["-e", "process.stderr.write('real failure');process.exit(4)"],
    { timeoutMs: 30_000 }
  ).catch((e) => e);
  assert.equal(err.code, 4);
  assert.match(err.stderr, /real failure/);
});

test("T13: a real wedged process is killed by the ceiling, not left hanging", async () => {
  const started = Date.now();
  const err = await spawnWithWatchdog(
    "node",
    ["-e", "setInterval(()=>{},1000)"], // never exits, never speaks
    { timeoutMs: 1500, idleTimeoutMs: 1000 }
  ).catch((e) => e);
  // Silent process: the idle guard should reach it first.
  assert.equal(err.code, "EIDLE");
  assert.ok(Date.now() - started < 10_000, "must not wait out a long timeout");
});

test("T13: an unresolvable command rejects instead of hanging", async () => {
  const err = await spawnWithWatchdog("definitely-not-a-real-binary-xyz", [], { timeoutMs: 5000 })
    .catch((e) => e);
  assert.match(err.message, /not found on PATH/);
});

test("T13: the safety envelope defaults are pinned to their specified values", () => {
  // These three constants ARE the safety envelope. Asserting them against
  // themselves (as the window tests do) is mutation-invariant, so pin the
  // literals: a silent change to any of them changes how long a hung review
  // blocks, or how much memory a runaway CLI can consume, with nothing failing.
  assert.equal(DEFAULT_IDLE_TIMEOUT_MS, 180_000, "idle guard: 3 minutes");
  assert.equal(DEFAULT_MAX_MS, 900_000, "hard ceiling fallback: 15 minutes");
  assert.equal(DEFAULT_MAX_BUFFER, 10 * 1024 * 1024, "output cap: 10 MB");
});

test("T13: any positive timeout is honored as the ceiling, including 1ms", () => {
  // Pins the `> 0` boundary. With `> 1`, a 1ms ceiling would silently fall back
  // to the 15-minute default — the opposite of what the caller asked for.
  assert.equal(resolveWindows({ timeoutMs: 1 }).maxMs, 1);
  assert.equal(resolveWindows({ timeoutMs: 0 }).maxMs, DEFAULT_MAX_MS, "0 is not a timeout");
  assert.equal(resolveWindows({ timeoutMs: -5 }).maxMs, DEFAULT_MAX_MS, "negative is not a timeout");
});

test("T13: stdin is closed even when there is no input to write", async () => {
  // Regression: execFileSync closes stdin for you; spawn does not. With
  // `input: null` the child was left waiting on an open stdin forever. The
  // argv-fallback path passes null, so a real review hung and then answered
  // conversationally instead of reviewing.
  const out = await spawnWithWatchdog(
    "node",
    ["-e", "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>process.stdout.write('eof:'+d.length))"],
    { input: null, timeoutMs: 30_000 }
  );
  assert.equal(out, "eof:0", "the child must observe EOF on stdin, not block");
});

test("T13: a silent long-running process is NOT killed when no idle guard is set", async () => {
  // The default must let a legitimately quiet CLI keep working — codex emits
  // nothing under --output-last-message until it finishes.
  const clock = fakeClock();
  const child = fakeChild();
  let settled = false;
  const promise = spawnWithWatchdog("node", [], {
    timeoutMs: 600_000, // no idleTimeoutMs => idle guard off
    setTimeoutImpl: clock.setTimeoutImpl,
    clearTimeoutImpl: clock.clearTimeoutImpl,
    spawnImpl: () => child,
    terminateImpl: () => {}
  });
  promise.then(() => { settled = true; }, () => { settled = true; });
  clock.advance(500_000); // far past the old 180s default, still silent
  await Promise.resolve();
  assert.equal(settled, false, "silence alone must not kill a healthy run");
  child.stdout.emit("data", Buffer.from("finally done"));
  child.emit("close", 0, null);
  assert.equal(await promise, "finally done");
});

test("T13: a multibyte character split across chunks is not corrupted", async () => {
  // "→" is E2 86 92. Splitting it across two data events made Buffer.toString()
  // emit replacement characters, silently mutating review evidence while the
  // JSON stayed valid.
  const arrow = Buffer.from("a→b", "utf8");
  const { promise, child } = run();
  child.stdout.emit("data", arrow.subarray(0, 2)); // "a" + first byte of →
  child.stdout.emit("data", arrow.subarray(2));    // rest of → + "b"
  child.emit("close", 0, null);
  const out = await promise;
  assert.equal(out, "a→b");
  assert.ok(!out.includes("�"), "no replacement characters");
});

test("T13: maxBuffer counts BYTES, not UTF-16 units", async () => {
  // Multibyte content must count against the cap by its real byte size, or the
  // documented 10 MB ceiling silently becomes much larger in memory.
  const { promise, child } = run({ maxBuffer: 10, timeoutMs: 100_000 });
  child.stdout.emit("data", Buffer.from("→→→→→", "utf8")); // 15 bytes, 5 chars
  const err = await promise.catch((e) => e);
  assert.equal(err.code, "EBUFFER", "15 bytes must exceed a 10-byte cap");
});
