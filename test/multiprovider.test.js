import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { selectProviders, underSatisfiedNotice } from "../src/llm.js";
import { runMultiProviderReview } from "../src/review.js";

function approveResult() {
  return { verdict: "approve", summary: "ok", coverage: { files_examined: [], files_skipped: [] }, findings: [], next_steps: [] };
}

// Build a temp dir of mock executables and isolate PATH to it.
function withMockBins(cmds, env, fn) {
  const oldEnv = { ...process.env };
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "adv-mp-"));
  try {
    for (const cmd of cmds) {
      const binName = process.platform === "win32" ? `${cmd}.cmd` : cmd;
      const binPath = path.join(tempDir, binName);
      fs.writeFileSync(binPath, "#!/bin/sh\necho 1.0.0");
      if (process.platform !== "win32") fs.chmodSync(binPath, 0o755);
    }
    delete process.env.OPENAI_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.GEMINI_API_KEY;
    delete process.env.LLM_API_KEY;
    delete process.env.CLAUDECODE;
    delete process.env.CLAUDE_CODE;
    delete process.env.TERM_PROGRAM;
    Object.assign(process.env, env || {});
    process.env.PATH = tempDir;
    return fn();
  } finally {
    process.env = oldEnv;
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
  }
}

test("AC4: runMultiProviderReview invokes each provider once with the same prompt", async () => {
  const calls = [];
  const stubReview = async (config, prompt) => {
    calls.push({ id: config.id, prompt });
    return approveResult();
  };
  const providers = [
    { id: "gpt", family: "openai", config: { id: "gpt", provider: "cli", cliCmd: "codex" } },
    { id: "gemini", family: "gemini", config: { id: "gemini", provider: "cli", cliCmd: "agy" } }
  ];
  const per = await runMultiProviderReview(providers, "THE PROMPT", { passes: 1 }, stubReview);

  assert.equal(calls.length, 2, "each provider invoked exactly once");
  assert.deepEqual(calls.map((c) => c.id).sort(), ["gemini", "gpt"]);
  assert.deepEqual(calls.map((c) => c.prompt), ["THE PROMPT", "THE PROMPT"], "same prompt to each");
  assert.deepEqual(per.map((p) => p.provider).sort(), ["gemini", "gpt"]);
});

test("AC8: --providers auto selects >=2 distinct families, excluding the builder's family", () => {
  // Builder = Claude (anthropic). codex(openai), agy(gemini), claude(anthropic) all installed.
  withMockBins(["codex", "agy", "claude"], { CLAUDE_CODE: "1" }, () => {
    const sel = selectProviders({ providers: "auto" });
    const fams = new Set(sel.providers.map((p) => p.family));
    assert.ok(fams.size >= 2, `expected >=2 distinct families, got ${[...fams]}`);
    assert.ok(!fams.has("anthropic"), "must exclude the builder's family (anthropic)");
  });
});

test("AC8: --providers auto excludes the builder family in Cursor too", () => {
  // Builder = Cursor (openai family). codex(openai), agy(gemini), claude(anthropic) installed.
  withMockBins(["codex", "agy", "claude"], { TERM_PROGRAM: "cursor" }, () => {
    const sel = selectProviders({ providers: "auto" });
    const fams = new Set(sel.providers.map((p) => p.family));
    assert.ok(fams.size >= 2, `expected >=2 distinct families, got ${[...fams]}`);
    assert.ok(!fams.has("openai"), "must exclude the builder's family (openai) in Cursor");
  });
});

test("AC7: under-satisfied when fewer providers are reachable than requested", () => {
  // Request gpt+gemini, but only agy (gemini family) is installed and no API keys.
  withMockBins(["agy"], {}, () => {
    const sel = selectProviders({ providers: ["gpt", "gemini"] });
    assert.equal(sel.providers.length, 1, "only the reachable provider runs");
    assert.equal(sel.providers[0].family, "gemini");
    assert.equal(sel.underSatisfied, true);
    assert.equal(sel.requestedCount, 2);
    assert.equal(sel.reachableCount, 1);

    const notice = underSatisfiedNotice(sel);
    assert.ok(notice, "a loud under-satisfied notice must be produced");
    assert.match(notice, /1 of 2/);
  });
});

test("explicit --providers resolves family tokens to concrete providers (API key wins over CLI)", () => {
  withMockBins(["agy"], { GEMINI_API_KEY: "k" }, () => {
    const sel = selectProviders({ providers: ["gemini"] });
    assert.equal(sel.providers.length, 1);
    assert.equal(sel.providers[0].family, "gemini");
    assert.equal(sel.providers[0].config.provider, "gemini", "API key present → API provider, not CLI");
    assert.equal(sel.underSatisfied, false);
  });
});
