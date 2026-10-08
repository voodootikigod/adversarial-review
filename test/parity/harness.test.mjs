// Parity harness self-test (T50). Every helper the parity rows rely on is
// proved here to be able to FAIL, so a green row is evidence, not an accident.
import assert from "node:assert/strict";
import test, { describe } from "node:test";
import { fileURLToPath } from "node:url";

import {
  DELTAS,
  WITHDRAWN_DELTAS,
  LANDED_DELTAS,
  checkContiguity
} from "./helpers/deltas.mjs";
import {
  defineRows,
  checkManifests,
  loadRepoManifests,
  executeRow,
  countAssertion
} from "./helpers/rows.mjs";

const PARITY_HELPERS = path.join(path.dirname(fileURLToPath(import.meta.url)), "helpers");
const REPO_ROOT_FOR_TEST = path.resolve(PARITY_HELPERS, "..", "..", "..");
const SKIP = process.platform === "win32" ? "parity suite is POSIX-only (#!/bin/sh mock CLIs)" : false;

// ─── AC13: registry content ──────────────────────────────────────────────────

describe("AC13 delta registry", { skip: SKIP }, () => {
  test("DELTAS ids, withdrawn ids, contiguity and disjointness", () => {
    assert.deepEqual(
      DELTAS.map((d) => d.id),
      [1, 2, 4, 5, 6, 8, 9, 12, 14, 15, 16, 17, 18, 19, 21, 22, 23, 24, 25, 26, 28, 29, 30, 31, 32, 33, 34, 35, 36, 37, 38, 39, 40]
    );
    assert.deepEqual(WITHDRAWN_DELTAS, [3, 7, 10, 11, 13, 20, 27]);
    const union = [...DELTAS.map((d) => d.id), ...WITHDRAWN_DELTAS].sort((a, b) => a - b);
    assert.deepEqual(union, Array.from({ length: 40 }, (_, i) => i + 1));
    assert.deepEqual(checkContiguity(), []);
  });

  test("taggable, envelopes, landed, frozen", () => {
    assert.deepEqual(DELTAS.filter((d) => !d.taggable).map((d) => d.id), [28, 37, 38]);
    assert.deepEqual(DELTAS.filter((d) => d.envelope !== null).map((d) => d.id), [34, 35, 36]);
    assert.deepEqual([...LANDED_DELTAS], []);
    assert.ok(Object.isFrozen(LANDED_DELTAS));
    assert.ok(Object.isFrozen(DELTAS));
    for (const d of DELTAS) {
      assert.ok(Object.isFrozen(d), `delta ${d.id} frozen`);
      assert.equal(typeof d.title, "string");
      assert.ok(Array.isArray(d.fields) && d.fields.length > 0, `delta ${d.id} fields`);
    }
    const byId = Object.fromEntries(DELTAS.map((d) => [d.id, d]));
    assert.deepEqual(byId[34].envelope, { kind: "added-event-key", event: "loop_summary", key: "meta.thrash", value: "any" });
    assert.deepEqual(byId[35].envelope, { kind: "added-event-key", event: "loop_summary", key: "meta.rotation", value: null });
    assert.deepEqual(byId[36].envelope, { kind: "added-stderr-line", maxLines: 1, contains: "adversarial-review setup", detectingOnly: true });
    assert.equal(byId[37].envelope, null);
    // AP3 pinned field scopes.
    const ALL = ["argv", "code", "stdout", "stderr", "gitState", "calls", "prompts", "requests"];
    const pinned = {
      1: ["argv", "stderr"], 8: ["stdout", "prompts", "requests"], 9: ["stdout", "prompts", "requests"],
      14: ["prompts", "requests"], 15: ["requests", "prompts", "stdout", "stderr"], 17: ["stderr", "code", "stdout"],
      31: ["prompts", "requests"], 39: ["stdout", "stderr"], 40: ["stderr", "gitState"]
    };
    for (const d of DELTAS) assert.deepEqual([...d.fields], pinned[d.id] ?? ALL, `delta ${d.id} fields`);
    assert.equal(byId[1].title, "independence enforced fail-closed");
    assert.equal(byId[40].title, "wt rollback preserves the staged/unstaged split");
  });

  test("negative control: contiguity reports a missing id, an id above 40, and an id in both lists", () => {
    const without33 = DELTAS.filter((d) => d.id !== 33);
    assert.match(checkContiguity({ deltas: without33 }).join("\n"), /33/);
    const with41 = [...DELTAS, { id: 41 }];
    assert.match(checkContiguity({ deltas: with41 }).join("\n"), /41/);
    const with7 = [...DELTAS, { id: 7 }];
    assert.match(checkContiguity({ deltas: with7 }).join("\n"), /7.*both|both.*7/);
  });
});

// ─── AC8 / AC14 / AP11: manifests and tag validation ─────────────────────────

function reasons(violations) {
  return violations.map((v) => `${v.file}|${v.rowId}|${JSON.stringify(v.value)}|${v.reason}`);
}

describe("AC8 row registry checks", { skip: SKIP }, () => {
  test("(a) the repository's manifests pass every cross-manifest check", () => {
    const { manifests, testStems } = loadRepoManifests();
    assert.ok(manifests["harness.json"], "harness manifest present");
    assert.deepEqual(reasons(checkManifests({ manifests, testStems })), []);
  });

  test("(b) duplicate id, orphan manifest and test file without manifest are reported", () => {
    const ok = { roadmapRef: "Step 0", futureDeltas: [] };
    const v = reasons(checkManifests({
      manifests: { "a.json": { X: ok }, "b.json": { X: ok }, "orphan.json": { Y: ok } },
      testStems: ["a", "b", "lonely"]
    }));
    assert.ok(v.some((s) => s.includes("|X|") && /duplicate id/.test(s)), v.join("\n"));
    assert.ok(v.some((s) => s.startsWith("orphan.json|") && /no matching .test.mjs/.test(s)), v.join("\n"));
    assert.ok(v.some((s) => s.startsWith("lonely.json|") && /no manifest/.test(s)), v.join("\n"));
  });
});

describe("AC14 tag validation", { skip: SKIP }, () => {
  const row = (futureDeltas, extra = {}) => ({ "x.json": { R1: { roadmapRef: "Step 0", futureDeltas, ...extra } } });

  test("accepted: [1, 8, 32, 33, 34, 35, 36]", () => {
    assert.deepEqual(reasons(checkManifests({ manifests: row([1, 8, 32, 33, 34, 35, 36]) })), []);
  });

  const rejected = [
    [7, /withdrawn/],
    [28, /untaggable/],
    [37, /untaggable/],
    [38, /untaggable/],
    [0, /unknown/],
    [41, /unknown/],
    [99, /unknown/],
    ["35", /not an integer/],
    [35.5, /not an integer/]
  ];
  for (const [value, reason] of rejected) {
    test(`rejected: ${JSON.stringify(value)}`, () => {
      const v = checkManifests({ manifests: row([value]) });
      assert.equal(v.length, 1, JSON.stringify(v));
      assert.equal(v[0].file, "x.json");
      assert.equal(v[0].rowId, "R1");
      assert.deepEqual(v[0].value, value);
      assert.match(v[0].reason, reason);
    });
  }

  test("rejected: duplicate [35, 35]", () => {
    const v = checkManifests({ manifests: row([35, 35]) });
    assert.equal(v.length, 1);
    assert.equal(v[0].value, 35);
    assert.match(v[0].reason, /duplicate/);
  });

  test("rejected: 35 when injected LANDED_DELTAS contains 35", () => {
    const v = checkManifests({ manifests: row([35]), landedDeltas: [35] });
    assert.equal(v.length, 1);
    assert.match(v[0].reason, /landed/);
    assert.deepEqual(checkManifests({ manifests: row([35]), landedDeltas: [] }), []);
  });

  test("AP11: minAssertions must be a positive integer", () => {
    assert.deepEqual(checkManifests({ manifests: row([], { minAssertions: 3 }) }), []);
    for (const bad of [0, "3", -1, 1.5]) {
      const v = checkManifests({ manifests: row([], { minAssertions: bad }) });
      assert.equal(v.length, 1, `minAssertions ${JSON.stringify(bad)}`);
      assert.match(v[0].reason, /minAssertions/);
    }
  });
});

// ─── AC8(c) / AP11: defineRows registration and the assertion floor ──────────

const dupRows = defineRows("registry-selftest", {
  manifest: { "REG-ONCE": { roadmapRef: "Step 0. Parity suite (harness self-test)", futureDeltas: [] } }
});
dupRows.row("REG-ONCE", "registered exactly once", async () => {});

