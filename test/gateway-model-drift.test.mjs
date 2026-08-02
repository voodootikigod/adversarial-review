import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { GATEWAY_FAMILY_MODELS, buildOpencodeConfig, newOpencodeAgentName } from "../src/llm.js";

const SRC_DIR = fileURLToPath(new URL("../src/", import.meta.url));
const CATALOG_URL = "https://ai-gateway.vercel.sh/v1/models";

// The catalog endpoint is public and unauthenticated, which is the only reason
// drift detection can live in the test suite at all. It still must never make
// `npm test` require a network: a REMOVED pin is a real failure, an unreachable
// Vercel is not. Every non-answer collapses to "skip", never "fail".
const CATALOG_TIMEOUT_MS = 15_000;

/**
 * Fetch the gateway catalog. Returns { ok: true, ids: Set<string> } or
 * { ok: false, reason } — never throws, so callers decide skip-vs-fail.
 */
async function fetchCatalog(fetchImpl = globalThis.fetch, { timeoutMs = CATALOG_TIMEOUT_MS } = {}) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetchImpl(CATALOG_URL, { signal: ac.signal });
    if (!res || res.ok === false || (typeof res.status === "number" && res.status !== 200)) {
      return { ok: false, reason: `catalog returned status ${res?.status ?? "unknown"}` };
    }
    const body = await res.json();
    const ids = (body?.data ?? []).map((m) => m?.id).filter((id) => typeof id === "string");
    if (ids.length === 0) return { ok: false, reason: "catalog returned no usable model ids" };
    return { ok: true, ids: new Set(ids) };
  } catch (err) {
    return { ok: false, reason: `catalog unreachable: ${err?.message || err}` };
  } finally {
    clearTimeout(timer);
  }
}

/** Split "creator/series<version><suffix>" — e.g. "google/gemini-2.5-pro". */
function parseModelId(id) {
  const slash = id.indexOf("/");
  if (slash < 0) return null;
  const creator = id.slice(0, slash);
  const rest = id.slice(slash + 1);
  const m = rest.match(/^(.*?)(\d+(?:\.\d+)?)(.*)$/);
  if (!m) return null;
  return { creator, series: m[1], version: Number(m[2]), suffix: m[3] };
}

/**
 * Catalog ids that are strictly newer than `pin` in the SAME series and tier.
 *
 * Matching on suffix as well as series is what keeps this quiet enough to be
 * worth reading: for `google/gemini-2.5-pro` it rejects `gemini-3-flash` (weaker
 * tier) and `gemini-3.1-pro-preview` (a preview), which are exactly the two
 * candidates a human already considered and declined. The tradeoff is that a
 * rename of the suffix (a hypothetical `openai/gpt-6` vs the pinned
 * `gpt-5.6-sol`) goes unreported — deliberately conservative, since a noisy
 * diagnostic gets ignored and a quiet one gets read.
 */
function newerInSeries(pin, ids) {
  const p = parseModelId(pin);
  if (!p) return [];
  const out = [];
  for (const id of ids) {
    const c = parseModelId(id);
    if (!c) continue;
    if (c.creator !== p.creator || c.series !== p.series || c.suffix !== p.suffix) continue;
    if (c.version > p.version) out.push(id);
  }
  return out.sort();
}

// --- AC1: single source of truth -------------------------------------------

test("no gateway model id literal exists in src/ outside GATEWAY_FAMILY_MODELS", () => {
  const literal = /"(?:openai|anthropic|google)\/[^"]+"/g;
  const offenders = [];

  for (const entry of fs.readdirSync(SRC_DIR, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".js")) continue;
    const file = path.join(SRC_DIR, entry.name);
    const lines = fs.readFileSync(file, "utf8").split("\n");

    // Bound the map so its own entries are exempt and everything else is not.
    let start = -1;
    let end = -1;
    lines.forEach((line, i) => {
      if (start < 0 && line.includes("export const GATEWAY_FAMILY_MODELS")) start = i;
      else if (start >= 0 && end < 0 && line.trimStart().startsWith("};")) end = i;
    });

    lines.forEach((line, i) => {
      if (!literal.test(line)) return;
      literal.lastIndex = 0;
      const insideMap = start >= 0 && i > start && i < end;
      if (!insideMap) offenders.push(`${entry.name}:${i + 1}: ${line.trim()}`);
    });
  }

  assert.deepEqual(
    offenders,
    [],
    `Gateway model ids must be written only in GATEWAY_FAMILY_MODELS.\n${offenders.join("\n")}`
  );
});

