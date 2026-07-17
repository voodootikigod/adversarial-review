import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { selectProviders, underSatisfiedNotice, resolveProviderToken, builderFamily, GATEWAY_FAMILY_MODELS } from "../src/llm.js";
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
    delete process.env.AI_GATEWAY_API_KEY;
    delete process.env.VERCEL_OIDC_TOKEN;
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
  const { perProvider, failures } = await runMultiProviderReview(providers, "THE PROMPT", { passes: 1 }, stubReview);

  assert.equal(calls.length, 2, "each provider invoked exactly once");
  assert.deepEqual(calls.map((c) => c.id).sort(), ["gemini", "gpt"]);
  assert.deepEqual(calls.map((c) => c.prompt), ["THE PROMPT", "THE PROMPT"], "same prompt to each");
  assert.deepEqual(perProvider.map((p) => p.provider).sort(), ["gemini", "gpt"]);
  assert.equal(failures.length, 0);
});

test("#1: a single provider failure is recorded and the rest proceed (degrade-and-proceed)", async () => {
  const stubReview = async (config) => {
    if (config.id === "gpt") throw new Error("transient 500");
    return approveResult();
  };
  const providers = [
    { id: "gpt", family: "openai", config: { id: "gpt", provider: "cli", cliCmd: "codex" } },
    { id: "gemini", family: "gemini", config: { id: "gemini", provider: "cli", cliCmd: "agy" } }
  ];
  const { perProvider, failures } = await runMultiProviderReview(providers, "P", { passes: 1 }, stubReview);
  assert.deepEqual(perProvider.map((p) => p.provider), ["gemini"], "surviving provider proceeds");
  assert.equal(failures.length, 1);
  assert.equal(failures[0].provider, "gpt");
  assert.match(failures[0].error, /transient 500/);
});

test("AC8: --providers auto selects >=2 distinct families, excluding the builder's family", () => {
  // Builder = Claude (anthropic). codex(openai), agy(gemini), claude(anthropic) all installed.
  withMockBins(["codex", "agy", "claude"], { CLAUDE_CODE: "1" }, () => {
    const sel = selectProviders({ providers: "auto" });
    const fams = new Set(sel.providers.map((p) => p.family));
    assert.ok(fams.size >= 2, `expected >=2 distinct families, got ${[...fams]}`);
    assert.ok(!fams.has("anthropic"), "must exclude the builder's family (anthropic)");
    assert.equal(sel.underSatisfied, false, "auto with >=2 families is satisfied");
  });
});