describe("AC8(c) defineRows", { skip: SKIP }, () => {
  test("row() throws for an id absent from the manifest", () => {
    assert.throws(() => dupRows.row("NOT-IN-MANIFEST", "x", async () => {}), /NOT-IN-MANIFEST.*not in/);
  });
  test("row() throws for an id registered twice", () => {
    assert.throws(() => dupRows.row("REG-ONCE", "again", async () => {}), /REG-ONCE.*twice/);
  });
});

describe("AP11 assertion floor", { skip: SKIP }, () => {
  const entry = (minAssertions) => ({ roadmapRef: "Step 0", futureDeltas: [], minAssertions });
  const twoAsserts = async () => { countAssertion(); countAssertion(); };

  test("a row with minAssertions 3 making 2 assertions fails", async () => {
    await assert.rejects(
      executeRow({ id: "FLOOR", entry: entry(3), landedDeltas: [] }, twoAsserts),
      /row FLOOR made 2 assertions, below its floor 3/
    );
  });
  test("with minAssertions 2 it passes", async () => {
    await executeRow({ id: "FLOOR", entry: entry(2), landedDeltas: [] }, twoAsserts);
  });
});

// ─── AC5 and mock CLI mechanics (direct spawn, no CLI) ───────────────────────

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
  writeMockCli,
  readMockRecords,
  readMockProbes,
  failTwice,
  isReviewPrompt,
  isVerifyPrompt
} from "./helpers/mock-cli.mjs";

function tmpDirs() {
  const base = fs.realpathSync(os.tmpdir());
  const mocksDir = fs.mkdtempSync(path.join(base, "parity-selftest-mocks-"));
  const recordsDir = fs.mkdtempSync(path.join(base, "parity-selftest-records-"));
  const fifoDir = fs.mkdtempSync(path.join(base, "parity-selftest-fifo-"));
  return { mocksDir, recordsDir, fifoDir, cleanup: () => [mocksDir, recordsDir, fifoDir].forEach((d) => fs.rmSync(d, { recursive: true, force: true })) };
}

function spawnMock(file, args, { input = "", cwd, env } = {}) {
  return spawnSync(file, args, { input, cwd, env: env ?? { PATH: "/nonexistent" }, encoding: "utf8" });
}

describe("AC5 mock CLI probes and queue", { skip: SKIP }, () => {
  test("a --version probe prints 1.0.0, is recorded under probes/, and does not consume response #1", (t) => {
    const d = tmpDirs();
    t.after(d.cleanup);
    const file = writeMockCli(d.mocksDir, "claude", { responses: [{ stdout: "RESPONSE-ONE" }], recordsDir: d.recordsDir, fifoDir: d.fifoDir });
    const probe = spawnMock(file, ["--version"]);
    assert.equal(probe.status, 0);
    assert.equal(probe.stdout, "1.0.0\n");
    assert.ok(fs.existsSync(path.join(d.recordsDir, "claude", "probes", "1.argv")));
    const call = spawnMock(file, ["-p", "-"], { input: "the prompt" });
    assert.equal(call.status, 0, call.stderr);
    assert.equal(call.stdout, "RESPONSE-ONE");
    const recs = readMockRecords(d.recordsDir, "claude");
    assert.equal(recs.length, 1);
    assert.equal(recs[0].n, 1);
    assert.deepEqual(recs[0].argv, ["-p", "-"]);
    assert.equal(recs[0].stdin, "the prompt");
    assert.equal(fs.readFileSync(path.join(d.recordsDir, "claude", "1.argv"), "utf8"), "-p\n-\n");
    assert.equal(readMockProbes(d.recordsDir, "claude").length, 1);
  });

  test("an exhausted queue exits 97 with 'parity-mock: unexpected call'; repeatLast repeats", (t) => {
    const d = tmpDirs();
    t.after(d.cleanup);
    const strict = writeMockCli(d.mocksDir, "agy", { responses: [{ stdout: "A" }], recordsDir: d.recordsDir, fifoDir: d.fifoDir });
    assert.equal(spawnMock(strict, []).stdout, "A");
    const extra = spawnMock(strict, []);
    assert.equal(extra.status, 97);
    assert.match(extra.stderr, /parity-mock: unexpected call/);
    assert.equal(readMockRecords(d.recordsDir, "agy").length, 2, "the extra call is still recorded");
    const lenient = writeMockCli(d.mocksDir, "copilot", { responses: [{ stdout: "B" }], repeatLast: true, recordsDir: d.recordsDir, fifoDir: d.fifoDir });
    assert.equal(spawnMock(lenient, []).stdout, "B");
    assert.equal(spawnMock(lenient, []).stdout, "B");
  });

  test("stderr, exit code, recordEnv, nested writeFiles, argv with newlines, and --output-last-message", (t) => {
    const d = tmpDirs();
    const cwd = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "parity-selftest-cwd-"));
    t.after(() => { d.cleanup(); fs.rmSync(cwd, { recursive: true, force: true }); });
    const file = writeMockCli(d.mocksDir, "codex", {
      responses: [
        { stdout: "OUT", stderr: "ERR\n", exit: 3, writeFiles: { "a/b/c.txt": "nested\n" } },
        { stdout: "{\"verdict\":\"approve\"}" }
      ],
      recordEnv: ["FOO", "UNSET_VAR"],
      recordsDir: d.recordsDir,
      fifoDir: d.fifoDir
    });
    const r1 = spawnMock(file, ["exec", "line1\nline2"], { cwd, env: { PATH: "/nonexistent", FOO: "bar" } });
    assert.equal(r1.status, 3);
    assert.equal(r1.stdout, "OUT");
    assert.equal(r1.stderr, "ERR\n");
    assert.equal(fs.readFileSync(path.join(cwd, "a/b/c.txt"), "utf8"), "nested\n");
    const outFile = path.join(cwd, "last.txt");
    const r2 = spawnMock(file, ["exec", "--output-last-message", outFile, "-"], { cwd });
    assert.equal(r2.status, 0);
    assert.equal(r2.stdout, "", "codex contract: the response goes to the --output-last-message file");
    assert.equal(fs.readFileSync(outFile, "utf8"), "{\"verdict\":\"approve\"}");
    const recs = readMockRecords(d.recordsDir, "codex");
    assert.deepEqual(recs[0].argv, ["exec", "line1\nline2"]);
    assert.deepEqual(recs[0].env, { FOO: "bar", UNSET_VAR: "" });
    assert.equal(fs.readFileSync(path.join(d.recordsDir, "codex", "1.env"), "utf8"), "FOO=bar\nUNSET_VAR=\n");
    assert.ok(recs[0].seq < recs[1].seq, "global sequence orders invocations");
  });

  test("failTwice scripts two identical failure responses", () => {
    assert.deepEqual(failTwice({ stderr: "boom", exit: 1 }), [{ stderr: "boom", exit: 1 }, { stderr: "boom", exit: 1 }]);
  });

  test("isReviewPrompt / isVerifyPrompt classify the fixed role text", () => {
    assert.ok(isReviewPrompt("Prompt:\n<role>\nYou are performing an adversarial software review.\n"));
    assert.ok(!isVerifyPrompt("You are performing an adversarial software review."));
    assert.ok(isVerifyPrompt("<role>\nYou are re-examining a single code-review finding. Your job is to REFUTE it only when you can."));
    assert.ok(!isReviewPrompt("You are re-examining a single code-review finding."));
    assert.ok(!isReviewPrompt("hello") && !isVerifyPrompt("hello"));
  });
});

// ─── HTTP stub mechanics (direct requests, no CLI) ───────────────────────────

import {
  createStub,
  providerEnv,
  anthropicReply,
  openaiReply,
  geminiReply,
  rawReply
} from "./helpers/http-stub.mjs";

async function post(url, body) {
  const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return { status: res.status, text: await res.text() };
}