// --- AC4: the pins themselves ----------------------------------------------

test("gateway pins hold the intended models", () => {
  assert.deepEqual(GATEWAY_FAMILY_MODELS, {
    openai: "openai/gpt-5.6-sol",
    anthropic: "anthropic/claude-sonnet-5",
    gemini: "google/gemini-2.5-pro"
  });
});

test("the gemini pin carries the comment explaining why it lags", () => {
  const src = fs.readFileSync(path.join(SRC_DIR, "llm.js"), "utf8");
  const map = src.slice(src.indexOf("export const GATEWAY_FAMILY_MODELS"));
  const block = map.slice(0, map.indexOf("};"));
  assert.match(block, /gemini-3\.1-pro-preview/, "gemini pin must record which 3.x pro was rejected and why");
});

// --- AC7: every failure mode skips rather than fails -------------------------

const stubResponse = (over = {}) => ({ ok: true, status: 200, json: async () => ({ data: [] }), ...over });

test("a throwing fetch is reported as skippable, not a failure", async () => {
  const r = await fetchCatalog(async () => { throw new Error("ENOTFOUND"); });
  assert.equal(r.ok, false);
  assert.match(r.reason, /unreachable/);
});

test("a non-200 status is reported as skippable, not a failure", async () => {
  const r = await fetchCatalog(async () => stubResponse({ ok: false, status: 503 }));
  assert.equal(r.ok, false);
  assert.match(r.reason, /status 503/);
});

test("malformed JSON is reported as skippable, not a failure", async () => {
  const r = await fetchCatalog(async () => stubResponse({ json: async () => { throw new SyntaxError("Unexpected token"); } }));
  assert.equal(r.ok, false);
  assert.match(r.reason, /unreachable/);
});

test("an empty catalog is reported as skippable, not a failure", async () => {
  const r = await fetchCatalog(async () => stubResponse({ json: async () => ({ data: [] }) }));
  assert.equal(r.ok, false);
  assert.match(r.reason, /no usable model ids/);
});

test("a well-formed catalog resolves to an id set", async () => {
  const r = await fetchCatalog(async () =>
    stubResponse({ json: async () => ({ data: [{ id: "openai/gpt-5.6-sol" }, { id: "x/y-1" }] }) })
  );
  assert.equal(r.ok, true);
  assert.ok(r.ids.has("openai/gpt-5.6-sol"));
});

// --- AC6: a removed pin is a real failure -----------------------------------

test("a pin missing from the catalog is detected", async () => {
  const r = await fetchCatalog(async () =>
    stubResponse({
      json: async () => ({ data: [{ id: "openai/gpt-5.6-sol" }, { id: "anthropic/claude-sonnet-5" }] })
    })
  );
  assert.equal(r.ok, true);
  const missing = Object.values(GATEWAY_FAMILY_MODELS).filter((m) => !r.ids.has(m));
  assert.deepEqual(missing, ["google/gemini-2.5-pro"], "a removed pin must be surfaced");
});

// --- AC8: the newer-model diagnostic ----------------------------------------

test("a newer same-series, same-tier model is reported", () => {
  const ids = new Set(["google/gemini-2.5-pro", "google/gemini-3.5-pro", "google/gemini-4-pro"]);
  assert.deepEqual(newerInSeries("google/gemini-2.5-pro", ids), ["google/gemini-3.5-pro", "google/gemini-4-pro"]);
});

test("a weaker tier or a preview is NOT reported as newer", () => {
  // The two candidates a human already declined for the gemini pin.
  const ids = new Set(["google/gemini-2.5-pro", "google/gemini-3-flash", "google/gemini-3.1-pro-preview"]);
  assert.deepEqual(newerInSeries("google/gemini-2.5-pro", ids), []);
});

test("a different tier in the same family is NOT reported as newer", () => {
  const ids = new Set(["anthropic/claude-sonnet-5", "anthropic/claude-opus-5", "anthropic/claude-sonnet-4.6"]);
  assert.deepEqual(newerInSeries("anthropic/claude-sonnet-5", ids), []);
});

