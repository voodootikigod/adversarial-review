// Parity harness (T50): the single public entry parity rows import.
//
// A row is: makeContext -> makeRepo -> plant mocks / stub replies -> runCli ->
// assert exit code, stdout JSON/NDJSON, stderr, invocation records, git state.
//
// Hermetic by construction (items 2, 2a, 3; AP7):
//   - the child env is built FROM SCRATCH (process.env is never spread);
//   - PATH = [mocksDir, sysbinDir]; sysbinDir holds symlinks to the host git,
//     sh, cat, sleep, mkdir, touch, rm, env and node only (no bwrap, unshare,
//     getconf or real provider CLIs); both are siblings of the repo in tmpdir;
//   - HOME, XDG_CONFIG_HOME, TMPDIR and the config dir are fresh per runCli call;
//     ADVERSARIAL_REVIEW_CONFIG = <configDir>/config.json (never created here);
//   - git is pinned: GIT_CONFIG_NOSYSTEM=1, GIT_CONFIG_GLOBAL=<HOME>/.gitconfig
//     (init.defaultBranch=main, advice.detachedHead=false,
//     advice.statusHints=false, core.pager=cat, color.ui=false), fixed author /
//     committer identity and dates, LANG=C.
//
// Capture mode (item 11, AP1, AP2): with PARITY_CAPTURE=<dir> (or the
// `capture` option) a runCli inside a row writes <dir>/<rowId>/<n>.json with
// RAW values; capture-compare.mjs normalizes at compare time.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { currentRow, countAssertion, ROWS_DIR, PARITY_DIR } from "./rows.mjs";
import { LANDED_DELTAS } from "./deltas.mjs";
import { writeMockCli, readMockRecords, readMockProbes, listMocks, hostTool, fifoPath } from "./mock-cli.mjs";
import { createStub } from "./http-stub.mjs";
import { snapshotRoots } from "./leak.mjs";

export * from "./mock-cli.mjs";
export * from "./http-stub.mjs";
export * from "./rows.mjs";
export * from "./mutant.mjs";
export * from "./leak.mjs";
export { DELTAS, WITHDRAWN_DELTAS, LANDED_DELTAS } from "./deltas.mjs";

export const REPO_ROOT = path.resolve(PARITY_DIR, "..", "..");
export const CLI_ENTRY = path.join(REPO_ROOT, "bin", "cli.js");
export const FETCH_RECORDER = path.join(path.dirname(fileURLToPath(import.meta.url)), "fetch-recorder.cjs");
export const DEFAULT_TIMEOUT_MS = 60_000;

export const GIT_IDENTITY = Object.freeze({
  GIT_AUTHOR_NAME: "Parity Author",
  GIT_AUTHOR_EMAIL: "parity@example.com",
  GIT_COMMITTER_NAME: "Parity Committer",
  GIT_COMMITTER_EMAIL: "parity@example.com",
  GIT_AUTHOR_DATE: "2026-01-01T00:00:00Z",
  GIT_COMMITTER_DATE: "2026-01-01T00:00:00Z"
});

export const GITCONFIG_TEXT =
  "[init]\n\tdefaultBranch = main\n" +
  "[advice]\n\tdetachedHead = false\n\tstatusHints = false\n" +
  "[core]\n\tpager = cat\n" +
  "[color]\n\tui = false\n";

const SYSBIN_TOOLS = ["git", "sh", "cat", "sleep", "mkdir", "touch", "rm", "env"];

// Fixture review results (schema.json shape).
export const APPROVE = Object.freeze({
  verdict: "approve",
  summary: "ok",
  coverage: { files_examined: ["code.js"], files_skipped: [] },
  findings: [],
  next_steps: []
});
export const FLAG = Object.freeze({
  verdict: "needs-attention",
  summary: "bad",
  coverage: { files_examined: ["code.js"], files_skipped: [] },
  findings: [{
    severity: "high", category: "security", title: "t", body: "b", exploit_scenario: "e", evidence: "",
    file: "code.js", line_start: 1, line_end: 1, confidence: 0.9, recommendation: "r"
  }],
  next_steps: ["n"]
});

export function tmpBase() {
  return fs.realpathSync(os.tmpdir());
}

function mkTemp(prefix) {
  return fs.mkdtempSync(path.join(tmpBase(), prefix));
}

// ─── context ─────────────────────────────────────────────────────────────────