describe("HTTP stub", { skip: SKIP }, () => {
  test("routes by provider prefix, records prefix-relative paths, FIFO per provider", async (t) => {
    const stub = await createStub();
    t.after(() => stub.close());
    stub.enqueue("anthropic", anthropicReply({ verdict: "approve" }));
    stub.enqueue("openai", openaiReply({ verdict: "approve" }));
    stub.enqueue("gemini", geminiReply({ verdict: "approve" }));
    stub.enqueue("gateway", rawReply(503, "busy"));
    const a = await post(`${stub.base("anthropic")}/messages`, { m: 1 });
    assert.equal(a.status, 200);
    assert.deepEqual(JSON.parse(a.text).content[0], { type: "tool_use", id: "toolu_parity", name: "submit_review", input: { verdict: "approve" } });
    assert.equal(JSON.parse(a.text).stop_reason, "tool_use");
    const o = await post(`${stub.base("openai")}/chat/completions`, {});
    assert.equal(JSON.parse(JSON.parse(o.text).choices[0].message.content).verdict, "approve");
    const g = await post(`${stub.base("gemini")}/v1beta/models/gemini-x:generateContent`, {});
    assert.equal(JSON.parse(JSON.parse(g.text).candidates[0].content.parts[0].text).verdict, "approve");
    const gw = await post(`${stub.base("gateway")}/chat/completions`, {});
    assert.deepEqual(gw, { status: 503, text: "busy" });
    assert.deepEqual(stub.requests.map((r) => [r.provider, r.path]), [
      ["anthropic", "/v1/messages"], ["openai", "/v1/chat/completions"],
      ["gemini", "/v1beta/models/gemini-x:generateContent"], ["gateway", "/v1/chat/completions"]
    ]);
    assert.deepEqual(stub.requests[0].body, { m: 1 });
    assert.equal(stub.requests[0].rawBody, "{\"m\":1}");
    stub.assertNoUnexpected();
  });

  test("an empty queue and an unknown path both answer 418 and land in stub.unexpected", async (t) => {
    const stub = await createStub();
    t.after(() => stub.close());
    const empty = await post(`${stub.base("anthropic")}/messages`, {});
    assert.equal(empty.status, 418);
    assert.equal(empty.text, "parity-stub: unexpected request");
    const decider = await post(`http://127.0.0.1:${stub.port}/v1/systemone`, {});
    assert.equal(decider.status, 418);
    assert.equal(stub.unexpected.length, 2);
    assert.equal(stub.unexpected[1].path, "/v1/systemone");
    assert.equal(stub.unexpected[1].provider, null);
    assert.throws(() => stub.assertNoUnexpected(), /unexpected/);
  });

  test("providerEnv points each provider at its prefix with a dummy key", async (t) => {
    const stub = await createStub();
    t.after(() => stub.close());
    assert.deepEqual(providerEnv(stub, "anthropic"), { ANTHROPIC_BASE_URL: `http://127.0.0.1:${stub.port}/anthropic/v1`, ANTHROPIC_API_KEY: "dummy" });
    assert.deepEqual(providerEnv(stub, "openai"), { OPENAI_BASE_URL: `http://127.0.0.1:${stub.port}/openai/v1`, OPENAI_API_KEY: "dummy" });
    assert.deepEqual(providerEnv(stub, "gemini"), { GEMINI_BASE_URL: `http://127.0.0.1:${stub.port}/gemini`, GEMINI_API_KEY: "dummy" });
    assert.deepEqual(providerEnv(stub, "gateway"), { AI_GATEWAY_BASE_URL: `http://127.0.0.1:${stub.port}/gateway/v1`, AI_GATEWAY_API_KEY: "dummy" });
  });
});

// ─── harness: hermetic env, curated PATH, smoke rows, guards ─────────────────

import {
  makeContext,
  makeRepo,
  gitState,
  prepareRun,
  runCli,
  assertExit,
  assertStderrIncludes,
  assertStderrExcludes,
  assertStderrExact,
  assertNoProviderCalls,
  assertCallCount,
  assertGitState,
  APPROVE,
  FLAG,
  tmpBase
} from "./helpers/harness.mjs";

const J = (o) => JSON.stringify(o);
const smoke = defineRows("harness");

describe("AC1 hermetic env", { skip: SKIP }, () => {
  const LEAKY = {
    CLAUDECODE: "1",
    TERM_PROGRAM: "vscode",
    ANTHROPIC_API_KEY: "sk-ant-parent-leak",
    ADVERSARIAL_REVIEW_BUILDER: "claude",
    ADVERSARIAL_REVIEW_DECIDER_URL: "http://127.0.0.1:1/decider"
  };
  const RECORD = [...Object.keys(LEAKY), "HOME"];

  test("parent builder/key/decider variables never reach the child; HOME is the temp home", async (t) => {
    const saved = Object.fromEntries(Object.keys(LEAKY).map((k) => [k, process.env[k]]));
    Object.assign(process.env, LEAKY);
    t.after(() => {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    });
    const ctx = makeContext(t);
    const repo = makeRepo({ ctx });
    ctx.mock("claude", { responses: [{ stdout: J(APPROVE) }], recordEnv: RECORD });
    const run = await runCli(["--provider", "claude"], { ctx, cwd: repo.dir });
    assertExit(run, 0);
    const env = fs.readFileSync(path.join(ctx.recordsDir, "claude", "1.env"), "utf8");
    for (const k of Object.keys(LEAKY)) assert.ok(env.includes(`\n${k}=\n`) || env.startsWith(`${k}=\n`), `${k} must be empty:\n${env}`);
    assert.ok(env.includes(`HOME=${run.roots.home}\n`), env);
    assert.ok(run.roots.home.startsWith(tmpBase()));
  });

  test("negative control: an explicit override is visible in the record", async (t) => {
    const ctx = makeContext(t);
    const repo = makeRepo({ ctx });
    ctx.mock("claude", { responses: [{ stdout: J(APPROVE) }], recordEnv: RECORD });
    const run = await runCli(["--provider", "claude"], { ctx, cwd: repo.dir, env: { CLAUDECODE: "1" } });
    assertExit(run, 0);
    assert.equal(ctx.records("claude")[0].env.CLAUDECODE, "1");
  });
});

describe("AC2 curated PATH", { skip: SKIP }, () => {
  test("bwrap, unshare and getconf do not resolve; only the planted codex mock does", (t) => {
    const ctx = makeContext(t);
    const repo = makeRepo({ ctx });
    ctx.mock("codex", { responses: [] });
    const out = path.join(ctx.dir, "pathprobe.out");
    const probe = path.join(ctx.mocksDir, "pathprobe");
    fs.writeFileSync(probe, `#!/bin/sh\nfor c in bwrap unshare getconf codex; do command -v "$c"; done > '${out}'\nexit 0\n`, { mode: 0o755 });
    const { env } = prepareRun(ctx);
    const r = spawnSync(probe, [], { cwd: repo.dir, env, encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(fs.readFileSync(out, "utf8"), `${path.join(ctx.mocksDir, "codex")}\n`);
    for (const d of [ctx.mocksDir, ctx.sysbinDir]) {
      assert.ok(path.relative(repo.dir, d).startsWith(".."), `${d} must be outside the repo`);
    }
    assert.deepEqual(fs.readdirSync(ctx.sysbinDir).sort(), ["cat", "env", "git", "mkdir", "node", "rm", "sh", "sleep", "touch"]);
  });
});

smoke.row("SMOKE-CLI", "claude mock reviewer, working tree, --json", async (t) => {
  const ctx = makeContext(t);
  const repo = makeRepo({ ctx });
  ctx.mock("claude", { responses: [{ stdout: J(APPROVE) }], repeatLast: true });
  const runs = [];
  for (let i = 0; i < 3; i++) runs.push(await runCli(["--provider", "claude", "--json"], { ctx, cwd: repo.dir }));
  const [run] = runs;
  assertExit(run, 0);
  assert.equal(run.json.verdict, "approve");
  assertCallCount(run, "claude", 1);
  assert.equal(ctx.records("claude").length, 3);
  assert.ok(isReviewPrompt(run.prompts[0].stdin));
  assert.ok(run.prompts[0].stdin.includes("export const x = 2; // changed"));
  // AC9: three runs, identical { code, parsed stdout }; fresh config path per call.
  for (const r of runs) assert.deepEqual({ code: r.code, json: r.json }, { code: run.code, json: run.json });
  assert.notEqual(runs[0].configPath, runs[1].configPath);
  // AC16: a detecting run in a row without futureDeltas 36 cannot assert exact stderr.
  assert.throws(() => assertStderrExact(run, run.stderr), /SMOKE-CLI.*futureDeltas 36/);
  // AP4: a preResolution declaration on a run that reached a provider is refused.
  assert.throws(() => assertStderrExact(run, run.stderr, { preResolution: "usage error" }), /preResolution declared but the run reached a provider/);
  // AC10: capture file content.
  const capDir = ctx.track(fs.mkdtempSync(path.join(tmpBase(), "parity-cap-")));
  const cap = await runCli(["--provider", "claude", "--json"], { ctx, cwd: repo.dir, capture: { dir: capDir } });
  assert.equal(cap.capturePath, path.join(capDir, "SMOKE-CLI", "1.json"));
  const rec = JSON.parse(fs.readFileSync(cap.capturePath, "utf8"));
  assert.deepEqual(rec.argv, ["--provider", "claude", "--json"]);
  assert.deepEqual(Object.keys(rec.roots).sort(), ["configDir", "home", "mocks", "repo", "sysbin", "tmp", "xdg"]);
  for (const p of Object.values(rec.roots)) {
    assert.ok(path.isAbsolute(p) && p.startsWith(tmpBase() + path.sep) && fs.existsSync(p), p);
  }
  assert.equal(cap.configPath, path.join(rec.roots.configDir, "config.json"));
  assert.equal(rec.node, process.version);
  assert.equal(rec.preResolution, null);
  assert.deepEqual(rec.calls, { mocks: { claude: 1 }, probes: {}, stub: {} });
  assert.equal(rec.prompts.length, 1);
  assert.ok(fs.existsSync(path.join(capDir, "_manifests", "harness.json")));
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(capDir, "_manifests", "landed.json"), "utf8")), []);
});

