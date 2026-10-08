// Parity harness self-test (T50). Every helper the parity rows rely on is
// proved here to be able to FAIL, so a green row is evidence, not an accident.
import assert from "node:assert/strict";
import test, { describe } from "node:test";

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