export function makeContext(t) {
  const dir = mkTemp("parity-ctx-");
  const mocksDir = mkTemp("parity-mocks-");
  const sysbinDir = mkTemp("parity-sysbin-");
  const recordsDir = path.join(dir, "records");
  const fifoDir = path.join(dir, "fifo");
  fs.mkdirSync(recordsDir, { recursive: true });
  fs.mkdirSync(fifoDir, { recursive: true });
  for (const tool of SYSBIN_TOOLS) fs.symlinkSync(hostTool(tool), path.join(sysbinDir, tool));
  fs.symlinkSync(process.execPath, path.join(sysbinDir, "node"));

  const temps = [dir, mocksDir, sysbinDir];
  const stubs = [];
  const sleepers = new Set();
  const ctx = {
    dir, mocksDir, sysbinDir, recordsDir, fifoDir, stubs, temps,
    mock(name, opts = {}) {
      if ((opts.responses ?? []).some((r) => r.sleep != null)) sleepers.add(name);
      else sleepers.delete(name);
      return writeMockCli(mocksDir, name, { ...opts, recordsDir, fifoDir });
    },
    hasSleepingMock() { return sleepers.size > 0; },
    records(name) { return readMockRecords(recordsDir, name); },
    probes(name) { return readMockProbes(recordsDir, name); },
    fifo(name) { return fifoPath(fifoDir, name); },
    async stub() {
      const s = await createStub();
      stubs.push(s);
      return s;
    },
    track(p) { temps.push(p); return p; },
    async cleanup() {
      for (const s of stubs.splice(0)) await s.close();
      for (const p of temps.splice(0)) fs.rmSync(p, { recursive: true, force: true });
    }
  };
  if (t && typeof t.after === "function") t.after(() => ctx.cleanup());
  return ctx;
}

// ─── git repos ───────────────────────────────────────────────────────────────

let repoGitHome = null;
function repoGitEnv() {
  if (!repoGitHome || !fs.existsSync(repoGitHome)) {
    repoGitHome = mkTemp("parity-repogit-");
    fs.writeFileSync(path.join(repoGitHome, ".gitconfig"), GITCONFIG_TEXT);
    process.once("exit", () => { try { fs.rmSync(repoGitHome, { recursive: true, force: true }); } catch { /* best effort */ } });
  }
  return {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: repoGitHome,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: path.join(repoGitHome, ".gitconfig"),
    LANG: "C",
    ...GIT_IDENTITY
  };
}

function gitIn(dir, args, { allowFail = false } = {}) {
  const r = spawnSync(hostTool("git"), args, { cwd: dir, env: repoGitEnv(), encoding: "utf8" });
  if (r.status !== 0 && !allowFail) {
    throw new Error(`git ${args.join(" ")} failed in ${dir}: ${r.stderr}`);
  }
  return r;
}