smoke.row("SMOKE-API", "anthropic stub reviewer, working tree, --json", async (t) => {
  const ctx = makeContext(t);
  const repo = makeRepo({ ctx });
  const stub = await ctx.stub();
  const runs = [];
  for (let i = 0; i < 3; i++) {
    stub.enqueue("anthropic", anthropicReply(APPROVE));
    runs.push(await runCli(["--provider", "anthropic", "--json"], { ctx, cwd: repo.dir, env: providerEnv(stub, "anthropic") }));
  }
  const [run] = runs;
  assertExit(run, 0);
  assert.equal(run.json.verdict, "approve");
  assertCallCount(run, "stub:anthropic", 1);
  assert.equal(run.requests[0].path, "/v1/messages");
  assert.ok(isReviewPrompt(JSON.parse(run.requests[0].body).messages[0].content));
  stub.assertNoUnexpected();
  for (const r of runs) assert.deepEqual({ code: r.code, json: r.json }, { code: run.code, json: run.json });
  // AC19 / AP6(a): the same run through the network recorder logs exactly the stub URL, via fetch.
  stub.enqueue("anthropic", anthropicReply(APPROVE));
  const rec = await runCli(["--provider", "anthropic", "--json"], withFetchRecorder({ ctx, cwd: repo.dir, env: providerEnv(stub, "anthropic") }));
  assertExit(rec, 0);
  assert.deepEqual(readNetLog(rec), [{ api: "fetch", url: `http://127.0.0.1:${stub.port}/anthropic/v1/messages` }]);
  assertOnlyStubUrls(rec, stub);
  stub.assertNoUnexpected();
});

describe("AC3/AC4 negative controls", { skip: SKIP }, () => {
  test("claude mock with an empty queue: exit 1, two invocations (stdin then argv), unexpected-call stderr", async (t) => {
    const ctx = makeContext(t);
    const repo = makeRepo({ ctx });
    ctx.mock("claude", { responses: [] });
    const run = await runCli(["--provider", "claude", "--json"], { ctx, cwd: repo.dir });
    assertExit(run, 1);
    const recs = ctx.records("claude");
    assert.equal(recs.length, 2);
    assert.deepEqual(recs[0].argv, ["--permission-mode", "plan", "-p", "-"]);
    assert.ok(isReviewPrompt(recs[0].stdin));
    assert.equal(recs[1].argv[3].startsWith("System Instructions:"), true, "argv retry carries the prompt");
    assertStderrIncludes(run, "parity-mock: unexpected call");
  });

  test("anthropic stub with an empty queue: exit 1, one 418, assertNoUnexpected throws", async (t) => {
    const ctx = makeContext(t);
    const repo = makeRepo({ ctx });
    const stub = await ctx.stub();
    const run = await runCli(["--provider", "anthropic", "--json"], { ctx, cwd: repo.dir, env: providerEnv(stub, "anthropic") });
    assertExit(run, 1);
    assert.equal(stub.unexpected.length, 1);
    assert.throws(() => stub.assertNoUnexpected());
    assertStderrIncludes(run, "Anthropic API error (418): parity-stub: unexpected request");
  });
});

describe("AC7 assertion helpers can fail", { skip: SKIP }, () => {
  test("each helper throws on a wrong expectation", async (t) => {
    const ctx = makeContext(t);
    const repo = makeRepo({ ctx });
    ctx.mock("claude", { responses: [{ stdout: J(APPROVE) }] });
    const run = await runCli(["--provider", "claude", "--json"], { ctx, cwd: repo.dir });
    assertExit(run, 0);
    assert.throws(() => assertExit(run, 2));
    assert.throws(() => assertStderrIncludes(run, "this text is not on stderr"));
    assert.throws(() => assertStderrExcludes(run, "Target: working tree"));
    assert.throws(() => assertNoProviderCalls(run));
    assert.throws(() => assertCallCount(run, "claude", 2));
    assert.throws(() => assertCallCount(run, "stub:anthropic", 1));
    const state = gitState(repo.dir);
    assertGitState(state, { branch: "main", untracked: [] });
    assert.throws(() => assertGitState(state, { branch: "feature" }));
    assert.throws(() => assertStderrExact(run, ""), /inside row/);
  });
});

// AC16 / AP4 guard rows (injected manifests; they are real node:test rows).
const guardRows = defineRows("guard-selftest", {
  manifest: {
    "GUARD-36": { roadmapRef: "Step 0. Parity suite (harness self-test)", futureDeltas: [36] },
    "GUARD-NO36": { roadmapRef: "Step 0. Parity suite (harness self-test)", futureDeltas: [] }
  }
});
const landedRows = defineRows("guard-landed-selftest", {
  manifest: { "GUARD-LANDED": { roadmapRef: "Step 0. Parity suite (harness self-test)", futureDeltas: [] } },
  landedDeltas: [36]
});

guardRows.row("GUARD-36", "36 listed: exact stderr allowed; mismatch is an assertion error", async (t) => {
  const ctx = makeContext(t);
  const repo = makeRepo({ ctx });
  ctx.mock("claude", { responses: [{ stdout: J(APPROVE) }] });
  const run = await runCli(["--provider", "claude", "--json"], { ctx, cwd: repo.dir });
  assertStderrExact(run, run.stderr);
  assert.throws(() => assertStderrExact(run, run.stderr + "x"), { name: "AssertionError" });
});

guardRows.row("GUARD-NO36", "argv exemptions, preResolution declaration and its cross-checks", async (t) => {
  const ctx = makeContext(t);
  const repo = makeRepo({ ctx });
  // non-loop --prompt-only and `setup` are exempt from argv.
  const po = await runCli(["--prompt-only"], { ctx, cwd: repo.dir });
  assertStderrExact(po, po.stderr);
  const setup = await runCli(["setup"], { ctx, cwd: repo.dir });
  assertStderrExact(setup, setup.stderr);
  // usage error before any resolution, declared.
  const capDir = ctx.track(fs.mkdtempSync(path.join(tmpBase(), "parity-cap-")));
  const usage = await runCli(["--model", "x", "--providers", "openai"], { ctx, cwd: repo.dir, capture: { dir: capDir } });
  assertExit(usage, 1);
  assertNoProviderCalls(usage);
  assert.throws(() => assertStderrExact(usage, usage.stderr), /GUARD-NO36.*futureDeltas 36/);
  assertStderrExact(usage, usage.stderr, { preResolution: "usage error" });
  assert.equal(JSON.parse(fs.readFileSync(usage.capturePath, "utf8")).preResolution, "usage error");
  assert.throws(() => assertStderrExact(usage, usage.stderr, { preResolution: "" }), TypeError);
  // AP4: preResolution is invalid with --loop.
  const loop = await runCli(["--loop", "--json"], { ctx, cwd: repo.dir });
  assertNoProviderCalls(loop);
  assert.throws(() => assertStderrExact(loop, loop.stderr, { preResolution: "sandbox refusal" }), /preResolution is invalid with --loop/);
});

landedRows.row("GUARD-LANDED", "36 landed: the guard no longer applies", async (t) => {
  const ctx = makeContext(t);
  const repo = makeRepo({ ctx });
  ctx.mock("claude", { responses: [{ stdout: J(APPROVE) }] });
  const run = await runCli(["--provider", "claude", "--json"], { ctx, cwd: repo.dir });
  assertStderrExact(run, run.stderr);
});

// ─── capture-compare (item 11, AC9/AC10/AC15/AC17/AC18, AP1-AP3, AP5) ────────

const CC = path.join(PARITY_HELPERS, "capture-compare.mjs");

function compare(...args) {
  const r = spawnSync(process.execPath, [CC, ...args], { encoding: "utf8" });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, out: r.stdout + r.stderr };
}

const SYN_REF = "Step 0. Parity suite (harness self-test)";

