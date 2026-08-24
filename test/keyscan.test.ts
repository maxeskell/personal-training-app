import { test } from "node:test";
import assert from "node:assert/strict";
import { scanKeys, firstObjectArray, listCoverage } from "../src/util/keyScan.js";

/**
 * The field-hunt scanner behind `npm run probe` — the mechanical check for AIE's 2026-08 durability-for-
 * all-workouts update. It must find matching key NAMES wherever they nest, report types (never values),
 * count populated-vs-null coverage over a record list, and stay bounded on pathological payloads.
 * Fixtures mirror the real archived AIE field names (spec 08) so the hunt provably re-finds them.
 */

const DUR = [/durab/i, /decoupl/i, /drift/i];

test("scanKeys finds the real archived AIE durability field, nested under a list wrapper", () => {
  const sample = {
    activities: [
      { date: "2026-08-20", aerobic_durability_according_to_dfa_alpha1_running_power_in_percent: -4.2 },
      { date: "2026-08-22" },
    ],
  };
  const hits = scanKeys(sample, DUR);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].key, "aerobic_durability_according_to_dfa_alpha1_running_power_in_percent");
  assert.equal(hits[0].path, "activities[0].aerobic_durability_according_to_dfa_alpha1_running_power_in_percent");
  assert.equal(hits[0].type, "number");
});

test("scanKeys matches snake_case and camelCase name variants case-insensitively", () => {
  const hits = scanKeys({ power_is_from_hr: true, powerIsFromHr: false, unrelated: 1 }, [/power_?is_?from_?hr/i]);
  assert.deepEqual(hits.map((h) => h.key).sort(), ["powerIsFromHr", "power_is_from_hr"]);
});

test("scanKeys reports type only — null/undefined values surface as 'null'", () => {
  const hits = scanKeys({ durability: null, drift_pct: undefined, decoupling: { half: 3 } }, DUR);
  const byKey = Object.fromEntries(hits.map((h) => [h.key, h.type]));
  assert.equal(byKey.durability, "null");
  assert.equal(byKey.drift_pct, "null");
  assert.equal(byKey.decoupling, "object");
});

test("scanKeys respects the depth cap", () => {
  const deep = { a: { b: { c: { durability: 1 } } } };
  assert.equal(scanKeys(deep, DUR, { maxDepth: 2 }).length, 0);
  assert.equal(scanKeys(deep, DUR, { maxDepth: 8 }).length, 1);
});

test("scanKeys respects the hit cap so a 5-year list can't drown the summary", () => {
  const many = { items: Array.from({ length: 500 }, () => ({ durability: 1 })) };
  assert.equal(scanKeys(many, DUR, { maxHits: 40 }).length, 40);
});

test("scanKeys matches nothing on a payload without the keys (and never throws on primitives)", () => {
  assert.deepEqual(scanKeys({ pace: 275, hr: 141 }, DUR), []);
  assert.deepEqual(scanKeys("just a string", DUR), []);
  assert.deepEqual(scanKeys(null, DUR), []);
});

test("firstObjectArray unwraps a record list under an unknown wrapper key, breadth-first", () => {
  const wrapped = { meta: { count: 2 }, data: [{ id: 1 }, { id: 2 }] };
  assert.equal(firstObjectArray(wrapped)?.length, 2);
  const bare = [{ id: 1 }];
  assert.equal(firstObjectArray(bare)?.length, 1);
});

test("firstObjectArray ignores primitive arrays and returns null when no record list exists", () => {
  assert.equal(firstObjectArray({ tags: ["a", "b"], n: 3 }), null);
  assert.equal(firstObjectArray({ note: "none" }), null);
});

test("listCoverage counts only items where a matched key is POPULATED (present-but-null is not coverage)", () => {
  // Mirrors spec 08's sparsity measurement: durability blank on most rides pre-update.
  const items = [
    { aerobic_durability_according_to_dfa_alpha1_in_percent: -6 },
    { aerobic_durability_according_to_dfa_alpha1_in_percent: null },
    { pace: 300 },
  ];
  const cov = listCoverage(items, DUR);
  assert.equal(cov.total, 3);
  assert.equal(cov.withValue, 1);
  assert.deepEqual(cov.keys, ["aerobic_durability_according_to_dfa_alpha1_in_percent"]);
});

test("listCoverage reports the distinct candidate key names for the mapper", () => {
  const cov = listCoverage(
    [{ durability_percent: 2 }, { decoupling_pct: 4.1, durability_percent: null }],
    DUR,
  );
  assert.deepEqual(cov.keys, ["decoupling_pct", "durability_percent"]);
  assert.equal(cov.withValue, 2);
});