function writeFiles(dir, files) {
  for (const [rel, content] of Object.entries(files ?? {})) {
    const p = path.join(dir, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
  }
}

export const DEFAULT_FILES = Object.freeze({ "code.js": "export const x = 1;\n" });
export const DEFAULT_CHANGE = Object.freeze({ "code.js": "export const x = 2; // changed\n" });

export function makeRepo({
  scope = "working-tree",
  files = DEFAULT_FILES,
  change = DEFAULT_CHANGE,
  untracked = null,
  staged = null,
  detached = false,
  dirty = null,
  emptyCommitMessage = null,
  ctx = null
} = {}) {
  if (!["working-tree", "branch"].includes(scope)) throw new Error(`makeRepo: unknown scope ${scope}`);
  const dir = mkTemp("parity-repo-");
  if (ctx) ctx.track(dir);
  const git = (...args) => gitIn(dir, args).stdout;
  git("init", "-q");
  writeFiles(dir, files);
  git("add", "-A");
  git("commit", "-q", "-m", "baseline");
  if (scope === "working-tree") {
    writeFiles(dir, change);
    writeFiles(dir, untracked);
    if (staged) {
      writeFiles(dir, staged);
      git("add", "--", ...Object.keys(staged));
    }
  } else {
    git("checkout", "-q", "-b", "feature");
    if (emptyCommitMessage != null) {
      git("commit", "-q", "--allow-empty", "-m", emptyCommitMessage);
    } else {
      writeFiles(dir, change);
      git("add", "-A");
      git("commit", "-q", "-m", "change");
    }
    writeFiles(dir, untracked);
    if (staged) {
      writeFiles(dir, staged);
      git("add", "--", ...Object.keys(staged));
    }
  }
  if (dirty) writeFiles(dir, dirty === true ? { [Object.keys(files)[0]]: "// dirty\n" } : dirty);
  if (detached) git("checkout", "-q", "--detach");
  return { dir, git, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

export function makePlainDir(files = {}, { ctx = null } = {}) {
  const dir = mkTemp("parity-plain-");
  if (ctx) ctx.track(dir);
  writeFiles(dir, files);
  return { dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

function walkFiles(root, rel = "", out = {}) {
  for (const ent of fs.readdirSync(path.join(root, rel), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (!rel && ent.name === ".git") continue;
    const r = rel ? `${rel}/${ent.name}` : ent.name;
    if (ent.isDirectory()) walkFiles(root, r, out);
    else if (ent.isSymbolicLink()) out[r] = `-> ${fs.readlinkSync(path.join(root, r))}`;
    else if (ent.isFile()) out[r] = fs.readFileSync(path.join(root, r), "utf8");
  }
  return out;
}

export function gitState(dir) {
  if (!fs.existsSync(path.join(dir, ".git"))) return null;
  const g = (args) => gitIn(dir, args, { allowFail: true });
  const val = (args) => { const r = g(args); return r.status === 0 ? r.stdout.trim() : null; };
  return {
    head: val(["rev-parse", "HEAD"]),
    headParent: val(["rev-parse", "--verify", "-q", "HEAD~1"]),
    branch: val(["symbolic-ref", "--short", "-q", "HEAD"]),
    statusPorcelain: g(["status", "--porcelain"]).stdout,
    stashList: g(["stash", "list", "--format=%gd %s"]).stdout,
    files: walkFiles(dir),
    untracked: g(["ls-files", "--others", "--exclude-standard"]).stdout.split("\n").filter(Boolean)
  };
}

// ─── hermetic env ────────────────────────────────────────────────────────────

// Fresh per-run roots + the env built from scratch. `gitPinning: false` is a
// TEST-ONLY seam for the AP7 negative control.
export function prepareRun(ctx, { env = {}, configPath = null, gitPinning = true } = {}) {
  const home = ctx.track(mkTemp("parity-home-"));
  const xdg = ctx.track(mkTemp("parity-xdg-"));
  const tmp = ctx.track(mkTemp("parity-tmp-"));
  let configDir;
  if (configPath) {
    configDir = path.dirname(configPath);
  } else {
    configDir = ctx.track(mkTemp("parity-config-"));
    configPath = path.join(configDir, "config.json");
  }
  const base = {
    PATH: [ctx.mocksDir, ctx.sysbinDir].join(path.delimiter),
    HOME: home,
    XDG_CONFIG_HOME: xdg,
    TMPDIR: tmp,
    LANG: "C",
    ADVERSARIAL_REVIEW_CONFIG: configPath,
    ...GIT_IDENTITY
  };
  if (gitPinning) {
    fs.writeFileSync(path.join(home, ".gitconfig"), GITCONFIG_TEXT);
    base.GIT_CONFIG_NOSYSTEM = "1";
    base.GIT_CONFIG_GLOBAL = path.join(home, ".gitconfig");
  }
  const childEnv = { ...base };
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined || v === null) delete childEnv[k];
    else childEnv[k] = String(v);
  }
  return {
    env: childEnv,
    configPath,
    roots: { home, xdg, tmp, configDir, mocks: ctx.mocksDir, sysbin: ctx.sysbinDir }
  };
}

// D9 exemption from argv: a non-loop --prompt-only run, or a `setup` run.
export function exemptByArgv(argv) {
  if (argv[0] === "setup") return true;
  return argv.includes("--prompt-only") && !argv.includes("--loop");
}

// ─── capture ─────────────────────────────────────────────────────────────────

const captureCounters = new Map();

function writeManifestCopies(dir) {
  const mdir = path.join(dir, "_manifests");
  if (fs.existsSync(mdir)) return;
  fs.mkdirSync(mdir, { recursive: true });
  for (const f of fs.readdirSync(ROWS_DIR)) {
    if (f.endsWith(".json")) fs.copyFileSync(path.join(ROWS_DIR, f), path.join(mdir, f));
  }
  fs.writeFileSync(path.join(mdir, "landed.json"), JSON.stringify([...LANDED_DELTAS]) + "\n");
}

function writeCapture(dir, rowId, record) {
  const absDir = path.resolve(dir);
  fs.mkdirSync(absDir, { recursive: true });
  writeManifestCopies(absDir);
  const key = `${absDir}\0${rowId}`;
  const n = (captureCounters.get(key) ?? 0) + 1;
  captureCounters.set(key, n);
  const rowDir = path.join(absDir, rowId);
  fs.mkdirSync(rowDir, { recursive: true });
  const file = path.join(rowDir, `${n}.json`);
  fs.writeFileSync(file, JSON.stringify(record, null, 2) + "\n");
  return file;
}

// ─── runCli ──────────────────────────────────────────────────────────────────

function snapshotCounts(ctx, stubs) {
  const mocks = {};
  const probes = {};
  for (const name of listMocks(ctx.recordsDir)) {
    mocks[name] = readMockRecords(ctx.recordsDir, name).length;
    probes[name] = readMockProbes(ctx.recordsDir, name).length;
  }
  return {
    mocks,
    probes,
    stubs: stubs.map((s) => ({ stub: s, requests: s.requests.length, unexpected: s.unexpected.length }))
  };
}

function releaseFifo(fp) {
  let fd;
  try {
    fd = fs.openSync(fp, fs.constants.O_WRONLY | fs.constants.O_NONBLOCK);
  } catch (err) {
    if (err.code === "ENXIO" || err.code === "ENOENT") return false; // mock already gone
    throw err;
  }
  try { fs.writeSync(fd, "x"); } catch { /* reader went away */ }
  fs.closeSync(fd);
  return true;
}

async function waitForFile(file, { intervalMs = 10, deadlineMs = 10_000, isDone }) {
  const end = Date.now() + deadlineMs;
  while (Date.now() < end) {
    if (fs.existsSync(file)) return true;
    if (isDone()) return false;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return false;
}

function parseOutput(args, stdout) {
  const out = { json: undefined, events: undefined, jsonError: undefined };
  if (!args.includes("--json") || !stdout.trim()) return out;
  try {
    if (args.includes("--loop")) {
      out.events = stdout.split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
    } else {
      out.json = JSON.parse(stdout);
    }
  } catch (err) {
    out.events = undefined;
    out.json = undefined;
    out.jsonError = err;
  }
  return out;
}

export async function runCli(args, opts = {}) {
  const {
    ctx,
    cwd,
    env = {},
    configPath = null,
    cliEntry = CLI_ENTRY,
    nodeArgs = [],
    timeoutMs = DEFAULT_TIMEOUT_MS,
    signalAfter = null,
    capture = null,
    stubs: extraStubs = [],
    gitPinning = true,
    netLog = null
  } = opts;
  if (!ctx) throw new Error("runCli: ctx (makeContext()) is required");
  if (!cwd) throw new Error("runCli: cwd is required");
  if (signalAfter && ctx.hasSleepingMock()) {
    throw new Error("runCli: signalAfter may not be combined with a sleeping mock response (use waitFifo)");
  }
  const stubs = [...new Set([...ctx.stubs, ...extraStubs])];
  const prep = prepareRun(ctx, { env, configPath, gitPinning });
  const before = snapshotCounts(ctx, stubs);
  const leakSnapshot = snapshotRoots({ ...prep.roots, repo: cwd });
  const argv = [...args];

  const child = spawn(process.execPath, [...nodeArgs, cliEntry, ...argv], {
    cwd,
    env: prep.env,
    stdio: ["pipe", "pipe", "pipe"]
  });
  child.stdin.on("error", () => {});
  child.stdin.end();
  const outChunks = [];
  const errChunks = [];
  child.stdout.on("data", (c) => outChunks.push(c));
  child.stderr.on("data", (c) => errChunks.push(c));

  let done = false;
  let timedOut = false;
  const exited = new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code, signal) => { done = true; resolve({ code, signal }); });
  });
  const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, timeoutMs);

  let signalSent = false;
  if (signalAfter) {
    const seen = await waitForFile(signalAfter.waitForFile, { isDone: () => done });
    if (seen && !done) {
      child.kill(signalAfter.signal ?? "SIGINT");
      signalSent = true;
    }
    if (signalAfter.fifo) {
      // Signal first, then release: give the CLI's signal handler the chance to
      // kill the blocked mock (release then hits ENXIO); release regardless after
      // a grace period so a CLI that ignores the signal cannot deadlock the row.
      await Promise.race([exited.catch(() => {}), new Promise((r) => setTimeout(r, 2000))]);
      releaseFifo(ctx.fifo(signalAfter.fifo));
    }
  }

  const { code, signal } = await exited.finally(() => clearTimeout(timer));
  const stdout = Buffer.concat(outChunks).toString("utf8");
  const stderr = Buffer.concat(errChunks).toString("utf8");
  if (timedOut) {
    throw new Error(`runCli: run timed out after ${timeoutMs} ms and was killed: ${argv.join(" ")}\n--- stderr ---\n${stderr}`);
  }
  if (signalAfter && !signalSent) {
    throw new Error(`runCli: signalAfter marker ${signalAfter.waitForFile} never appeared before exit\n--- stderr ---\n${stderr}`);
  }

  // Records added during this call.
  const prompts = [];
  const calls = { mocks: {}, probes: {}, stub: {} };
  for (const name of listMocks(ctx.recordsDir)) {
    const recs = readMockRecords(ctx.recordsDir, name).slice(before.mocks[name] ?? 0);
    for (const r of recs) prompts.push({ mock: name, n: r.n, seq: r.seq, argv: r.argv, stdin: r.stdin });
    if (recs.length) calls.mocks[name] = recs.length;
    const probes = readMockProbes(ctx.recordsDir, name).length - (before.probes[name] ?? 0);
    if (probes) calls.probes[name] = probes;
  }
  prompts.sort((a, b) => a.seq - b.seq);
  const requests = [];
  const unexpected = [];
  const stubTraffic = {};
  for (const b of before.stubs) {
    const added = b.stub.requests.slice(b.requests);
    const unexp = b.stub.unexpected.slice(b.unexpected);
    for (const r of added) {
      requests.push({ provider: r.provider, path: r.path, body: r.rawBody });
      calls.stub[r.provider] = (calls.stub[r.provider] ?? 0) + 1;
    }
    for (const u of unexp) unexpected.push(u);
    if (unexp.length) calls.stub.unexpected = (calls.stub.unexpected ?? 0) + unexp.length;
    stubTraffic[b.stub.port] = added.length + unexp.length;
  }

  const run = {
    code,
    signal,
    stdout,
    stderr,
    lines: stdout.split("\n").filter((l) => l.length),
    ...parseOutput(argv, stdout),
    args: argv,
    configPath: prep.configPath,
    env: prep.env,
    roots: { repo: cwd, ...prep.roots },
    ports: stubs.map((s) => s.port),
    prompts: prompts.map(({ seq, ...p }) => p),
    requests,
    unexpected,
    calls,
    stubTraffic,
    capturePath: undefined,
    netLogPath: netLog ?? undefined
  };

  // Non-enumerable: used by assertNoTokenLeak, never captured.
  Object.defineProperties(run, { ctx: { value: ctx }, leakSnapshot: { value: leakSnapshot } });

  if (netLog) assertRecorderConsistent(run);

  const row = currentRow();
  const rowId = capture?.rowId ?? row?.id;
  const captureDir = capture?.dir ?? process.env.PARITY_CAPTURE;
  if (rowId && captureDir) {
    run.capturePath = writeCapture(captureDir, rowId, {
      argv,
      envKeys: Object.keys(prep.env).sort(),
      code,
      stdout,
      stderr,
      gitState: gitState(cwd),
      calls,
      prompts: run.prompts,
      requests,
      roots: run.roots,
      ports: run.ports,
      preResolution: null,
      node: process.version
    });
  }
  return run;
}