function synthCapture(label, over = {}) {
  const b = path.join(tmpBase(), `parity-synth-${label}`);
  return {
    argv: ["--provider", "claude", "--json"],
    envKeys: ["HOME", "PATH"],
    code: 0,
    stdout: "{\n  \"verdict\": \"approve\"\n}\n",
    stderr: `ℹ Target: working tree on branch main\nusing ${b}-repo/code.js\n`,
    gitState: { head: "abc", headParent: null, branch: "main", statusPorcelain: " M code.js\n", stashList: "", files: { "code.js": "x\n" }, untracked: [] },
    calls: { mocks: { claude: 1 }, probes: {}, stub: {} },
    prompts: [{ mock: "claude", n: 1, argv: ["-p", "-"], stdin: "Target: <<<UNTRUSTED:TARGET_LABEL:AAAAAAAAAAAA>>>\nbody\n" }],
    requests: [{ provider: "anthropic", path: "/v1/messages", body: "{\"messages\":[{\"content\":\"hello\"}]}" }],
    roots: {
      repo: `${b}-repo`, mocks: `${b}-mocks`, sysbin: `${b}-sysbin`, home: `${b}-home`,
      xdg: `${b}-xdg`, tmp: `${b}-tmp`, configDir: `${b}-config`
    },
    ports: [label === "A" ? 40001 : 40002],
    preResolution: null,
    node: process.version,
    ...over
  };
}

// rows: { rowId: [capture, ...] }, manifests: { file: manifest }, landed: [ids]
function writeTree(rows, { manifests = null, landed = [] } = {}) {
  const dir = fs.mkdtempSync(path.join(tmpBase(), "parity-tree-"));
  const m = manifests ?? { "synth.json": Object.fromEntries(Object.keys(rows).map((id) => [id, { roadmapRef: SYN_REF, futureDeltas: [] }])) };
  fs.mkdirSync(path.join(dir, "_manifests"));
  for (const [f, obj] of Object.entries(m)) fs.writeFileSync(path.join(dir, "_manifests", f), JSON.stringify(obj));
  fs.writeFileSync(path.join(dir, "_manifests", "landed.json"), JSON.stringify(landed));
  for (const [id, caps] of Object.entries(rows)) {
    fs.mkdirSync(path.join(dir, id));
    caps.forEach((c, i) => fs.writeFileSync(path.join(dir, id, `${i + 1}.json`), JSON.stringify(c)));
  }
  return dir;
}

function pair(t, baseOver = {}, headOver = {}, opts = {}) {
  const base = writeTree({ "SYN-1": [synthCapture("A", baseOver)] }, opts.base ?? {});
  const head = writeTree({ "SYN-1": [synthCapture("B", headOver)] }, opts.head ?? {});
  t.after(() => { fs.rmSync(base, { recursive: true, force: true }); fs.rmSync(head, { recursive: true, force: true }); });
  return [base, head];
}

const manifestWith = (futureDeltas, id = "SYN-1") => ({ "synth.json": { [id]: { roadmapRef: SYN_REF, futureDeltas } } });

describe("AC18 executable helpers under discovery", { skip: SKIP }, () => {
  test("capture-compare with no arguments exits 0 silently; one argument exits 2 with usage", () => {
    const none = compare();
    assert.deepEqual([none.status, none.stdout, none.stderr], [0, "", ""]);
    const one = compare("only-one");
    assert.equal(one.status, 2);
    assert.match(one.stderr, /^usage: capture-compare/m);
  });
});

describe("AC10 capture-compare basics", { skip: SKIP }, () => {
  test("--print-normalized: a recorded root prints as its token, an unrecorded tmp path stays raw", (t) => {
    const dir = fs.mkdtempSync(path.join(tmpBase(), "parity-pn-"));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const c = synthCapture("A");
    const stray = path.join(tmpBase(), "parity-not-a-root-xyz", "f.txt");
    c.stderr = `home is ${c.roots.home}/x and stray is ${stray}\n`;
    const file = path.join(dir, "1.json");
    fs.writeFileSync(file, JSON.stringify(c));
    const r = compare("--print-normalized", file);
    assert.equal(r.status, 0, r.out);
    const norm = JSON.parse(r.stdout);
    assert.equal(norm.stderr, `home is <home>/x and stray is ${stray}\n`);
  });

  test("identical captures exit 0; changed code, changed stdout char and BASE-only rows exit 1; HEAD-only is new", (t) => {
    let [b, h] = pair(t);
    assert.equal(compare(b, h).status, 0, compare(b, h).out);
    [b, h] = pair(t, {}, { code: 2 });
    let r = compare(b, h);
    assert.equal(r.status, 1);
    assert.match(r.stdout, /SYN-1.*code/);
    [b, h] = pair(t, {}, { stdout: "{\n  \"verdict\": \"approvE\"\n}\n" });
    r = compare(b, h);
    assert.equal(r.status, 1);
    assert.match(r.stdout, /SYN-1.*stdout/);
    const base = writeTree({ "SYN-1": [synthCapture("A")], "SYN-GONE": [synthCapture("A")] });
    const head = writeTree({ "SYN-1": [synthCapture("B")], "SYN-NEW": [synthCapture("B")] }, {
      manifests: { "synth.json": { "SYN-1": { roadmapRef: SYN_REF, futureDeltas: [] }, "SYN-NEW": { roadmapRef: SYN_REF, futureDeltas: [] } } }
    });
    t.after(() => { fs.rmSync(base, { recursive: true, force: true }); fs.rmSync(head, { recursive: true, force: true }); });
    r = compare(base, head);
    assert.equal(r.status, 1);
    assert.match(r.stdout, /REMOVED row SYN-GONE/);
    assert.match(r.stdout, /NEW row SYN-NEW/);
    const headOnly = writeTree({ "SYN-1": [synthCapture("B")], "SYN-NEW": [synthCapture("B")] }, {
      manifests: { "synth.json": { "SYN-1": { roadmapRef: SYN_REF, futureDeltas: [] }, "SYN-NEW": { roadmapRef: SYN_REF, futureDeltas: [] } } }
    });
    const baseOne = writeTree({ "SYN-1": [synthCapture("A")] });
    t.after(() => { fs.rmSync(headOnly, { recursive: true, force: true }); fs.rmSync(baseOne, { recursive: true, force: true }); });
    r = compare(baseOne, headOnly);
    assert.equal(r.status, 0, r.out);
    assert.match(r.stdout, /NEW row SYN-NEW/);
  });
});

describe("AC17 normalization rules", { skip: SKIP }, () => {
  const fence = (nonce) => `Target: <<<UNTRUSTED:TARGET_LABEL:${nonce}>>>\n<<<END:TARGET_LABEL:${nonce}>>>\n`;
  const cases = {
    "n1 temp root": [(c) => ({ stderr: `at ${c.roots.tmp}/adv-review-x\n` })],
    "n2 port": [(c) => ({ stderr: `http://127.0.0.1:${c.ports[0]}/anthropic/v1\n` })],
    "n3 stash timestamp": [(c, label) => {
      const ts = label === "A" ? "1759500000000" : "1759500000999";
      return {
        stdout: `{"type":"stash_created","stashName":"adversarial-review-loop-${ts}-iter0"}\n`,
        stderr: `grep 'adversarial-review-loop-${ts}-iter0'\n`,
        gitState: { ...c.gitState, stashList: `stash@{0} On main: adversarial-review-loop-${ts}-iter0\n` }
      };
    }],
    "n4 fence nonce": [(c, label) => ({ stdout: fence(label === "A" ? "abcdEFGH_-12" : "zyxwVUTS-_98") })],
    "n4 mid-line fence nonce": [(c, label) => ({ stdout: `Target: <<<UNTRUSTED:TARGET_LABEL:${label === "A" ? "abcdEFGH_-12" : "zyxwVUTS-_98"}>>> trailing\n` })],
    "n7 fix-prompt FINDING_<i> fence nonce": [(c, label) => ({
      prompts: [{ ...c.prompts[0], stdin: `<<<UNTRUSTED:FINDING_1:${label === "A" ? "abcdEFGH_-12" : "zyxwVUTS-_98"}>>>\nTitle: t\n` }]
    })],
    "n5 raw dump name": [(c, label) => ({ stderr: `raw output in ${c.roots.tmp}/adversarial-review-raw-${label === "A" ? "111-1759500000000" : "222-1759500000999"}.txt\n` })]
  };
  for (const [name, [f]] of Object.entries(cases)) {
    test(`positive: ${name} differs only per run -> exit 0`, (t) => {
      const a = synthCapture("A"); const b = synthCapture("B");
      const [base, head] = pair(t, f(a, "A"), f(b, "B"));
      const r = compare(base, head);
      assert.equal(r.status, 0, r.out);
    });
  }
  const negatives = {
    "a 13-digit number outside the stash-name pattern": ["took 1759500000000 ms\n", "took 1759500000999 ms\n"],
    "a nonce-shaped string not directly after a fence token": [
      "<<<UNTRUSTED:TARGET_LABEL:abcdEFGH_-12>>> and abcdEFGH_-12>>>\n",
      "<<<UNTRUSTED:TARGET_LABEL:zyxwVUTS-_98>>> and zyxwVUTS-_98>>>\n"
    ],
    "a FINDING_<i> nonce with n7 disabled": [
      "<<<UNTRUSTED:FINDING_1:abcdEFGH_-12>>>\n", "<<<UNTRUSTED:FINDING_1:zyxwVUTS-_98>>>\n", ["--no-normalize", "n7"]
    ],
    "adversarial-review-loop- with a non-digit suffix": ["adversarial-review-loop-abc\n", "adversarial-review-loop-abd\n"],
    "a tmp-like path that is not a recorded root": [
      `${path.join(tmpBase(), "parity-zz-A")}/f\n`, `${path.join(tmpBase(), "parity-zz-B")}/f\n`
    ]
  };
  for (const [name, [x, y, extra = []]] of Object.entries(negatives)) {
    test(`negative: ${name} -> exit 1 naming the row`, (t) => {
      const [base, head] = pair(t, { stderr: x }, { stderr: y });
      const r = compare(base, head, ...extra);
      assert.equal(r.status, 1, r.out);
      assert.match(r.stdout, /SYN-1/);
    });
  }
});

