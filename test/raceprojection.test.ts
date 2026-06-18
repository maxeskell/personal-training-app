import { test } from "node:test";
import assert from "node:assert/strict";
import { projectRaceDayRange, MAX_PROJECTED_GAIN } from "../src/insights/splits.js";

test("projectRaceDayRange: an improving trend opens a faster best-case end, capped", () => {
  // 6000s prediction, getting ~0.05%/day faster, 30 days out → best ≈ 6000 × (1 − 0.015) = 5910.
  const r = projectRaceDayRange(6000, 30, -0.0005);
  assert.equal(r.worstSec, 6000); // worst = race it today
  assert.equal(r.bestSec, 5910);
  assert.ok(r.bestSec < r.worstSec);
  assert.match(r.rangeBasis, /complete the planned build/);
});

test("projectRaceDayRange: a strong/long trend is capped at MAX_PROJECTED_GAIN", () => {
  const r = projectRaceDayRange(6000, 300, -0.0005); // 0.0005×300 = 15% → capped to 7%
  assert.equal(r.bestSec, Math.round(6000 * (1 - MAX_PROJECTED_GAIN)));
});

test("projectRaceDayRange: no improving trend → best = current level (range collapses)", () => {
  for (const frac of [null, 0, 0.0003]) {
    const r = projectRaceDayRange(6000, 30, frac);
    assert.equal(r.bestSec, r.worstSec);
    assert.match(r.rangeBasis, /current level/);
  }
});

test("projectRaceDayRange: race day is here (daysToRace ≤ 0) → current level", () => {
  const r = projectRaceDayRange(6000, 0, -0.0005);
  assert.equal(r.bestSec, 6000);
  assert.match(r.rangeBasis, /Race is here/);
});