// --- Live catalog: skips when offline ---------------------------------------

test("every gateway pin still exists in the live catalog", async (t) => {
  const r = await fetchCatalog();
  if (!r.ok) {
    t.skip(`gateway catalog unavailable — ${r.reason}`);
    return;
  }
  const missing = Object.entries(GATEWAY_FAMILY_MODELS)
    .filter(([, id]) => !r.ids.has(id))
    .map(([family, id]) => `${family}: ${id}`);
  assert.deepEqual(missing, [], `pinned gateway model(s) no longer served: ${missing.join(", ")}`);

  // Non-failing drift diagnostic.
  for (const [family, id] of Object.entries(GATEWAY_FAMILY_MODELS)) {
    const newer = newerInSeries(id, r.ids);
    if (newer.length) t.diagnostic(`${family}: pinned ${id}; newer available: ${newer.join(", ")}`);
  }
});

// --- opencode permission schema drift ----------------------------------------
//
// Same class of defect this file already guards for gateway model pins, and the
// same fix. OPENCODE_PERMISSIONS is hand-maintained, and a key opencode adds later
// is not merely missing — an unset permission defaults to "ask", which blocks a
// headless review until the watchdog ceiling. That surfaces as an opaque ETIMEDOUT
// with nothing pointing at a stale permission map, so the drift has to be caught
// here. Skips offline, exactly like the model-catalog check above.

const OPENCODE_SCHEMA_URL = "https://opencode.ai/config.json";

async function fetchOpencodePermissionKeys(fetchImpl = globalThis.fetch, { timeoutMs = CATALOG_TIMEOUT_MS } = {}) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetchImpl(OPENCODE_SCHEMA_URL, { signal: ac.signal });
    if (!res || res.ok === false || (typeof res.status === "number" && res.status !== 200)) {
      return { ok: false, reason: `schema returned status ${res?.status ?? "unknown"}` };
    }
    const body = await res.json();
    const defs = body?.$defs ?? body?.definitions ?? {};
    // PermissionConfig is `anyOf: [ <action string>, { properties: {...} } ]`.
    const variant = (defs.PermissionConfig?.anyOf ?? []).find((v) => v?.properties);
    const keys = Object.keys(variant?.properties ?? {});
    if (keys.length === 0) return { ok: false, reason: "no PermissionConfig properties in schema" };
    return { ok: true, keys: new Set(keys) };
  } catch (err) {
    return { ok: false, reason: `schema unreachable: ${err?.message || err}` };
  } finally {
    clearTimeout(timer);
  }
}

test("the opencode permission map still covers every key the schema defines", async (t) => {
  const r = await fetchOpencodePermissionKeys();
  if (!r.ok) {
    t.skip(`opencode schema unavailable — ${r.reason}`);
    return;
  }
  const name = newOpencodeAgentName();
  const configured = buildOpencodeConfig(name).agent[name].permission;

  const missing = [...r.keys].filter((k) => !(k in configured));
  assert.deepEqual(
    missing,
    [],
    `unset opencode permissions default to "ask" and hang a headless review — ` +
      `add these to OPENCODE_PERMISSIONS with an explicit allow/deny: ${missing.join(", ")}`
  );

  // A key we set that the schema no longer defines is dead weight, not a hazard —
  // report it without failing, mirroring the newer-model diagnostic above.
  const stale = Object.keys(configured).filter((k) => !r.keys.has(k));
  if (stale.length) t.diagnostic(`permissions set but no longer in the schema: ${stale.join(", ")}`);
});

test("nothing write-shaped is allowed in the read-only opencode agent", () => {
  const name = newOpencodeAgentName();
  const { permission, tools } = buildOpencodeConfig(name).agent[name];
  const allowed = Object.entries(permission).filter(([, v]) => v === "allow").map(([k]) => k);
  assert.deepEqual(allowed.sort(), ["glob", "grep", "list", "read"], "only inspection may be allowed");
  for (const k of allowed) {
    assert.doesNotMatch(k, /write|edit|patch|exec|bash/i, `"${k}" is not an inspection capability`);
  }
  // `tools` is defense in depth, so it must agree: nothing mutating enabled.
  for (const k of ["write", "edit", "patch", "bash", "task"]) assert.equal(tools[k], false);
});