describe("AP1 payload fields", { skip: SKIP }, () => {
  test("prompts and requests are compared; a fence-nonce-only difference is not a difference", (t) => {
    const a = synthCapture("A");
    let [base, head] = pair(t, {}, { prompts: [{ ...a.prompts[0], stdin: a.prompts[0].stdin.replace("body", "bodY") }] });
    let r = compare(base, head);
    assert.equal(r.status, 1);
    assert.match(r.stdout, /SYN-1.*prompts/);
    [base, head] = pair(t, {}, { requests: [{ ...a.requests[0], body: a.requests[0].body.replace("hello", "hellO") }] });
    r = compare(base, head);
    assert.equal(r.status, 1);
    assert.match(r.stdout, /SYN-1.*requests/);
    [base, head] = pair(t, {}, { prompts: [{ ...a.prompts[0], stdin: a.prompts[0].stdin.replace("AAAAAAAAAAAA", "BBBBBBBBBBBB") }] });
    r = compare(base, head);
    assert.equal(r.status, 0, r.out);
  });
});

describe("AP2 n6 and the Node-major guard", { skip: SKIP }, () => {
  const W1 = "(node:12345) ExperimentalWarning: The Fetch API is an experimental feature. This feature could change at any time";
  const W2 = "(Use `node --trace-warnings ...` to show where the warning was created)";
  test("(a) captures differing only by the fetch ExperimentalWarning lines -> exit 0", (t) => {
    const a = synthCapture("B");
    const [base, head] = pair(t, {}, { stderr: `${W1}\n${W2}\n${a.stderr}` });
    assert.equal(compare(base, head).status, 0);
  });
  test("(b) a different ExperimentalWarning is not removed -> exit 1", (t) => {
    const a = synthCapture("B");
    const other = "(node:12345) ExperimentalWarning: VM Modules is an experimental feature (--experimental-vm-modules)";
    const [base, head] = pair(t, {}, { stderr: `${other}\n${W2}\n${a.stderr}` });
    assert.equal(compare(base, head).status, 1);
  });
  test("(c) BASE node v18 vs HEAD v22 -> exit 2 naming both; a missing node field -> exit 2", (t) => {
    let [base, head] = pair(t, { node: "v18.20.0" }, { node: "v22.1.0" });
    const r = compare(base, head);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /v18\.20\.0.*v22\.1\.0/);
    [base, head] = pair(t, { node: undefined }, {});
    assert.equal(compare(base, head).status, 2);
  });
  test("--cross-node --field stderr waives the guard and compares only stderr", (t) => {
    let [base, head] = pair(t, { node: "v24.0.0", code: 3 }, { node: "v18.20.0", stderr: `${W1}\n${W2}\n${synthCapture("B").stderr}` });
    let r = compare("--cross-node", "--field", "stderr", base, head);
    assert.equal(r.status, 0, r.out);
    [base, head] = pair(t, { node: "v24.0.0" }, { node: "v18.20.0", stderr: "different\n" });
    r = compare("--cross-node", "--field", "stderr", base, head);
    assert.equal(r.status, 1);
  });
});

describe("AP3 tag scope", { skip: SKIP }, () => {
  test("tagged-for-8 row differing in stdout -> exit 0 with the diff printed; also code -> exit 1 naming code", (t) => {
    const opts = { base: { manifests: manifestWith([8]) }, head: { manifests: manifestWith([]), landed: [8] } };
    let [base, head] = pair(t, {}, { stdout: "{\n  \"verdict\": \"approve\",\n  \"meta\": {}\n}\n" }, opts);
    let r = compare(base, head, "--delta", "8");
    assert.equal(r.status, 0, r.out);
    assert.match(r.stdout, /^\+\s+"meta": \{\}/m);
    [base, head] = pair(t, {}, { code: 2, stdout: "{\n  \"verdict\": \"approve\",\n  \"meta\": {}\n}\n" }, opts);
    r = compare(base, head, "--delta", "8");
    assert.equal(r.status, 1);
    assert.match(r.stdout, /SYN-1.*code/);
  });
});

describe("AC15 envelopes", { skip: SKIP }, () => {
  const LS = { type: "loop_summary", providers: ["anthropic"], iterations: 1, verdict: "approve", exitReason: "clean", survivingCount: 0, acceptedCount: 0 };
  const lines = (...evs) => evs.map((e) => JSON.stringify(e)).join("\n") + "\n";
  const REVIEW = { type: "review", iteration: 1, findingCount: 0 };
  const loopCap = (stdout, over = {}) => ({ argv: ["--loop", "--loop-unsafe", "--json"], stdout, ...over });
  const run = (t, baseStdout, headStdout, args, extra = {}) => {
    const [base, head] = pair(t, loopCap(baseStdout), loopCap(headStdout, extra.head ?? {}), extra.opts ?? {});
    return compare(base, head, ...args);
  };

  test("34: meta.thrash on loop_summary is envelope; meta.foo, a changed iterations, or --delta 35 are not", (t) => {
    const base = lines(REVIEW, LS);
    assert.equal(run(t, base, lines(REVIEW, { ...LS, meta: { thrash: { x: 1 } } }), ["--delta", "34"]).status, 0);
    assert.equal(run(t, base, lines(REVIEW, { ...LS, meta: { foo: 1 } }), ["--delta", "34"]).status, 1);
    assert.equal(run(t, base, lines(REVIEW, { ...LS, iterations: 2, meta: { thrash: null } }), ["--delta", "34"]).status, 1);
    assert.equal(run(t, base, lines(REVIEW, { ...LS, meta: { thrash: { x: 1 } } }), ["--delta", "35"]).status, 1);
  });

  test("35: meta.rotation:null is envelope; a non-null rotation, a reviewer key, an extra mock call are not", (t) => {
    const base = lines(REVIEW, LS);
    assert.equal(run(t, base, lines(REVIEW, { ...LS, meta: { rotation: null } }), ["--delta", "35"]).status, 0);
    assert.equal(run(t, base, lines(REVIEW, { ...LS, meta: { rotation: { seed: 7, order: ["a"], rounds: [] } } }), ["--delta", "35"]).status, 1);
    assert.equal(run(t, base, lines({ ...REVIEW, reviewer: "anthropic" }, { ...LS, meta: { rotation: null } }), ["--delta", "35"]).status, 1);
    assert.equal(run(t, base, lines(REVIEW, { ...LS, meta: { rotation: null } }), ["--delta", "35"],
      { head: { calls: { mocks: { claude: 2 }, probes: {}, stub: {} } } }).status, 1);
  });

  test("36: one added setup line on a detecting run is envelope; two lines, an extra change, a stdout change are not", (t) => {
    const a = synthCapture("B");
    const hint = "ℹ No provider inventory yet: run `adversarial-review setup` to record one.\n";
    const go = (headOver, baseOver = {}) => { const [b, h] = pair(t, baseOver, headOver); return compare(b, h, "--delta", "36"); };
    assert.equal(go({ stderr: hint + a.stderr }).status, 0);
    assert.equal(go({ stderr: hint + hint + a.stderr }).status, 1);
    assert.equal(go({ stderr: hint + a.stderr.replace("Target", "Targ") }).status, 1);
    assert.equal(go({ stderr: hint + a.stderr, stdout: "{}\n" }).status, 1);
    // not a detecting run: --prompt-only (exempt from argv) and a declared preResolution.
    assert.equal(go({ argv: ["--prompt-only"], stderr: hint + a.stderr }, { argv: ["--prompt-only"] }).status, 1);
    assert.equal(go({ stderr: hint + a.stderr, preResolution: "usage error" }, { preResolution: "usage error" }).status, 1);
  });

  test("37: any difference on an untagged row fails; a HEAD manifest listing 37 exits 2 before comparing", (t) => {
    let [base, head] = pair(t, {}, { stderr: "changed\n" });
    assert.equal(compare(base, head, "--delta", "37").status, 1);
    [base, head] = pair(t, {}, { stderr: "changed\n" }, { head: { manifests: manifestWith([37]) } });
    for (const args of [["--delta", "37"], ["--delta", "8"], []]) {
      const r = compare(base, head, ...args);
      assert.equal(r.status, 2, r.out);
      assert.match(r.stderr, /synth\.json.*SYN-1.*37/);
    }
    [base, head] = pair(t, {}, {}, { head: { manifests: manifestWith([8]) } });
    assert.equal(compare(base, head, "--delta", "37").status, 0);
  });

  test("tagged rows under --delta 35: allowed only when BASE lists it, HEAD consumed it and landed it", (t) => {
    const diff = { stdout: "anything at all\n", stderr: "different\n" };
    const go = (opts) => { const [b, h] = pair(t, {}, diff, opts); return compare(b, h, "--delta", "35"); };
    assert.equal(go({ base: { manifests: manifestWith([35]) }, head: { manifests: manifestWith([]), landed: [35] } }).status, 0);
    assert.equal(go({ base: { manifests: manifestWith([]) }, head: { manifests: manifestWith([]), landed: [35] } }).status, 1);
    assert.equal(go({ base: { manifests: manifestWith([35]) }, head: { manifests: manifestWith([]), landed: [] } }).status, 1);
    assert.equal(go({ base: { manifests: manifestWith([35]) }, head: { manifests: manifestWith([35]), landed: [35] } }).status, 2);
  });
});