test("builderFamily detects Antigravity (Gemini) from either env var alone", () => {
  const oldEnv = { ...process.env };
  for (const key of ["CLAUDECODE", "CLAUDE_CODE", "TERM_PROGRAM", "ANTIGRAVITY_AGENT", "ANTIGRAVITY_CONVERSATION_ID"]) {
    delete process.env[key];
  }
  try {
    process.env.ANTIGRAVITY_AGENT = "1";
    assert.equal(builderFamily(), "gemini", "ANTIGRAVITY_AGENT alone → gemini");
    delete process.env.ANTIGRAVITY_AGENT;
    process.env.ANTIGRAVITY_CONVERSATION_ID = "abc";
    assert.equal(builderFamily(), "gemini", "ANTIGRAVITY_CONVERSATION_ID alone → gemini");
  } finally {
    process.env = oldEnv;
  }
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

test("#1(r6): a CLI-name token (codex) resolves to the local CLI, never the family API", () => {
  // OPENAI_API_KEY is set, but naming the local `codex` binary must NOT exfiltrate
  // the diff to the OpenAI API — it resolves to the on-host CLI.
  withMockBins(["codex"], { OPENAI_API_KEY: "sk-present" }, () => {
    const sel = selectProviders({ providers: ["codex"] });
    assert.equal(sel.providers.length, 1);
    assert.equal(sel.providers[0].config.provider, "cli", "codex must resolve to the local CLI");
    assert.equal(sel.providers[0].config.cliCmd, "codex");
  });
});

test("#1(r6): a CLI-name token is unreachable (not API) when its binary is absent", () => {
  withMockBins([], { OPENAI_API_KEY: "sk-present" }, () => {
    const sel = selectProviders({ providers: ["codex"] });
    assert.equal(sel.providers.length, 0, "no codex binary → unreachable, must not fall back to OpenAI API");
  });
});

test("#3/#5: a generic LLM_API_KEY does NOT force API mode for a family without its own key", () => {
  // agy installed, no GEMINI_API_KEY, but a generic LLM_API_KEY is set (an OpenAI
  // key, say). gemini must resolve to the CLI fallback, not the API with a wrong key.
  withMockBins(["agy"], { LLM_API_KEY: "sk-not-gemini" }, () => {
    const sel = selectProviders({ providers: ["gemini"] });
    assert.equal(sel.providers.length, 1);
    assert.equal(sel.providers[0].config.provider, "cli", "no family key → CLI fallback, not API");
    assert.equal(sel.providers[0].config.cliCmd, "agy");
  });
});

test("#3/#5: a family with neither its own key nor a CLI is unreachable despite LLM_API_KEY", () => {
  withMockBins([], { LLM_API_KEY: "sk-generic" }, () => {
    const r = resolveProviderToken("gemini", { apiKey: "sk-generic" });
    assert.equal(r.config, null, "generic key must not fake reachability");
  });
});

test("explicit --api-key is honored for a single requested family (single-provider parity)", () => {
  // No env key, no CLI, but an explicit --api-key for the one requested family.
  withMockBins([], {}, () => {
    const sel = selectProviders({ providers: ["openai"], apiKey: "sk-explicit" });
    assert.equal(sel.providers.length, 1);
    assert.equal(sel.providers[0].config.provider, "openai", "explicit --api-key selects the API");
    assert.equal(sel.providers[0].config.apiKey, "sk-explicit");
  });
});

test("explicit --api-key is NOT applied across multiple requested families", () => {
  // Two families, one --api-key: it must not be blindly used for both.
  withMockBins([], {}, () => {
    const sel = selectProviders({ providers: ["openai", "gemini"], apiKey: "sk-explicit" });
    assert.equal(sel.providers.length, 0, "ambiguous --api-key must not fake reachability for either family");
    assert.equal(sel.underSatisfied, true);
  });
});

test("#7: synonym tokens for one family are deduped (no quorum inflation)", () => {
  withMockBins(["codex"], {}, () => {
    const sel = selectProviders({ providers: ["gpt", "openai"] });
    assert.equal(sel.providers.length, 1, "gpt and openai collapse to one openai-family provider");
    assert.equal(sel.providers[0].family, "openai");
    assert.equal(sel.requestedCount, 1, "requested diversity is 1 distinct family");
    assert.equal(sel.underSatisfied, false);
  });
});

test("AI Gateway one-key multi-family: only AI_GATEWAY_API_KEY resolves gpt,anthropic,gemini via vercel", () => {
  // Use family tokens (anthropic), not CLI-only token `claude` — naming `claude`
  // resolves to the on-host CLI only and never upgrades to API/Gateway.
  withMockBins([], { AI_GATEWAY_API_KEY: "gw" }, () => {
    const sel = selectProviders({ providers: ["gpt", "anthropic", "gemini"] });
    assert.equal(sel.providers.length, 3);
    const fams = new Set(sel.providers.map((p) => p.family));
    assert.deepEqual([...fams].sort(), ["anthropic", "gemini", "openai"]);
    for (const p of sel.providers) {
      assert.equal(p.config.provider, "vercel", `${p.family} must use Gateway transport`);
      assert.equal(p.config.apiBase, "https://ai-gateway.vercel.sh/v1");
      assert.equal(p.config.model, GATEWAY_FAMILY_MODELS[p.family]);
    }
    assert.equal(sel.underSatisfied, false);

    const auto = selectProviders({ providers: "auto" });
    assert.ok(auto.providers.length >= 2, "auto with Gateway-only must reach >=2 families");
    assert.ok(auto.providers.every((p) => p.config.provider === "vercel"));
  });
});

test("AI Gateway: native OPENAI_API_KEY wins over AI_GATEWAY_API_KEY for openai family", () => {
  withMockBins([], { OPENAI_API_KEY: "sk-native", AI_GATEWAY_API_KEY: "gw" }, () => {
    const sel = selectProviders({ providers: ["openai"] });
    assert.equal(sel.providers.length, 1);
    assert.equal(sel.providers[0].config.provider, "openai");
    assert.match(sel.providers[0].config.apiBase, /api\.openai\.com/);
    assert.equal(sel.providers[0].config.apiKey, "sk-native");
  });
});

test("--providers auto never treats cursor/agent as a diversity family", () => {
  withMockBins(["agent", "codex", "agy", "claude"], { CLAUDE_CODE: "1" }, () => {
    const sel = selectProviders({ providers: "auto" });
    const ids = sel.providers.map((p) => p.id);
    assert.ok(!ids.includes("cursor") && !ids.includes("agent"), `auto must not select cursor/agent, got ${ids}`);
    for (const p of sel.providers) {
      assert.notEqual(p.config.cliCmd, "agent");
    }
  });
});

test("empty OPENAI_API_KEY does not block Gateway fallback", () => {
  withMockBins([], { OPENAI_API_KEY: "", AI_GATEWAY_API_KEY: "gw" }, () => {
    const r = resolveProviderToken("openai");
    assert.ok(r.config, "empty native key must be treated as unset");
    assert.equal(r.config.provider, "vercel");
  });
});

test("cursor token without agent CLI is unreachable (does not throw on IDE cursor binary)", () => {
  // Simulate PATH with a decoy `cursor` binary (like the Cursor IDE shim) but no agent.
  const oldEnv = { ...process.env };
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "adv-cursor-decoy-"));
  try {
    const decoy = path.join(tempDir, process.platform === "win32" ? "cursor.cmd" : "cursor");
    fs.writeFileSync(decoy, "#!/bin/sh\necho ide");
    if (process.platform !== "win32") fs.chmodSync(decoy, 0o755);
    delete process.env.OPENAI_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.GEMINI_API_KEY;
    delete process.env.AI_GATEWAY_API_KEY;
    delete process.env.VERCEL_OIDC_TOKEN;
    delete process.env.LLM_API_KEY;
    process.env.PATH = tempDir;
    const r = resolveProviderToken("cursor");
    assert.equal(r.config, null, "cursor without agent must be unreachable, not throw");
    const sel = selectProviders({ providers: ["gpt", "cursor"] });
    assert.equal(sel.providers.length, 0);
    assert.equal(sel.underSatisfied, true);
  } finally {
    process.env = oldEnv;
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
  }
});
