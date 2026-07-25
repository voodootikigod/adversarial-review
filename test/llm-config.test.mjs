import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  configureLLM,
  builderContextKey,
  familyForResolution,
  cachedResolutionUsable,
  apiOutranksCliInContext,
  resolvedCliPath
} from "../src/llm.js";
import { loadConfig, saveConfig, withResolution } from "../src/config-store.js";

// Snapshot + clear every env var the detection ladder reads, run `fn`, restore.
const LLM_ENV = [
  "ANTHROPIC_API_KEY", "GEMINI_API_KEY", "OPENAI_API_KEY",
  "AI_GATEWAY_API_KEY", "VERCEL_OIDC_TOKEN", "LLM_API_KEY",
  "CLAUDECODE", "CLAUDE_CODE", "TERM_PROGRAM",
  "ANTIGRAVITY_AGENT", "ANTIGRAVITY_CONVERSATION_ID"
];

function withEnv(overrides, fn) {
  const saved = {};
  for (const k of LLM_ENV) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  for (const [k, v] of Object.entries(overrides)) process.env[k] = v;
  try {
    return fn();
  } finally {
    for (const k of LLM_ENV) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

test("builderContextKey reflects the builder environment", () => {
  assert.equal(builderContextKey({ CLAUDECODE: "1" }), "claudecode");
  assert.equal(builderContextKey({ TERM_PROGRAM: "cursor" }), "cursor");
  assert.equal(builderContextKey({ ANTIGRAVITY_AGENT: "1" }), "antigravity");
  assert.equal(builderContextKey({}), "default");
});

test("familyForResolution maps CLIs and API providers to diversity families", () => {
  assert.equal(familyForResolution("cli", "agy"), "gemini");
  assert.equal(familyForResolution("cli", "claude"), "anthropic");
  assert.equal(familyForResolution("cli", "codex"), "openai");
  assert.equal(familyForResolution("cli", "agent"), null);
  assert.equal(familyForResolution("anthropic", null), "anthropic");
  assert.equal(familyForResolution("vercel", null), null);
});

test("cachedResolutionUsable rejects an API resolution whose key is gone (staleness)", () => {
  withEnv({}, () => {
    assert.equal(cachedResolutionUsable({ provider: "anthropic", family: "anthropic" }), false);
  });
  withEnv({ ANTHROPIC_API_KEY: "sk-x" }, () => {
    assert.equal(cachedResolutionUsable({ provider: "anthropic", family: "anthropic" }), true);
  });
});

test("cachedResolutionUsable rejects a resolution in the builder's own family (diversity guard)", () => {
  // Inside Claude Code the builder family is anthropic — an anthropic cache entry
  // must not be reused even though the key is present.
  withEnv({ CLAUDECODE: "1", ANTHROPIC_API_KEY: "sk-x" }, () => {
    assert.equal(cachedResolutionUsable({ provider: "anthropic", family: "anthropic" }), false);
  });
});

test("cachedResolutionUsable recomputes family — a forged family field cannot bypass the guard", () => {
  // A stale/hand-edited entry claiming family:null on an anthropic provider must
  // still be rejected inside Claude Code: the guard recomputes family from provider.
  withEnv({ CLAUDECODE: "1", ANTHROPIC_API_KEY: "sk-x" }, () => {
    assert.equal(cachedResolutionUsable({ provider: "anthropic", family: null }), false);
    assert.equal(cachedResolutionUsable({ provider: "cli", cliCmd: "claude", family: "openai" }), false);
  });
});

test("configureLLM reuses a cached resolution over the default ladder", () => {
  // Ladder (default context) with gemini+openai keys would pick gemini first.
  // A cache pinning openai must win, proving the cache short-circuits the ladder.
  withEnv({ GEMINI_API_KEY: "g", OPENAI_API_KEY: "o" }, () => {
    const config = configureLLM({
      config: { cache: { default: { provider: "openai", family: "openai" } } }
    });
    assert.equal(config.provider, "openai");
  });
});

test("configureLLM falls back to the ladder when the cached resolution is stale", () => {
  // Cache pins anthropic, but no ANTHROPIC key exists → not usable → ladder picks gemini.
  withEnv({ GEMINI_API_KEY: "g" }, () => {
    const config = configureLLM({
      config: { cache: { default: { provider: "anthropic", family: "anthropic" } } }
    });
    assert.equal(config.provider, "gemini");
  });
});

test("configureLLM marks _fromCache on a cache hit, not on a fresh or explicit resolution", () => {
  withEnv({ GEMINI_API_KEY: "g", OPENAI_API_KEY: "o" }, () => {
    const hit = configureLLM({ config: { cache: { default: { provider: "openai", family: "openai" } } } });
    assert.equal(hit.provider, "openai");
    assert.equal(hit._fromCache, true);

    const fresh = configureLLM({});
    assert.equal(fresh._fromCache, false);

    const explicit = configureLLM({ provider: "openai" });
    assert.equal(explicit._fromCache, false);
  });
});

test("configureLLM attaches _autoResolution only when auto-detecting", () => {
  withEnv({ GEMINI_API_KEY: "g" }, () => {
    const auto = configureLLM({});
    assert.equal(auto._autoResolution.provider, "gemini");
    assert.equal(auto._autoResolution.family, "gemini");

    const explicit = configureLLM({ provider: "gemini" });
    assert.equal(explicit._autoResolution, undefined);
  });
});

test("configureLLM honors a config model pin below --model and above the hardcoded default", () => {
  withEnv({ OPENAI_API_KEY: "o" }, () => {
    // Config pin wins over the hardcoded gpt-5 default.
    const pinned = configureLLM({
      provider: "openai",
      config: { defaults: { models: { openai: "gpt-5-mini" } } }
    });
    assert.equal(pinned.model, "gpt-5-mini");

    // --model still wins over the config pin.
    const flagged = configureLLM({
      provider: "openai",
      model: "gpt-5-nano",
      config: { defaults: { models: { openai: "gpt-5-mini" } } }
    });
    assert.equal(flagged.model, "gpt-5-nano");
  });
});

test("apiOutranksCliInContext: ANTHROPIC does NOT outrank CLIs in Claude Code, but does by default", () => {
  assert.equal(apiOutranksCliInContext("claudecode", { env: { ANTHROPIC_API_KEY: "a" } }), false);
  assert.equal(apiOutranksCliInContext("claudecode", { env: { GEMINI_API_KEY: "g" } }), true);
  assert.equal(apiOutranksCliInContext("default", { env: { ANTHROPIC_API_KEY: "a" } }), true);
  assert.equal(apiOutranksCliInContext("cursor", { env: { ANTHROPIC_API_KEY: "a" } }), true);
  assert.equal(apiOutranksCliInContext("default", { env: {} }), false);
});

test("a cached CLI defers to a now-available API that outranks it (Finding A: no stale-CLI shadow)", () => {
  // default context: any API key outranks local CLIs. A cached cli:codex must not
  // be reused once an ANTHROPIC key appears — the ladder picks the API instead.
  withEnv({ ANTHROPIC_API_KEY: "a" }, () => {
    const config = configureLLM({
      config: { cache: { default: { provider: "cli", cliCmd: "codex", family: "openai" } } }
    });
    assert.equal(config.provider, "anthropic");
  });
});

test("a cached CLI is still reused when the present API does NOT outrank it (Claude Code + ANTHROPIC)", () => {
  // In Claude Code, a local CLI outranks the ANTHROPIC API — so an ANTHROPIC key
  // must NOT preempt a cached CLI (that would wrongly discard a valid resolution).
  // `node` stands in for the CLI binary so the reuse is deterministic in CI
  // (a real codex/agy need not be installed); the guard under test is
  // context+provider, not the specific executable.
  withEnv({ CLAUDECODE: "1", ANTHROPIC_API_KEY: "a" }, () => {
    const config = configureLLM({
      config: { cache: { claudecode: { provider: "cli", cliCmd: "node", cliPath: resolvedCliPath("node"), family: null } } }
    });
    assert.equal(config.provider, "cli");
    assert.equal(config.cliCmd, "node");
  });
});

test("cachedResolutionUsable requires the cached CLI to still resolve to its canonical path (Finding A: PATH-hijack defense)", () => {
  withEnv({}, () => {
    const good = { provider: "cli", cliCmd: "node", cliPath: resolvedCliPath("node"), family: null };
    assert.equal(cachedResolutionUsable(good), true);
    // Binary swapped / shadowed since caching → cached path no longer matches.
    assert.equal(cachedResolutionUsable({ ...good, cliPath: "/some/other/node" }), false);
    // No recorded identity (pre-hardening entry) → not reusable; force re-detect.
    assert.equal(cachedResolutionUsable({ provider: "cli", cliCmd: "node", family: null }), false);
    // A CLI that no longer resolves at all → not reusable.
    assert.equal(cachedResolutionUsable({ provider: "cli", cliCmd: "definitely-not-a-real-cli-xyz", cliPath: "/x/definitely-not-a-real-cli-xyz", family: null }), false);
  });
});

test("first run stores the resolution; second run reuses it instead of re-walking the ladder", () => {
  const p = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "adv-e2e-")), "config.json");

  // Run 1: only OpenAI reachable → ladder picks openai; persist as the CLI would.
  withEnv({ OPENAI_API_KEY: "o" }, () => {
    const run1 = configureLLM({ config: loadConfig(p) });
    assert.equal(run1.provider, "openai");
    const key = builderContextKey();
    saveConfig(withResolution(loadConfig(p), key, { ...run1._autoResolution, resolvedAt: "t" }), p);
  });

  // Run 2: Gemini is now ALSO reachable, so a fresh ladder walk would pick gemini
  // first. The cache pins openai (still reachable + diverse), so it must win —
  // proving the resolution was reused, not re-derived.
  withEnv({ OPENAI_API_KEY: "o", GEMINI_API_KEY: "g" }, () => {
    const run2 = configureLLM({ config: loadConfig(p) });
    assert.equal(run2.provider, "openai");
  });
});

test("configureLLM lets the diversity model choice outrank a config pin (gateway in builder IDE)", () => {
  // Inside Claude Code with only a gateway credential, the ladder picks vercel and
  // sets gatewayPreferModel to a NON-anthropic model. A config pin to an anthropic
  // gateway model must not reintroduce the builder's own family.
  withEnv({ CLAUDECODE: "1", AI_GATEWAY_API_KEY: "gw" }, () => {
    const config = configureLLM({
      config: { defaults: { models: { vercel: "anthropic/claude-sonnet-4.6" } } }
    });
    assert.equal(config.provider, "vercel");
    assert.equal(config.model, "openai/gpt-5");
  });
});