describe("AP5 event alignment and gated --allow", { skip: SKIP }, () => {
  const ev = (...e) => e.map((x) => JSON.stringify(x)).join("\n") + "\n";
  const LS = { type: "loop_summary", iterations: 1 };
  test("an inserted progress event is exactly one INSERTED finding", (t) => {
    const [base, head] = pair(t, { stdout: ev({ type: "review", i: 1 }, LS) }, { stdout: ev({ type: "review", i: 1 }, { type: "progress", p: 1 }, LS) });
    const r = compare(base, head);
    assert.equal(r.status, 1);
    const findings = r.stdout.split("\n").filter((l) => /^\s*(INSERTED|REMOVED|DIFF)\b/.test(l));
    assert.deepEqual(findings.map((l) => l.trim()), ["INSERTED progress#1"]);
  });
  test("--allow needs --allow-reason, echoes ALLOWED, and is refused on a row tagged for --delta", (t) => {
    let [base, head] = pair(t, {}, { code: 9 });
    assert.equal(compare(base, head, "--allow", "SYN-1").status, 2);
    const r = compare(base, head, "--allow", "SYN-1", "--allow-reason", "known flake");
    assert.equal(r.status, 0, r.out);
    assert.match(r.stdout, /^ALLOWED SYN-1: known flake$/m);
    [base, head] = pair(t, {}, { code: 9 }, { base: { manifests: manifestWith([8]) }, head: { manifests: manifestWith([]), landed: [8] } });
    assert.equal(compare(base, head, "--delta", "8", "--allow", "SYN-1", "--allow-reason", "r").status, 2);
  });
});

// ─── AC9 capture-level determinism: SMOKE-LOOP and SMOKE-PROMPTONLY ──────────

const LOOP_FILES = { "code.js": "export const x = 1;\n", "util.js": "export const y = 1;\n" };
const LOOP_ARGV = ["--loop", "--loop-unsafe", "--json", "--provider", "anthropic", "--loop-fixer", "codex"];

// One independent SMOKE-LOOP run: its own context, repo, stub and capture tree.
// The fixer edits util.js, a file clean before the fix, so 2.11.1 already
// reports it in filesModified (a content change to an already-modified file is
// reported as [] in 2.11.1, which delta 39 would change).
async function smokeLoopRun(t, captureDir) {
  const ctx = makeContext(t);
  const repo = makeRepo({ ctx, files: LOOP_FILES });
  const stub = await ctx.stub();
  stub.enqueue("anthropic", anthropicReply(FLAG), anthropicReply(APPROVE));
  ctx.mock("codex", { responses: [{ writeFiles: { "util.js": "export const y = 2; // fixed\n" } }] });
  const run = await runCli(LOOP_ARGV, { ctx, cwd: repo.dir, env: providerEnv(stub, "anthropic"), capture: { dir: captureDir } });
  return { run, ctx, repo, stub };
}

function captureTree(ctx) {
  return ctx.track(fs.mkdtempSync(path.join(tmpBase(), "parity-cap-")));
}

