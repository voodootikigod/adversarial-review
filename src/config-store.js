import fs from "fs";
import os from "os";
import path from "path";
import { isInsideTrustRoot } from "./trust-root.js";

// Persistent, GLOBAL-ONLY configuration for adversarial-review.
//
// Location: $ADVERSARIAL_REVIEW_CONFIG, else $XDG_CONFIG_HOME/adversarial-review/config.json,
// else ~/.config/adversarial-review/config.json.
//
// SECURITY / TRUST BOUNDARY: the config governs which provider/model reviews an
// untrusted diff, so a repo-controlled config could redirect the reviewer or
// weaken the critic. This module refuses config the repository could supply: a
// RELATIVE $ADVERSARIAL_REVIEW_CONFIG / $XDG_CONFIG_HOME is ignored (it would
// resolve against the repo cwd), and an ABSOLUTE path CONTAINED IN the working
// tree — including via symlink — is ignored (T23). The resolution cache also
// stores and re-verifies each CLI's canonical absolute path, and refuses a
// repo-local executable, via the shared trusted resolver in llm.js (T22).
//
// Shape:
//   {
//     "version": 1,
//     "defaults": { "models": { "<provider|cli:<cmd>>": "<model id>" } },
//     "cache":    { "<builder-context>": { provider, cliCmd, family, model,
//                                          gatewayPreferModel, resolvedAt } }
//   }
//
// `defaults.models` are USER-authored model pins (read as a default layer).
// `cache` is the auto-written resolution cache that lets repeated runs skip the
// PATH-probing detection ladder — always cheaply re-validated before reuse.

const CONFIG_VERSION = 1;

export function emptyConfig() {
  return { version: CONFIG_VERSION, defaults: { models: {} }, cache: {} };
}

export function defaultConfigPath({ env = process.env, homedir = os.homedir, root } = {}) {
  // The config governs which provider/model reviews an untrusted diff, so a path
  // the reviewed repository could supply is refused. A path is only honored when
  // it is ABSOLUTE and NOT contained in the git worktree under review (the trust
  // root — NOT merely cwd, so a repo-root config is refused even from a nested
  // package; symlinks are resolved).
  const honored = (v) => v && path.isAbsolute(v) && !isInsideTrustRoot(v, { root });

  // An EXPLICIT ADVERSARIAL_REVIEW_CONFIG is the operator's deliberate choice: use
  // it iff valid, otherwise DISABLE config (return null) rather than silently
  // reading/writing the personal ~/.config they did not ask for. Returning null
  // makes load/save/mutate no-ops.
  const override = env.ADVERSARIAL_REVIEW_CONFIG && env.ADVERSARIAL_REVIEW_CONFIG.trim();
  if (override) return honored(override) ? override : null;

  // No explicit path: fall back to $XDG_CONFIG_HOME (if honored) then ~/.config.
  const xdgRaw = env.XDG_CONFIG_HOME && env.XDG_CONFIG_HOME.trim();
  const xdg = honored(xdgRaw) ? xdgRaw : null;
  const base = xdg || path.join(homedir(), ".config");
  return path.join(base, "adversarial-review", "config.json");
}

// Read + parse the config. A missing, unreadable, or corrupt file yields an empty
// config rather than an error — a broken config must never fail the review gate.
//
// A file that EXISTS but is unreadable/unparseable is flagged `malformed: true` so
// the caller can (a) warn and (b) suppress the auto-detect write that would
// otherwise silently overwrite the user's hand-authored model pins. A genuinely
// missing file is NOT malformed — first-run auto-write is expected there.
// Note: JSON.parse is strict — comments and trailing commas make a file malformed.
export function loadConfig(configPath = defaultConfigPath()) {
  if (configPath == null) return emptyConfig(); // config disabled (rejected explicit path)
  let raw;
  try {
    raw = fs.readFileSync(configPath, "utf8");
  } catch (err) {
    if (err && err.code === "ENOENT") return emptyConfig();
    // Exists but unreadable (permissions, etc.): don't risk clobbering it.
    return { ...emptyConfig(), malformed: true };
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ...emptyConfig(), malformed: true };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ...emptyConfig(), malformed: true };
  }
  const defaults = parsed.defaults && typeof parsed.defaults === "object" && !Array.isArray(parsed.defaults)
    ? parsed.defaults
    : {};
  const models = defaults.models && typeof defaults.models === "object" && !Array.isArray(defaults.models)
    ? { ...defaults.models }
    : {};
  const cache = parsed.cache && typeof parsed.cache === "object" && !Array.isArray(parsed.cache)
    ? { ...parsed.cache }
    : {};
  const version = Number.isInteger(parsed.version) ? parsed.version : CONFIG_VERSION;
  // Preserve every field we don't recognize (top-level AND inside defaults) so a
  // future/newer config version is not silently truncated on the next auto-write.
  // A file written by a NEWER binary is treated as read-only — we must not
  // overwrite settings we don't understand (rollback safety).
  const cfg = {
    ...parsed,
    version,
    defaults: { ...defaults, models },
    cache
  };
  if (version > CONFIG_VERSION) cfg.readOnly = true;
  return cfg;
}

