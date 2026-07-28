import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  emptyConfig,
  defaultConfigPath,
  loadConfig,
  saveConfig,
  withResolution,
  withoutCacheEntry,
  mutateConfigFile,
  resolutionMatches
} from "../src/config-store.js";

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "adv-cfg-"));
}

test("defaultConfigPath honors ADVERSARIAL_REVIEW_CONFIG override", () => {
  const p = defaultConfigPath({ env: { ADVERSARIAL_REVIEW_CONFIG: "/custom/cfg.json" } });
  assert.equal(p, "/custom/cfg.json");
});

test("defaultConfigPath honors XDG_CONFIG_HOME", () => {
  const p = defaultConfigPath({ env: { XDG_CONFIG_HOME: "/xdg" }, homedir: () => "/home/u" });
  assert.equal(p, path.join("/xdg", "adversarial-review", "config.json"));
});

test("defaultConfigPath falls back to ~/.config", () => {
  const p = defaultConfigPath({ env: {}, homedir: () => "/home/u" });
  assert.equal(p, path.join("/home/u", ".config", "adversarial-review", "config.json"));
});

test("defaultConfigPath DISABLES config for a relative explicit override (not a silent home fallback)", () => {
  const p = defaultConfigPath({ env: { ADVERSARIAL_REVIEW_CONFIG: ".adversarial-review.json" }, homedir: () => "/home/u" });
  assert.equal(p, null);
});

test("defaultConfigPath IGNORES a relative XDG_CONFIG_HOME", () => {
  const p = defaultConfigPath({ env: { XDG_CONFIG_HOME: "relative/xdg" }, homedir: () => "/home/u" });
  assert.equal(p, path.join("/home/u", ".config", "adversarial-review", "config.json"));
});

