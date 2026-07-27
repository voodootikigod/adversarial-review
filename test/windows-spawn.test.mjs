import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveCommand, buildSpawnTarget, interpreterPath } from "../src/spawn-safe.js";
import { spawnWithWatchdog } from "../src/exec-watchdog.js";

// REAL Windows execution of the spawn path. Every other Windows test in this
// suite simulates the platform through the `platform`/`env` seams on a POSIX
// host, which verifies our decisions but never CreateProcess, cmd.exe's parsing
// after /c, PATHEXT resolution, or .cmd execution itself. This file runs those
// for real and is skipped everywhere else.
//
// Scope note: this covers the spawn/interpreter path only. The rest of the suite
// is not Windows-portable (POSIX mode bits, `#!/bin/sh` mock CLIs), so the CI
// job that runs this file runs only this file.
const windowsOnly = { skip: process.platform !== "win32" ? "windows-only" : false };

function withShimDir(name, body) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "adv-win-"));
  try {
    return body(dir, path.join(dir, name));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("a real .cmd shim resolves via PATHEXT and executes through the interpreter", windowsOnly, async () => {
  await withShimDir("advshim.cmd", async (dir, shim) => {
    // Echo stdin back so we prove the prompt channel works end to end.
    fs.writeFileSync(shim, "@echo off\r\nmore\r\n");

    const resolved = resolveCommand("advshim", { env: { PATH: dir, PATHEXT: ".EXE;.CMD;.BAT" } });
    assert.ok(resolved, "the .cmd shim must resolve via PATHEXT");
    assert.ok(resolved.toLowerCase().endsWith("advshim.cmd"));

    const target = buildSpawnTarget(resolved, [], { argsContainUntrusted: false });
    assert.equal(target.viaInterpreter, true, ".cmd is not an executable image");
    assert.ok(path.win32.isAbsolute(target.command), `interpreter must be absolute: ${target.command}`);
    assert.ok(fs.existsSync(target.command), `interpreter must exist: ${target.command}`);

    const out = await spawnWithWatchdog(resolved, [], {
      input: "PROMPT-OVER-STDIN\r\n",
      timeoutMs: 60_000,
      argsContainUntrusted: false
    });
    assert.match(out, /PROMPT-OVER-STDIN/, "stdin must reach a .cmd shim unmangled");
  });
});

test("a shim in a directory containing spaces still executes", windowsOnly, async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "adv-win-"));
  const dir = path.join(base, "dir with spaces");
  fs.mkdirSync(dir);
  try {
    const shim = path.join(dir, "advspace.cmd");
    fs.writeFileSync(shim, "@echo off\r\necho SPACED-OK\r\n");
    const out = await spawnWithWatchdog(shim, [], { timeoutMs: 60_000, argsContainUntrusted: false });
    assert.match(out, /SPACED-OK/, "a quoted interpreter path must survive spaces");
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test("untrusted argv is refused before any process starts", windowsOnly, () => {
  withShimDir("advrefuse.cmd", (dir, shim) => {
    // A marker the payload would create if cmd.exe ever re-parsed this argv.
    const marker = path.join(dir, "pwned.txt");
    fs.writeFileSync(shim, "@echo off\r\n");
    assert.throws(
      () => buildSpawnTarget(shim, ["-p", `review & echo x > "${marker}"`], { argsContainUntrusted: true }),
      (err) => err.code === "EWINARGV"
    );
    assert.equal(fs.existsSync(marker), false, "nothing may execute on the refused path");
  });
});

test("the interpreter is absolute even with ComSpec unset", windowsOnly, () => {
  const chosen = interpreterPath({ SystemRoot: process.env.SystemRoot });
  assert.ok(path.win32.isAbsolute(chosen), `expected an absolute interpreter, got ${chosen}`);
  assert.ok(fs.existsSync(chosen), `the System32 interpreter must exist: ${chosen}`);
});

test("the watchdog terminates a hung .cmd tree", windowsOnly, async () => {
  await withShimDir("advhang.cmd", async (_dir, shim) => {
    // Sleep well past the timeout; the watchdog must not wait for it.
    fs.writeFileSync(shim, "@echo off\r\nping -n 60 127.0.0.1 >nul\r\n");
    const started = process.hrtime.bigint();
    await assert.rejects(
      () => spawnWithWatchdog(shim, [], { timeoutMs: 3_000, argsContainUntrusted: false }),
      (err) => err.code === "ETIMEDOUT"
    );
    const elapsedMs = Number((process.hrtime.bigint() - started) / 1_000_000n);
    assert.ok(elapsedMs < 30_000, `watchdog must not wait for the child, took ${elapsedMs}ms`);
  });
});