smoke.row("SMOKE-LOOP", "working-tree --loop, anthropic stub reviewer FLAG then APPROVE, codex fixer", async (t) => {
  const holder = makeContext(t);
  const [treeA, treeB] = [captureTree(holder), captureTree(holder)];
  const a = await smokeLoopRun(t, treeA);
  const b = await smokeLoopRun(t, treeB);
  const { run, ctx, repo, stub } = a;
  assertExit(run, 0);
  assert.deepEqual(run.events.map((e) => e.type),
    ["loop_start", "review", "stash_created", "fix", "review", "review_result", "loop_end", "loop_summary"]);
  const stash = run.events.find((e) => e.type === "stash_created");
  assert.match(stash.stashName, /^adversarial-review-loop-\d+-iter0$/);
  assert.equal(run.events.find((e) => e.type === "loop_start").constraintMode, "advisory");
  assert.deepEqual(run.events.find((e) => e.type === "fix").filesModified, ["util.js"]);
  assert.deepEqual(run.events.at(-1), {
    type: "loop_summary", providers: ["anthropic"], iterations: 1, verdict: "approve",
    exitReason: "clean", survivingCount: 0, acceptedCount: 0
  });
  assertCallCount(run, "stub:anthropic", 2);
  assertCallCount(run, "codex", 1);
  assert.deepEqual(ctx.records("codex")[0].argv, ["exec", "--ephemeral", "--ignore-rules", "-"]);
  assert.match(ctx.records("codex")[0].stdin, /<<<UNTRUSTED:FINDING_1:[A-Za-z0-9_-]{12}>>>/);
  stub.assertNoUnexpected();
  assertGitState(gitState(repo.dir), { branch: "main", stashList: "", statusPorcelain: " M code.js\n M util.js\n" });
  assertExit(b.run, 0);
  // Two independent runs compare equal after normalization...
  const same = compare(treeA, treeB);
  assert.equal(same.status, 0, same.out);
  // ...and differ with n3 and n4 disabled (the stash timestamp and fence nonces are per run).
  const raw = compare(treeA, treeB, "--no-normalize", "n3,n4");
  assert.equal(raw.status, 1, raw.out);
  assert.match(raw.stdout, /SMOKE-LOOP/);
  // n7: the fix-prompt FINDING_<i> fence nonce is per run too (AP7 sweep rule).
  const noN7 = compare(treeA, treeB, "--no-normalize", "n7");
  assert.equal(noN7.status, 1, noN7.out);
  assert.match(noN7.stdout, /SMOKE-LOOP#1 fields: prompts/);
});

smoke.row("SMOKE-PROMPTONLY", "--prompt-only on a one-line diff prints the fenced payload", async (t) => {
  const holder = makeContext(t);
  const [treeA, treeB] = [captureTree(holder), captureTree(holder)];
  const runs = [];
  for (const tree of [treeA, treeB]) {
    const ctx = makeContext(t);
    const repo = makeRepo({ ctx });
    runs.push(await runCli(["--prompt-only"], { ctx, cwd: repo.dir, capture: { dir: tree } }));
  }
  const [run] = runs;
  assertExit(run, 0);
  assertStderrExact(run, "");
  assertNoProviderCalls(run);
  assert.ok(isReviewPrompt(run.stdout));
  assert.match(run.stdout, /^Target: <<<UNTRUSTED:TARGET_LABEL:[A-Za-z0-9_-]{12}>>>$/m);
  assert.match(run.stdout, /<<<UNTRUSTED:REVIEW_INPUT:[A-Za-z0-9_-]{12}>>>/);
  assert.ok(run.stdout.includes("+export const x = 2; // changed"));
  assert.notEqual(runs[0].stdout, runs[1].stdout, "nonces differ run to run");
  const same = compare(treeA, treeB);
  assert.equal(same.status, 0, same.out);
  const raw = compare(treeA, treeB, "--no-normalize", "n3,n4");
  assert.equal(raw.status, 1, raw.out);
  assert.match(raw.stdout, /SMOKE-PROMPTONLY/);
});

// ─── AC6 / AP9 mutant support ────────────────────────────────────────────────

import { withMutant, checkMutants, collectMutants } from "./helpers/mutant.mjs";

// Registered mutants of this file (AP9 staleness check reads every
// test/parity/*.test.mjs `export const MUTANTS = [...]` literal).
export const MUTANTS = [
  {
    id: "AC6-SINGLE-MODE-EXIT",
    file: "bin/cli.js",
    find: '// Exit code conveys the derived verdict: 0 approve, 2 needs-attention.\n  process.exit(derived.verdict === "needs-attention" ? 2 : 0);',
    replace: "// mutant\n  process.exit(0);"
  }
];

async function needsAttentionRun(t, cliEntry) {
  const ctx = makeContext(t);
  const repo = makeRepo({ ctx });
  const stub = await ctx.stub();
  stub.enqueue("anthropic", anthropicReply(FLAG));
  const opts = { ctx, cwd: repo.dir, env: providerEnv(stub, "anthropic") };
  if (cliEntry) opts.cliEntry = cliEntry;
  return runCli(["--provider", "anthropic", "--json"], opts);
}

describe("AC6 / AP9 mutants", { skip: SKIP }, () => {
  test("a needs-attention single-API run exits 2 on the original and 0 on the mutant (which was loaded)", async (t) => {
    const original = await needsAttentionRun(t);
    assertExit(original, 2);
    let mutantDir;
    await withMutant(MUTANTS, async (cliEntry, info) => {
      mutantDir = info.dir;
      assert.notEqual(cliEntry, path.join(REPO_ROOT_FOR_TEST, "bin", "cli.js"));
      const mutated = await needsAttentionRun(t, cliEntry);
      assertExit(mutated, 0);
      assert.ok(fs.existsSync(path.join(info.dir, ".mutant-loaded-0")), "sentinel marker written");
    });
    assert.ok(!fs.existsSync(mutantDir), "mutant dir cleaned up");
  });

  test("withMutant throws when find is absent and when it matches twice", async () => {
    await assert.rejects(withMutant([{ file: "bin/cli.js", find: "this text is not in cli.js", replace: "" }], async () => {}), /stale mutant/);
    await assert.rejects(withMutant([{ file: "bin/cli.js", find: 'process.exit(derived.verdict === "needs-attention" ? 2 : 0);', replace: "" }], async () => {}), /ambiguous mutant.*2 times/);
  });

  test("a mutant of a file the CLI never imports throws 'mutant was not loaded'", async (t) => {
    const m = [{ file: "prompt-template-artifact.md", find: "ticket, plan, or declared set of rails/invariants", replace: "ticket" }];
    await assert.rejects(withMutant(m, async (cliEntry) => {
      const run = await needsAttentionRun(t, cliEntry);
      assertExit(run, 2);
    }), /mutant was not loaded/);
  });

  test("the original error wins when fn throws", async () => {
    await assert.rejects(withMutant(MUTANTS, async () => { throw new Error("boom from fn"); }), /boom from fn/);
  });

  test("staleness: every registered MUTANTS find occurs exactly once at HEAD; an injected stale one is named", () => {
    const all = collectMutants();
    assert.ok(all.some((m) => m.id === "AC6-SINGLE-MODE-EXIT" && m.source === "harness.test.mjs"), JSON.stringify(all.map((m) => m.id)));
    assert.deepEqual(checkMutants(all), []);
    const bad = checkMutants([...all, { id: "STALE-ONE", file: "bin/cli.js", find: "no longer in the file", replace: "" }]);
    assert.equal(bad.length, 1);
    assert.match(bad[0], /STALE-ONE/);
  });
});

// ─── AC18 / AC19 / AP6 network recorder ──────────────────────────────────────

import { spawn } from "node:child_process";
import {
  withFetchRecorder,
  readFetchLog,
  readNetLog,
  assertOnlyStubUrls,
  FETCH_RECORDER
} from "./helpers/harness.mjs";

function spawnAsync(cmd, args, { env }) {
  return new Promise((resolve, reject) => {
    const c = spawn(cmd, args, { env, stdio: ["ignore", "pipe", "pipe"] });
    let out = ""; let err = "";
    c.stdout.on("data", (d) => { out += d; });
    c.stderr.on("data", (d) => { err += d; });
    c.on("error", reject);
    c.on("close", (code) => resolve({ code, stdout: out, stderr: err }));
  });
}

describe("AC18 / AC19 / AP6 network recorder", { skip: SKIP }, () => {
  test("fetch-recorder.cjs run directly with PARITY_FETCH_LOG unset exits 0 silently", () => {
    const r = spawnSync(process.execPath, [FETCH_RECORDER], { env: { PATH: process.env.PATH }, encoding: "utf8" });
    assert.deepEqual([r.status, r.stdout, r.stderr], [0, "", ""]);
  });

  test("a CLI run against a second stub is recorded with that port and fails assertOnlyStubUrls", async (t) => {
    const ctx = makeContext(t);
    const repo = makeRepo({ ctx });
    const stub = await ctx.stub();
    const other = await ctx.stub();
    other.enqueue("anthropic", anthropicReply(APPROVE));
    const run = await runCli(["--provider", "anthropic", "--json"],
      withFetchRecorder({ ctx, cwd: repo.dir, env: providerEnv(other, "anthropic") }));
    assertExit(run, 0);
    assert.deepEqual(readFetchLog(run), [`http://127.0.0.1:${other.port}/anthropic/v1/messages`]);
    assert.throws(() => assertOnlyStubUrls(run, stub), new RegExp(`127\\.0\\.0\\.1:${other.port}/anthropic/v1/messages`));
    assertOnlyStubUrls(run, other);
  });

  test("the recorder sees a request the stub answers 418", async (t) => {
    const ctx = makeContext(t);
    const repo = makeRepo({ ctx });
    const stub = await ctx.stub();
    const run = await runCli(["--provider", "anthropic", "--json"],
      withFetchRecorder({ ctx, cwd: repo.dir, env: providerEnv(stub, "anthropic") }));
    assertExit(run, 1);
    assert.equal(stub.unexpected.length, 1);
    assert.deepEqual(readNetLog(run), [{ api: "fetch", url: `http://127.0.0.1:${stub.port}/anthropic/v1/messages` }]);
  });

  const HTTPS_SCRIPT = (port) => `
    const http = require("http"); const https = require("https");
    const req = https.request({ protocol: "http:", agent: new http.Agent(), host: "127.0.0.1", port: ${port},
      path: "/anthropic/v1/messages", method: "POST", headers: { "content-type": "application/json" } },
      (res) => { res.resume(); res.on("end", () => process.exit(0)); });
    req.on("error", (e) => { console.error(e); process.exit(1); });
    req.end("{}");`;

  test("(b) https.request from a child script is recorded with api https.request", async (t) => {
    const ctx = makeContext(t);
    const other = await ctx.stub();
    other.enqueue("anthropic", anthropicReply(APPROVE));
    const log = path.join(ctx.dir, "net.ndjson");
    const r = await spawnAsync(process.execPath, ["--require", FETCH_RECORDER, "-e", HTTPS_SCRIPT(other.port)],
      { env: { PATH: process.env.PATH, PARITY_FETCH_LOG: log } });
    assert.equal(r.code, 0, r.stderr);
    const run = { netLogPath: log, stubTraffic: { [other.port]: other.requests.length + other.unexpected.length } };
    assert.deepEqual(readNetLog(run), [{ api: "https.request", url: `http://127.0.0.1:${other.port}/anthropic/v1/messages` }]);
    assertOnlyStubUrls(run, other);
  });

  test("(c) with the http hook disabled the consistency check fails instead of passing vacuously", async (t) => {
    const ctx = makeContext(t);
    const other = await ctx.stub();
    other.enqueue("anthropic", anthropicReply(APPROVE));
    const log = path.join(ctx.dir, "net.ndjson");
    const r = await spawnAsync(process.execPath, ["--require", FETCH_RECORDER, "-e", HTTPS_SCRIPT(other.port)],
      { env: { PATH: process.env.PATH, PARITY_FETCH_LOG: log, PARITY_NET_HOOK_DISABLE: "http" } });
    assert.equal(r.code, 0, r.stderr);
    const run = { netLogPath: log, stubTraffic: { [other.port]: other.requests.length + other.unexpected.length } };
    assert.deepEqual(readNetLog(run), []);
    assert.throws(() => assertOnlyStubUrls(run, other), /network recorder missed traffic/);
  });
});