// ─── network recorder (item 13, AP6) ─────────────────────────────────────────

export function withFetchRecorder(runOpts = {}) {
  const ctx = runOpts.ctx;
  if (!ctx) throw new Error("withFetchRecorder: runOpts.ctx is required");
  const log = path.join(ctx.track(mkTemp("parity-netlog-")), "net.ndjson");
  return {
    ...runOpts,
    nodeArgs: [...(runOpts.nodeArgs ?? []), "--require", FETCH_RECORDER],
    env: { ...(runOpts.env ?? {}), PARITY_FETCH_LOG: log },
    netLog: log
  };
}

export function readNetLog(run) {
  if (!run.netLogPath) throw new Error("readNetLog: run was not recorded (use withFetchRecorder)");
  if (!fs.existsSync(run.netLogPath)) return [];
  return fs.readFileSync(run.netLogPath, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

export function readFetchLog(run) {
  return readNetLog(run).map((e) => e.url);
}

function portOf(url) {
  try {
    const u = new URL(url);
    return Number(u.port || (u.protocol === "https:" ? 443 : 80));
  } catch { return null; }
}

// Fails unless the recorder saw at least as many requests to each stub as the
// stub itself counted during that run (so a disabled hook cannot pass vacuously).
export function assertRecorderConsistent(run) {
  const log = readNetLog(run);
  for (const [port, count] of Object.entries(run.stubTraffic ?? {})) {
    const seen = log.filter((e) => /^https?:\/\/(127\.0\.0\.1|localhost)(:|\/)/.test(e.url) && portOf(e.url) === Number(port)).length;
    if (seen < count) {
      throw new Error(`network recorder missed traffic: stub on port ${port} counted ${count} request(s), recorder saw ${seen}`);
    }
  }
}

export function assertOnlyStubUrls(run, stub) {
  countAssertion();
  assertRecorderConsistent(run);
  const prefix = `http://127.0.0.1:${stub.port}/`;
  const foreign = readFetchLog(run).filter((u) => !u.startsWith(prefix));
  if (foreign.length) throw new Error(`network traffic outside the stub (${prefix}): ${foreign.join(", ")}`);
}

// ─── assert helpers (each counts toward the row's AP11 floor) ────────────────

function why(run) {
  return `\n--- argv ---\n${(run.args ?? []).join(" ")}\n--- stderr ---\n${run.stderr ?? ""}`;
}

export function assertExit(run, code) {
  countAssertion();
  assert.equal(run.code, code, `exit code${why(run)}`);
}

export function assertStderrIncludes(run, text) {
  countAssertion();
  assert.ok(run.stderr.includes(text), `stderr should include ${JSON.stringify(text)}${why(run)}`);
}

export function assertStderrExcludes(run, text) {
  countAssertion();
  assert.ok(!run.stderr.includes(text), `stderr should not include ${JSON.stringify(text)}${why(run)}`);
}

export function assertNoProviderCalls(run) {
  countAssertion();
  const n = run.prompts.length + run.requests.length + (run.unexpected?.length ?? 0);
  assert.equal(n, 0, `expected no provider calls, saw ${run.prompts.length} mock invocation(s) and ` +
    `${run.requests.length + (run.unexpected?.length ?? 0)} stub request(s)${why(run)}`);
}

// name: a mock name, or `stub:<provider>` for stub requests during the run.
export function assertCallCount(run, name, expected) {
  countAssertion();
  const actual = name.startsWith("stub:")
    ? run.requests.filter((r) => r.provider === name.slice(5)).length
    : run.prompts.filter((p) => p.mock === name).length;
  assert.equal(actual, expected, `call count for ${name}${why(run)}`);
}

// Deep-equal on every key the expectation names.
export function assertGitState(actual, expected) {
  countAssertion();
  assert.ok(actual, "assertGitState: no git state");
  for (const [k, v] of Object.entries(expected)) {
    assert.deepEqual(actual[k], v, `gitState.${k}`);
  }
}

// Exact stderr (item 12, AP4). Inside row() only. On a DETECTING run (argv not
// exempt and no preResolution declared) it throws unless the row lists 36 in
// futureDeltas or 36 has landed: the D9 hint will change every such stderr.
export function assertStderrExact(run, expected, opts = {}) {
  const { preResolution } = opts;
  if (preResolution !== undefined && (typeof preResolution !== "string" || preResolution === "")) {
    throw new TypeError("assertStderrExact: preResolution must be a non-empty string");
  }
  const row = currentRow();
  if (!row) throw new Error("assertStderrExact must be called inside row()");
  if (preResolution) {
    if (run.args.includes("--loop")) throw new Error("preResolution is invalid with --loop");
    if (run.prompts.length || run.requests.length || run.unexpected?.length) {
      throw new Error("preResolution declared but the run reached a provider");
    }
    if (run.capturePath) {
      const rec = JSON.parse(fs.readFileSync(run.capturePath, "utf8"));
      rec.preResolution = preResolution;
      fs.writeFileSync(run.capturePath, JSON.stringify(rec, null, 2) + "\n");
    }
  }
  const detecting = !exemptByArgv(run.args) && !preResolution;
  if (detecting && !row.landedDeltas.includes(36) && !row.futureDeltas.includes(36)) {
    throw new Error(
      `row ${row.id}: assertStderrExact on a detecting run requires futureDeltas 36 ` +
        `(the D9 setup hint will change this stderr), or a preResolution declaration`
    );
  }
  countAssertion();
  assert.equal(run.stderr, expected, `exact stderr${why(run)}`);
}
