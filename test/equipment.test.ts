import { test } from "node:test";
import assert from "node:assert/strict";
import { bikeRaceWeights, systemWeightKg } from "../src/profile/equipment.js";
import { assertNoLiveNumbers, type Profile } from "../src/profile/schema.js";

/**
 * Bike race weight is STABLE kit data the profile is allowed to hold (in grams), unlike the rider's
 * bodyweight which is live. These pure tests lock that split: the grams key passes the no-live-numbers
 * guard, the reader is defensive against a partial bikes map, and systemWeightKg only combines the two
 * when both are real — so a caller degrades to a note rather than a misleading number.
 */

const profile = (bikes: unknown): Profile => ({ schema_version: 1, identity: {}, equipment: { bikes } }) as Profile;

test("bikeRaceWeights reads grams and derives kg, skipping bikes without a weight", () => {
  const out = bikeRaceWeights(profile({ felt: { groupset: "Ultegra", race_weight_g: 10000 }, road: { crank_length_mm: 172.5 } }));
  assert.deepEqual(out, [{ name: "felt", raceWeightG: 10000, raceWeightKg: 10 }]);
});

test("bikeRaceWeights rounds kg to 0.1 and ignores non-positive / non-numeric values", () => {
  const out = bikeRaceWeights(profile({ tt: { race_weight_g: 8250 }, junk: { race_weight_g: 0 }, bad: { race_weight_g: "heavy" }, broken: 42 }));
  assert.deepEqual(out, [{ name: "tt", raceWeightG: 8250, raceWeightKg: 8.3 }]);
});

test("bikeRaceWeights returns [] for a missing / malformed equipment block (never throws)", () => {
  assert.deepEqual(bikeRaceWeights(profile(undefined)), []);
  assert.deepEqual(bikeRaceWeights(profile([])), []); // bikes must be a map, not a list
  assert.deepEqual(bikeRaceWeights({ schema_version: 1, identity: {} } as Profile), []);
  assert.deepEqual(bikeRaceWeights(null), []);
});

test("race_weight_g in grams passes the no-live-numbers guard; a kg weight key would not", () => {
  // The whole point of grams: the bike's mass is stable kit data and validates…
  assert.doesNotThrow(() => assertNoLiveNumbers({ equipment: { bikes: { felt: { race_weight_g: 10000 } } } }));
  // …whereas a kg weight key is treated as live rider bodyweight and is rejected.
  assert.throws(() => assertNoLiveNumbers({ equipment: { bikes: { felt: { race_weight_kg: 10 } } } }), /live performance number/i);
  assert.throws(() => assertNoLiveNumbers({ equipment: { bikes: { felt: { weight: 10 } } } }), /live performance number/i);
});

test("systemWeightKg adds live rider weight to the bike and rounds to 0.1 kg", () => {
  assert.equal(systemWeightKg(72, 10000), 82); // 72 kg rider + 10 kg bike
  assert.equal(systemWeightKg(71.5, 10000), 81.5);
  assert.equal(systemWeightKg(68.4, 8250), 76.7); // 68.4 + 8.25 = 76.65 → 76.7
});

test("systemWeightKg returns null when either input is missing/invalid (degrade, don't guess)", () => {
  assert.equal(systemWeightKg(null, 10000), null);
  assert.equal(systemWeightKg(72, null), null);
  assert.equal(systemWeightKg(72, undefined), null);
  assert.equal(systemWeightKg(0, 10000), null);
  assert.equal(systemWeightKg(72, -5), null);
  assert.equal(systemWeightKg(Number.NaN, 10000), null);
});
