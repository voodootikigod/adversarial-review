// Parity DELTA REGISTRY (T50 item 9a). Pure data plus pure checks; no
// import-time side effects. This is the single authoritative list every parity
// row tags against (futureDeltas) and capture-compare reads (envelopes, fields).
//
// Ownership: T50 owns ids 1-40 (ROADMAP "Intended deltas" v59, decisions J8 and
// A11, and the delta 39/40 amendments). A new delta (41 and up) is added only by
// a P0-approved amendment that edits DELTAS and MAX_DELTA_ID together.
//
// LANDED_DELTAS: the ticket that lands delta d adds d here in its landing
// commit (one line). It is EMPTY at T50.
//
// `fields` (AP3): the compared capture fields a delta may change on a tagged
// row. A landing ticket may NARROW its own delta's fields, never widen them.
// `envelope`: null, or one of the kinds capture-compare implements
// ("added-event-key", "added-stderr-line"); any other kind makes it exit 2.

export const MAX_DELTA_ID = 40;

export const ALL_FIELDS = Object.freeze(["argv", "code", "stdout", "stderr", "gitState", "calls", "prompts", "requests"]);

function d(id, title, step, tickets, { taggable = true, envelope = null, fields = ALL_FIELDS } = {}) {
  return Object.freeze({
    id,
    title,
    step,
    tickets: Object.freeze([...tickets]),
    taggable,
    envelope: envelope ? Object.freeze({ ...envelope }) : null,
    fields: Object.freeze([...fields])
  });
}

export const DELTAS = Object.freeze([
  d(1, "independence enforced fail-closed", "3", ["T80", "T81", "T82", "T83", "T84", "T85", "T86"], { fields: ["argv", "stderr"] }),
  d(2, "default timeouts split and --timeout validated", "2a", ["T60"]),
  d(4, "fuzzy no-progress matching", "4", ["T90"]),
  d(5, "untracked bytes count toward --max-bytes", "2a", ["T61"]),
  d(6, "injection category", "2a", ["T62"]),
  d(8, "emitted JSON gains meta, config never written except by setup", "3", ["T83", "T87"], { fields: ["stdout", "prompts", "requests"] }),
  d(9, "working-tree payload is one combined diff", "6", ["T106"], { fields: ["stdout", "prompts", "requests"] }),
  d(12, "concurrent API calls", "4", ["T91", "T92", "T95"]),
  d(14, "schema text omitted for native structured output", "6", ["T105"], { fields: ["prompts", "requests"] }),
  d(15, "redacted verify payload and verify secret re-scan", "5", ["T93", "T94"], { fields: ["requests", "prompts", "stdout", "stderr"] }),
  d(16, "output-sink redaction", "2a", ["T63", "T65", "T66"]),
  d(17, "full-prompt secret scan", "2a", ["T64"], { fields: ["stderr", "code", "stdout"] }),
  d(18, "--loop requires --loop-accept-rollback-limits", "2b", ["T70"]),
  d(19, "quorum shortfall exits 1 unless --allow-degraded-quorum", "3", ["T85", "T86", "T87"]),
  d(21, "loop_summary validated:false", "2b", ["T75"]),
  d(22, "gateway model precedence", "3", ["T81", "T84"]),
  d(23, "Cursor builder family unknown unless declared", "3", ["T81", "T84"]),
  d(24, "review-error loop terminal events", "2b", ["T76"]),
  d(25, "working-tree loop refused with untracked files", "2b", ["T71"]),
  d(26, "fix redaction covers exploit_scenario", "2b", ["T72"]),
  d(28, "--model with any --providers stays a usage error", "0/3", ["T52", "T82"], { taggable: false }),
  d(29, "artifact wording in verify prompt", "2b", ["T73"]),
  d(30, "--loop with --input is a usage error", "2b", ["T74"]),
  d(31, "prompt schema omits $schema/$id/$comment", "6", ["T105"], { fields: ["prompts", "requests"] }),
  d(32, "quorum/providers validation tightened", "3", ["T82", "T85"]),
  d(33, "one budget per CLI unit of work", "4", ["T91"]),
  d(34, "loop thrash exit", "4", ["T96"], {
    envelope: { kind: "added-event-key", event: "loop_summary", key: "meta.thrash", value: "any" }
  }),
  d(35, "seeded reviewer rotation", "4", ["T116", "T97"], {
    envelope: { kind: "added-event-key", event: "loop_summary", key: "meta.rotation", value: null }
  }),
  d(36, "setup command and provider inventory", "3", ["T98", "T115"], {
    envelope: { kind: "added-stderr-line", maxLines: 1, contains: "adversarial-review setup", detectingOnly: true }
  }),
  d(37, "optional decision provider (shadow)", "6", ["T99"], { taggable: false }),
  d(38, "agy over-limit prompts via stdin", "6", ["T117"], { taggable: false }),
  d(39, "loop filesModified reports every content change", "2b", ["T118"], { fields: ["stdout", "stderr"] }),
  d(40, "wt rollback preserves the staged/unstaged split", "2b", ["T119"], { fields: ["stderr", "gitState"] })
]);

export const WITHDRAWN_DELTAS = Object.freeze([3, 7, 10, 11, 13, 20, 27]);

export const LANDED_DELTAS = Object.freeze([]);

export const ENVELOPE_KINDS = Object.freeze(["added-event-key", "added-stderr-line"]);

export function deltaById(id, deltas = DELTAS) {
  return deltas.find((x) => x.id === id) ?? null;
}

// Contiguity: DELTAS ids and WITHDRAWN_DELTAS are disjoint and their union is
// exactly 1..max. Returns a list of human-readable violations (empty = ok).
export function checkContiguity({ deltas = DELTAS, withdrawn = WITHDRAWN_DELTAS, max = MAX_DELTA_ID } = {}) {
  const out = [];
  const ids = deltas.map((x) => x.id);
  const seen = new Map();
  for (const id of ids) seen.set(id, (seen.get(id) ?? 0) + 1);
  for (const [id, n] of seen) if (n > 1) out.push(`delta ${id} listed ${n} times in DELTAS`);
  for (const id of withdrawn) if (seen.has(id)) out.push(`delta ${id} is in both DELTAS and WITHDRAWN_DELTAS`);
  const union = new Set([...ids, ...withdrawn]);
  for (let i = 1; i <= max; i++) if (!union.has(i)) out.push(`delta ${i} is missing from both DELTAS and WITHDRAWN_DELTAS`);
  for (const id of union) {
    if (!Number.isInteger(id) || id < 1 || id > max) out.push(`delta ${id} is outside 1..${max}`);
  }
  return out;
}
