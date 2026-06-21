import { test } from "node:test";
import assert from "node:assert/strict";
import { effectiveWaterTemp, STALE_DAYS, DRIFT_K } from "../src/weather/waterTemp.js";
import type { WaterReading } from "../src/state/venue.js";

/**
 * The open-water forecaster (a MODEL): a fresh confirmed reading wins; once stale it's drifted by the
 * air-temp change since it was taken (damped ×DRIFT_K) and flagged for confirmation; with no reading the
 * COACH_WATER_TEMP_C seed fills in. Pure + deterministic — `now` and the air temp are injected.
 */

const NOW = new Date("2026-06-21T12:00:00.000Z");
const daysAgo = (n: number): string => new Date(NOW.getTime() - n * 86_400_000).toISOString();

test("no reading + no seed → undefined (the card says 'check the venue')", () => {
  assert.equal(effectiveWaterTemp(undefined, 18, NOW), undefined);
});

test("no reading + seed → the seed, not estimated, not stale", () => {
  const c = effectiveWaterTemp(undefined, 18, NOW, 15)!;
  assert.equal(c.tempC, 15);
  assert.equal(c.estimated, false);
  assert.equal(c.stale, false);
});

test("a fresh reading is used as-is (confirmed, high confidence, no prompt)", () => {
  const r: WaterReading = { tempC: 20, takenAt: daysAgo(2), airTempC: 18 };
  const c = effectiveWaterTemp(r, 25, NOW, 12)!;
  assert.equal(c.tempC, 20, "the measured reading wins — no drift while fresh");
  assert.equal(c.estimated, false);
  assert.equal(c.stale, false);
  assert.equal(c.confidence, "high");
});

test("a stale reading with an air anchor is drifted on air temperature (MODEL) and flagged to confirm", () => {
  const r: WaterReading = { tempC: 19, takenAt: daysAgo(STALE_DAYS + 3), airTempC: 16 };
  const c = effectiveWaterTemp(r, 22, NOW, undefined)!; // air rose 16 → 22
  assert.equal(c.estimated, true);
  assert.equal(c.stale, true);
  assert.equal(c.anchorTempC, 19);
  // 19 + 0.5 * (22 - 16) = 22
  assert.equal(c.tempC, Math.round((19 + DRIFT_K * (22 - 16)) * 10) / 10);
  assert.ok((c.basis ?? "").includes("MODEL"), "labelled a MODEL");
});

test("the drift is clamped to the plausible open-water range", () => {
  const r: WaterReading = { tempC: 2, takenAt: daysAgo(40), airTempC: 30 };
  const c = effectiveWaterTemp(r, -10, NOW)!; // a wild negative air swing
  assert.ok(c.tempC >= -2, "never below the floor");
  assert.equal(c.confidence, "low", "an old anchor → low confidence");
});

test("a stale reading with no air anchor carries forward but is still flagged to re-confirm", () => {
  const r: WaterReading = { tempC: 18, takenAt: daysAgo(STALE_DAYS + 1) }; // no airTempC
  const c = effectiveWaterTemp(r, 25, NOW)!;
  assert.equal(c.tempC, 18, "can't drift without an anchor — carry the last reading");
  assert.equal(c.estimated, false);
  assert.equal(c.stale, true, "but still ask the athlete to confirm");
});
