import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import { deepMerge, applyProfilePatch } from "../src/profile/update.js";
import { validateProfile, type Profile } from "../src/profile/schema.js";

/**
 * The `update_profile` core is PURE — deep-merge a patch onto a base profile and validate. Tested here
 * on the committed example as the base; the disk write (updateLocalProfile) is the IO seam and isn't
 * exercised here. The key guarantees: nested merge, array/scalar replace, and that the no-live-numbers
 * guard rejects a patch carrying a live metric so it can never be written.
 */

const exampleText = readFileSync(new URL("../profile.example.yaml", import.meta.url), "utf8");
const base = (): Profile => parseYaml(exampleText) as Profile;

// --- deepMerge --------------------------------------------------------------

test("deepMerge merges nested objects, replaces arrays and scalars, skips undefined", () => {
  assert.deepEqual(
    deepMerge({ a: { x: 1, y: 2 }, b: 3 }, { a: { y: 20, z: 30 } }),
    { a: { x: 1, y: 20, z: 30 }, b: 3 },
    "nested objects merge key-by-key",
  );
  assert.deepEqual(deepMerge({ list: [1, 2, 3] }, { list: [9] }), { list: [9] }, "arrays replace, not concat");
  assert.deepEqual(deepMerge({ a: 1 }, { a: 2 }), { a: 2 }, "scalars replace");
  assert.deepEqual(deepMerge({ a: 1, b: 2 }, { b: undefined }), { a: 1, b: 2 }, "undefined doesn't blank a field");
  assert.deepEqual(deepMerge({ a: { x: 1 } }, { a: 5 }), { a: 5 }, "type mismatch replaces");
});

// --- applyProfilePatch ------------------------------------------------------

test("applyProfilePatch merges a nested patch onto the base and validates", () => {
  const next = applyProfilePatch(base(), { health: { medication: { dose_day: "sunday", gi_trough_days: ["tuesday", "wednesday"] } } });
  assert.equal(next.health?.medication?.dose_day, "sunday");
  assert.deepEqual(next.health?.medication?.gi_trough_days, ["tuesday", "wednesday"]);
  assert.doesNotThrow(() => validateProfile(next));
});

test("applyProfilePatch replaces the races array wholesale", () => {
  const next = applyProfilePatch(base(), {
    identity: { name: "Pat", sex: "female", date_of_birth: "1992-04-04", units: "metric", timezone: "Europe/London" },
    races: [{ name: "Local 10k", date: "2026-08-01", priority: "B", distance: "other" }],
  });
  assert.equal(next.races?.length, 1);
  assert.equal(next.races?.[0].name, "Local 10k");
});

test("applyProfilePatch REJECTS a patch carrying a live number (the guard)", () => {
  // A numeric weight anywhere trips assertNoLiveNumbers — it must never reach disk.
  assert.throws(() => applyProfilePatch(base(), { fuelling: { drink_weight_kg: 0.5 } }), /live number|weight|FTP/i);
  assert.throws(() => applyProfilePatch(base(), { biomechanics: { ftp_w: 250 } }), /live number|FTP|ftp/i);
});

test("applyProfilePatch allows a numeric HEIGHT (stable anthropometry, not a live number)", () => {
  const next = applyProfilePatch(base(), { identity: { height_cm: 178 } });
  assert.equal(next.identity?.height_cm, 178);
});

test("applyProfilePatch throws on a non-object patch", () => {
  assert.throws(() => applyProfilePatch(base(), "not an object"), /must be an object/);
  assert.throws(() => applyProfilePatch(base(), [1, 2, 3]), /must be an object/);
});