// Immutable update: return a NEW config with `entry` recorded under cache[key].
// Preserves unknown top-level and defaults fields (forward-compat) and keeps the
// file's existing version rather than forcing a downgrade. Runtime-only markers
// (malformed/readOnly) are stripped so they are never persisted.
export function withResolution(config, key, entry) {
  const base = config ?? emptyConfig();
  const { malformed, readOnly, ...rest } = base;
  return {
    ...rest,
    version: rest.version ?? CONFIG_VERSION,
    defaults: { ...(rest.defaults ?? {}), models: { ...(rest.defaults?.models ?? {}) } },
    cache: { ...(rest.cache ?? {}), [key]: entry }
  };
}

// Immutable delete: return a NEW config with cache[key] removed. Preserves
// unknown fields and version; strips runtime-only markers. Used to invalidate a
// stale cache-sourced resolution so the next run re-detects.
export function withoutCacheEntry(config, key) {
  const base = config ?? emptyConfig();
  const { malformed, readOnly, ...rest } = base;
  const cache = { ...(rest.cache ?? {}) };
  delete cache[key];
  return {
    ...rest,
    version: rest.version ?? CONFIG_VERSION,
    defaults: { ...(rest.defaults ?? {}), models: { ...(rest.defaults?.models ?? {}) } },
    cache
  };
}

// Best-effort write with restrictive perms and an atomic rename. A write failure
// (read-only home, full disk, EPERM) must never fail the review — returns a
// boolean so the caller can proceed regardless.
export function saveConfig(config, configPath = defaultConfigPath()) {
  if (configPath == null) return false; // config disabled
  try {
    fs.mkdirSync(path.dirname(configPath), { recursive: true, mode: 0o700 });
    const tmp = `${configPath}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(config, null, 2) + "\n", { mode: 0o600 });
    fs.renameSync(tmp, configPath);
    return true;
  } catch {
    return false;
  }
}

// Synchronous sleep without a busy-loop (blocks this thread up to `ms`).
function sleepSync(ms) {
  try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch { /* no SAB → skip */ }
}

// Concurrency-safe mutate: acquire a best-effort lock, REREAD the current on-disk
// config, apply `mutator(current)` (return null to skip the write), then save and
// release. Reread-under-lock is what prevents a long review's stale in-memory
// snapshot from clobbering a concurrent run's cache entry or a user's model-pin
// edit (F5). A malformed or newer-version (read-only) on-disk file is never
// overwritten. Best-effort: if the lock can't be taken, it still reread-merges
// (a much smaller race window than writing a pre-review snapshot).
export function mutateConfigFile(mutator, configPath = defaultConfigPath()) {
  if (configPath == null) return null; // config disabled
  const lockPath = `${configPath}.lock`;
  try { fs.mkdirSync(path.dirname(configPath), { recursive: true, mode: 0o700 }); } catch { /* ignore */ }
  let fd = null;
  for (let i = 0; i < 50; i++) {
    try { fd = fs.openSync(lockPath, "wx"); break; }
    catch (e) {
      if (e.code !== "EEXIST") break; // unexpected → proceed lock-less (still reread-merges)
      try {
        // Steal a stale lock a crashed run left behind (~10s old).
        if (Date.now() - fs.statSync(lockPath).mtimeMs > 10_000) { fs.unlinkSync(lockPath); continue; }
      } catch { /* lock vanished — retry acquire */ }
      sleepSync(20);
    }
  }
  try {
    const current = loadConfig(configPath);
    if (current.malformed || current.readOnly) return null;
    const next = mutator(current);
    if (next) saveConfig(next, configPath);
    return next;
  } finally {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch { /* ignore */ }
      try { fs.unlinkSync(lockPath); } catch { /* ignore */ }
    }
  }
}

// True when the persisted cache entry already matches the freshly resolved entry
// (ignoring the volatile resolvedAt timestamp) — lets the caller skip a needless
// rewrite (and the churny timestamp update) when nothing actually changed.
export function resolutionMatches(prev, next) {
  if (!prev || !next) return false;
  return (
    prev.provider === next.provider &&
    (prev.cliCmd ?? null) === (next.cliCmd ?? null) &&
    // cliPath is part of the resolution IDENTITY (cachedResolutionUsable rejects a
    // mismatch): a pathless legacy entry or a CLI that moved must count as CHANGED
    // so the write happens, otherwise the stale entry is never refreshed.
    (prev.cliPath ?? null) === (next.cliPath ?? null) &&
    (prev.model ?? null) === (next.model ?? null) &&
    (prev.gatewayPreferModel ?? null) === (next.gatewayPreferModel ?? null)
  );
}
