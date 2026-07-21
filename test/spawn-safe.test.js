import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveCommand, isPidAlive, terminateProcessTree } from "../src/spawn-safe.js";

// ─── resolveCommand ─────────────────────────────────────────────────────────
// Resolving to an absolute path is what lets every spawn site use shell:false.
// The old code set shell:true on Windows purely so .cmd shims would resolve;
// resolving the path ourselves removes that reason.

test("T12 AC2: resolveCommand finds a real binary on PATH and returns an absolute path", () => {
  const resolved = resolveCommand("node");
  assert.ok(resolved, "node should resolve");
  assert.ok(path.isAbsolute(resolved), `expected absolute path, got ${resolved}`);
  assert.ok(fs.existsSync(resolved));
});

test("T12 AC2: resolveCommand returns null for a command that is not installed", () => {
  assert.equal(resolveCommand("definitely-not-a-real-binary-xyz"), null);
});

test("T12 AC2: resolveCommand rejects names that are not bare command tokens", () => {
  // A path or shell metacharacter reaching a spawn site is a bug, not a lookup.
  for (const bad of ["../evil", "/bin/sh", "a b", "a;b", "a|b", "", "a/b"]) {
    assert.equal(resolveCommand(bad), null, `${JSON.stringify(bad)} must not resolve`);
  }
});

test("T12 AC3: resolveCommand honors PATHEXT on win32", () => {
  // Injected platform/env seam — otherwise this is unverifiable on POSIX CI.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "adv-pathext-"));
  try {
    fs.writeFileSync(path.join(dir, "foo.cmd"), "@echo off");
    const resolved = resolveCommand("foo", {
      platform: "win32",
      env: { PATH: dir, PATHEXT: ".EXE;.CMD;.BAT" }
    });
    assert.ok(resolved, "foo.cmd should resolve via PATHEXT");
    assert.ok(resolved.toLowerCase().endsWith("foo.cmd"), `got ${resolved}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("T12: resolveCommand does not invent an extension on POSIX", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "adv-posix-"));
  try {
    fs.writeFileSync(path.join(dir, "bar.cmd"), "#!/bin/sh");
    fs.chmodSync(path.join(dir, "bar.cmd"), 0o755);
    assert.equal(
      resolveCommand("bar", { platform: "linux", env: { PATH: dir } }),
      null,
      "POSIX must not append .cmd"
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ─── isPidAlive ─────────────────────────────────────────────────────────────
// kill(0, …) and kill(-0, …) are process-GROUP relative and would target our
// own group. Requiring pid > 0 makes that structurally impossible.

test("T12 AC4: isPidAlive rejects non-positive and non-finite pids without signalling", () => {
  let called = 0;
  const killImpl = () => { called++; throw new Error("must not signal"); };
  for (const pid of [0, -0, -1, -12345, NaN, Infinity, null, undefined, "123"]) {
    assert.equal(isPidAlive(pid, killImpl), false, `pid ${String(pid)} must be treated as dead`);
  }
  assert.equal(called, 0, "kill must never be invoked for an invalid pid");
});

test("T12 AC5: isPidAlive treats ESRCH as dead and EPERM as alive", () => {
  const thrower = (code) => () => { const e = new Error(code); e.code = code; throw e; };
  assert.equal(isPidAlive(1234, thrower("ESRCH")), false);
  assert.equal(isPidAlive(1234, thrower("EPERM")), true, "EPERM means it exists, we just cannot signal");
});

test("T12: isPidAlive reports a live pid as alive", () => {
  assert.equal(isPidAlive(process.pid), true);
});

// ─── terminateProcessTree ───────────────────────────────────────────────────
// Killing only the direct child leaves the CLI's own grandchildren running —
// which is the hang T13's watchdog exists to end.

test("T12 AC6: terminateProcessTree does not signal a pid that is already gone", () => {
  const calls = [];
  const killImpl = (pid, sig) => {
    calls.push([pid, sig]);
    const e = new Error("ESRCH"); e.code = "ESRCH"; throw e;
  };
  const res = terminateProcessTree(4242, { platform: "linux", killImpl });
  assert.deepEqual(res, { attempted: false, delivered: false, method: null });
  assert.equal(calls.length, 1, "only the liveness probe may run");
  assert.deepEqual(calls[0], [4242, 0], "probe must be signal 0");
});

test("T12 AC6: terminateProcessTree refuses a non-positive pid outright", () => {
  const killImpl = () => { throw new Error("must not signal"); };
  for (const pid of [0, -0, -5, NaN]) {
    assert.deepEqual(
      terminateProcessTree(pid, { platform: "linux", killImpl }),
      { attempted: false, delivered: false, method: null }
    );
  }
});

test("T12 AC7: on POSIX the process GROUP is signalled first", () => {
  const calls = [];
  const killImpl = (pid, sig) => { calls.push([pid, sig]); /* alive, kill succeeds */ };
  const res = terminateProcessTree(999, { platform: "linux", killImpl });
  assert.equal(res.delivered, true);
  assert.equal(res.method, "process-group");
  assert.deepEqual(calls[0], [999, 0], "liveness probe first");
  assert.deepEqual(calls[1], [-999, "SIGTERM"], "then the negative pid = process group");
});

test("T12: POSIX falls back to the bare pid when the group signal fails", () => {
  const calls = [];
  const killImpl = (pid, sig) => {
    calls.push([pid, sig]);
    if (pid < 0) { const e = new Error("EPERM"); e.code = "EPERM"; throw e; }
  };
  const res = terminateProcessTree(999, { platform: "linux", killImpl });
  assert.equal(res.method, "process");
  assert.equal(res.delivered, true);
  assert.ok(calls.some(([p, s]) => p === 999 && s === "SIGTERM"), "bare pid fallback must run");
});

test("T12 AC8: on win32 taskkill is used with /T and /F", () => {
  const runs = [];
  const runCommandImpl = (cmd, args) => { runs.push({ cmd, args }); return { status: 0, error: null, stdout: "", stderr: "" }; };
  const res = terminateProcessTree(777, { platform: "win32", killImpl: () => {}, runCommandImpl });
  assert.equal(res.delivered, true);
  assert.equal(res.method, "taskkill");
  assert.equal(runs[0].cmd, "taskkill");
  assert.ok(runs[0].args.includes("/T"), "must kill the tree");
  assert.ok(runs[0].args.includes("/F"), "must force");
  assert.ok(runs[0].args.includes("777"));
});

test("T12: win32 falls back to kill when taskkill is unavailable", () => {
  const killed = [];
  const runCommandImpl = () => ({ status: null, error: Object.assign(new Error("ENOENT"), { code: "ENOENT" }), stdout: "", stderr: "" });
  const killImpl = (pid, sig) => { if (sig !== 0) killed.push(pid); };
  const res = terminateProcessTree(555, { platform: "win32", killImpl, runCommandImpl });
  assert.equal(res.method, "kill");
  assert.deepEqual(killed, [555]);
});