test("defaultConfigPath DISABLES config for an explicit path inside the working tree (T23 repo-containment)", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "t23-cwd-"));
  try {
    const inside = path.join(cwd, "adv-config.json");
    const p = defaultConfigPath({ env: { ADVERSARIAL_REVIEW_CONFIG: inside }, homedir: () => "/home/u", root: cwd });
    assert.equal(p, null);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("defaultConfigPath honors an absolute path OUTSIDE the working tree", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "t23-cwd-"));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "t23-out-"));
  try {
    const cfg = path.join(outside, "config.json");
    const p = defaultConfigPath({ env: { ADVERSARIAL_REVIEW_CONFIG: cfg }, homedir: () => "/home/u", root: cwd });
    assert.equal(p, cfg);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test("defaultConfigPath rejects a symlink whose target is inside the working tree", { skip: process.platform === "win32" ? "Symlinks require Administrator privileges on Windows" : false }, () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "t23-cwd-"));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "t23-out-"));
  try {
    const target = path.join(cwd, "real-config.json");
    fs.writeFileSync(target, "{}");
    const link = path.join(outside, "sneaky.json");
    fs.symlinkSync(target, link);
    const p = defaultConfigPath({ env: { ADVERSARIAL_REVIEW_CONFIG: link }, homedir: () => "/home/u", root: cwd });
    assert.equal(p, null);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test("loadConfig returns empty config when the file is missing", () => {
  const cfg = loadConfig(path.join(tmpDir(), "does-not-exist.json"));
  assert.deepEqual(cfg, emptyConfig());
});

test("loadConfig flags a corrupt file as malformed (never throws)", () => {
  const dir = tmpDir();
  const p = path.join(dir, "config.json");
  fs.writeFileSync(p, "{ this is not json");
  const cfg = loadConfig(p);
  assert.equal(cfg.malformed, true);
  assert.deepEqual(cfg.defaults.models, {});
});

test("loadConfig flags a file with JSON comments as malformed (strict JSON, no JSONC)", () => {
  const dir = tmpDir();
  const p = path.join(dir, "config.json");
  fs.writeFileSync(p, '{\n  // a comment\n  "defaults": { "models": {} }\n}');
  assert.equal(loadConfig(p).malformed, true);
});

test("loadConfig flags a non-object top-level (array/JSON scalar) as malformed", () => {
  const dir = tmpDir();
  const p = path.join(dir, "config.json");
  fs.writeFileSync(p, "[1,2,3]");
  assert.equal(loadConfig(p).malformed, true);
});

test("loadConfig does NOT mark a genuinely missing file as malformed (first-run auto-write is fine)", () => {
  const cfg = loadConfig(path.join(tmpDir(), "nope.json"));
  assert.equal(cfg.malformed, undefined);
  assert.deepEqual(cfg, emptyConfig());
});

test("saveConfig then loadConfig round-trips models and cache", () => {
  const p = path.join(tmpDir(), "config.json");
  const cfg = {
    version: 1,
    defaults: { models: { gemini: "gemini-3.1-pro-high" } },
    cache: { default: { provider: "cli", cliCmd: "agy", family: "gemini" } }
  };
  assert.equal(saveConfig(cfg, p), true);
  const loaded = loadConfig(p);
  assert.equal(loaded.defaults.models.gemini, "gemini-3.1-pro-high");
  assert.equal(loaded.cache.default.cliCmd, "agy");
});

test("saveConfig creates parent directories", () => {
  const p = path.join(tmpDir(), "nested", "deep", "config.json");
  assert.equal(saveConfig(emptyConfig(), p), true);
  assert.ok(fs.existsSync(p));
});

test("saveConfig writes the file with owner-only permissions", () => {
  const p = path.join(tmpDir(), "config.json");
  saveConfig(emptyConfig(), p);
  const mode = fs.statSync(p).mode & 0o777;
  const expectedMode = process.platform === "win32" ? 0o666 : 0o600;
  assert.equal(mode, expectedMode);
});

test("saveConfig returns false instead of throwing on an unwritable path", () => {
  // A path whose parent is a file, not a directory, cannot be created.
  const dir = tmpDir();
  const filePath = path.join(dir, "afile");
  fs.writeFileSync(filePath, "x");
  const p = path.join(filePath, "config.json");
  assert.equal(saveConfig(emptyConfig(), p), false);
});

test("withResolution immutably records an entry under the given key", () => {
  const base = emptyConfig();
  const next = withResolution(base, "claudecode", { provider: "gemini", family: "gemini" });
  assert.equal(next.cache.claudecode.provider, "gemini");
  // original untouched
  assert.deepEqual(base.cache, {});
});

test("withResolution preserves existing models and other cache keys", () => {
  const base = {
    version: 1,
    defaults: { models: { openai: "gpt-5" } },
    cache: { default: { provider: "anthropic", family: "anthropic" } }
  };
  const next = withResolution(base, "cursor", { provider: "openai", family: "openai" });
  assert.equal(next.defaults.models.openai, "gpt-5");
  assert.equal(next.cache.default.provider, "anthropic");
  assert.equal(next.cache.cursor.provider, "openai");
});

test("loadConfig preserves unknown fields (forward-compat: an older binary can't truncate them)", () => {
  const p = path.join(tmpDir(), "config.json");
  fs.writeFileSync(p, JSON.stringify({
    version: 1,
    defaults: { models: { gemini: "g" }, futureSetting: { a: 1 } },
    cache: {},
    unknownTopLevel: [1, 2, 3]
  }));
  const cfg = loadConfig(p);
  assert.deepEqual(cfg.unknownTopLevel, [1, 2, 3]);
  assert.deepEqual(cfg.defaults.futureSetting, { a: 1 });
  assert.equal(cfg.defaults.models.gemini, "g");
});

test("loadConfig marks a newer-version file read-only (rollback safety)", () => {
  const p = path.join(tmpDir(), "config.json");
  fs.writeFileSync(p, JSON.stringify({ version: 2, defaults: { models: {} }, cache: {}, v2only: "keep" }));
  const cfg = loadConfig(p);
  assert.equal(cfg.readOnly, true);
  assert.equal(cfg.v2only, "keep");
});

test("withResolution preserves unknown fields, keeps the existing version, strips runtime markers", () => {
  const base = {
    version: 2,
    malformed: false,
    readOnly: true,
    unknownTopLevel: { keep: 1 },
    defaults: { models: { openai: "gpt-5" }, futureSetting: 7 },
    cache: {}
  };
  const next = withResolution(base, "default", { provider: "gemini", family: "gemini" });
  assert.equal(next.version, 2);                       // not downgraded to 1
  assert.deepEqual(next.unknownTopLevel, { keep: 1 }); // unknown top-level preserved
  assert.equal(next.defaults.futureSetting, 7);        // unknown defaults preserved
  assert.equal(next.defaults.models.openai, "gpt-5");  // models preserved
  assert.equal(next.cache.default.provider, "gemini");
  assert.equal("readOnly" in next, false);             // runtime marker not persisted
  assert.equal("malformed" in next, false);
});

test("mutateConfigFile reread-merges: preserves a concurrent cache key and a user model pin (F5)", () => {
  const p = path.join(tmpDir(), "config.json");
  // Simulate the on-disk state a concurrent run + a user edit produced.
  saveConfig({ version: 1, defaults: { models: { gemini: "PINNED" } }, cache: { cursor: { provider: "openai" } } }, p);
  // This run records the 'default' context; it must merge, not clobber.
  mutateConfigFile((cur) => withResolution(cur, "default", { provider: "cli", cliCmd: "agy" }), p);
  const loaded = loadConfig(p);
  assert.equal(loaded.defaults.models.gemini, "PINNED", "user model pin preserved");
  assert.equal(loaded.cache.cursor.provider, "openai", "concurrent cache key preserved");
  assert.equal(loaded.cache.default.cliCmd, "agy", "this run's entry recorded");
});

test("mutateConfigFile refuses to overwrite a malformed on-disk config", () => {
  const p = path.join(tmpDir(), "config.json");
  fs.writeFileSync(p, "{ broken");
  const result = mutateConfigFile((cur) => withResolution(cur, "default", { provider: "openai" }), p);
  assert.equal(result, null);
  assert.equal(fs.readFileSync(p, "utf8"), "{ broken", "malformed file left untouched");
});

test("withoutCacheEntry removes one cache key and preserves everything else", () => {
  const base = {
    version: 1,
    unknownTop: 1,
    defaults: { models: { openai: "gpt-5" }, futureSetting: 2 },
    cache: { default: { provider: "cli", cliCmd: "agy" }, cursor: { provider: "openai" } }
  };
  const next = withoutCacheEntry(base, "default");
  assert.equal("default" in next.cache, false);
  assert.equal(next.cache.cursor.provider, "openai");
  assert.equal(next.defaults.models.openai, "gpt-5");
  assert.equal(next.defaults.futureSetting, 2);
  assert.equal(next.unknownTop, 1);
  // original untouched
  assert.ok(base.cache.default);
});

test("resolutionMatches ignores resolvedAt but compares the identity fields (incl. cliPath)", () => {
  const a = { provider: "cli", cliCmd: "agy", cliPath: "/usr/bin/agy", model: null, gatewayPreferModel: null, resolvedAt: "2026-01-01" };
  const b = { provider: "cli", cliCmd: "agy", cliPath: "/usr/bin/agy", model: null, gatewayPreferModel: null, resolvedAt: "2026-07-24" };
  assert.equal(resolutionMatches(a, b), true);
  assert.equal(resolutionMatches(a, { ...b, cliCmd: "claude" }), false);
  // A moved CLI or a pathless→pathed upgrade must count as CHANGED so the write happens.
  assert.equal(resolutionMatches(a, { ...b, cliPath: "/opt/bin/agy" }), false);
  assert.equal(resolutionMatches({ ...a, cliPath: null }, b), false);
  assert.equal(resolutionMatches(null, b), false);
});
