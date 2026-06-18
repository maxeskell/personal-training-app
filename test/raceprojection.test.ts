import { test } from "node:test";
import assert from "node:assert/strict";
import { projectRaceDayImprovement, projectRaceDayRange, reliableImprovementPerDay, MAX_PROJECTED_GAIN } from "../src/insights/splits.js";

test("projectRaceDayRange: an improving trend opens a faster best-case end (diminishing returns)", () => {
  // 6000s, ~0.05%/day faster, 30 days out. Linear gain would be 1.5%; the damped curve saturates it to
  // ~1.35% → best ≈ 6000 × (1 − 0.0135) = 5919.
  const r = projectRaceDayRange(6000, 30, -0.0005);
  assert.equal(r.worstSec, 6000); // worst = race it today
  assert.equal(r.bestSec, 5919);
  assert.ok(r.bestSec < r.worstSec);
  assert.match(r.rangeBasis, /complete the planned build/);
  assert.match(r.rangeBasis, /diminishing returns/);
});

test("projectRaceDayRange: gain is concave — doubling the horizon yields LESS than double the gain", () => {
  const g30 = 6000 - projectRaceDayRange(6000, 30, -0.0005).bestSec;
  const g60 = 6000 - projectRaceDayRange(6000, 60, -0.0005).bestSec;
  assert.ok(g60 > g30); // longer horizon → more gain…
  assert.ok(g60 < 2 * g30); // …but less than linear (diminishing returns)
});

test("projectRaceDayRange: long horizon saturates toward, but never exceeds, the cap", () => {
  const capFloor = Math.round(6000 * (1 - MAX_PROJECTED_GAIN)); // 5580
  const long = projectRaceDayRange(6000, 300, -0.0005).bestSec;
  const veryLong = projectRaceDayRange(6000, 100000, -0.0005).bestSec;
  assert.ok(long > capFloor); // saturating: never quite reaches the cap at a realistic horizon
  assert.ok(veryLong < long); // longer → closer to the cap
  assert.ok(veryLong >= capFloor); // but bounded by it
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

// ---- PRIMARY basis: bounded, horizon-driven projection of doing the training ahead well ----

test("projectRaceDayImprovement: more weeks to build → more gain, capped, never absurd", () => {
  const near = projectRaceDayImprovement(23, true)!; // ~3.3 weeks
  const mid = projectRaceDayImprovement(80, true)!; // ~11.4 weeks
  const far = projectRaceDayImprovement(108, true)!; // ~15.4 weeks
  assert.ok(near.projectedFrac > 0 && near.projectedFrac < mid.projectedFrac && mid.projectedFrac < far.projectedFrac);
  assert.ok(far.projectedFrac < MAX_PROJECTED_GAIN); // a realistic horizon never quite reaches the cap
  assert.ok(near.projectedFrac < 0.03 && far.projectedFrac < MAX_PROJECTED_GAIN); // bounded, sane
  assert.match(near.basis, /planned training well/);
});

test("projectRaceDayImprovement: distinct per horizon (the two-Olympic-races bug is gone)", () => {
  // Same distance, different dates must NOT collapse to the same projected best.
  assert.notEqual(projectRaceDayImprovement(23, true)!.projectedFrac, projectRaceDayImprovement(80, true)!.projectedFrac);
});

test("projectRaceDayImprovement: not building, or race here → null", () => {
  assert.equal(projectRaceDayImprovement(80, false), null); // nothing planned, fitness declining
  assert.equal(projectRaceDayImprovement(0, true), null); // race is here
});

test("projectRaceDayImprovement: a very long horizon saturates toward, but never exceeds, the cap", () => {
  const veryLong = projectRaceDayImprovement(3650, true)!.projectedFrac; // 10 years
  assert.ok(veryLong > MAX_PROJECTED_GAIN * 0.99 && veryLong <= MAX_PROJECTED_GAIN);
});

// ---- precedence: planned (PRIMARY) wins over the observed trend (FALLBACK) ----

test("projectRaceDayRange: a planned projection takes precedence over the observed trend", () => {
  const r = projectRaceDayRange(6000, 30, -0.0005, { projectedFrac: 0.05, basis: "PLANNED BASIS" });
  assert.equal(r.bestSec, 5700); // 6000 × (1 − 0.05), not the trend's 5919
  assert.equal(r.rangeBasis, "PLANNED BASIS");
});

test("projectRaceDayRange: falls back to the observed trend when there's no usable plan", () => {
  for (const planned of [null, undefined, { projectedFrac: 0, basis: "x" }]) {
    const r = projectRaceDayRange(6000, 30, -0.0005, planned);
    assert.equal(r.bestSec, 5919); // the diminishing-returns trend path
  }
});

test("projectRaceDayRange: no plan and no trend → current level", () => {
  const r = projectRaceDayRange(6000, 30, null, null);
  assert.equal(r.bestSec, r.worstSec);
  assert.match(r.rangeBasis, /current level/);
});

// ---- reliability gate: only project off a statistically distinguishable trend ----

function traj(values: number[]): Array<{ date: string; v: number }> {
  return values.map((v, i) => ({ date: `2026-06-${String(i + 1).padStart(2, "0")}`, v }));
}

test("reliableImprovementPerDay: a clean decreasing trend returns a negative rate", () => {
  const values = Array.from({ length: 12 }, (_, i) => 6200 - i * 18); // steadily faster
  const f = reliableImprovementPerDay(traj(values), 6000);
  assert.ok(f != null && f < 0, `expected a negative improvement rate, got ${f}`);
});

test("reliableImprovementPerDay: a flat/noisy trend is NOT projected (null)", () => {
  const noisy = [6000, 6010, 5995, 6008, 5998, 6005, 6002, 5997, 6006, 6001, 6003, 5999];
  assert.equal(reliableImprovementPerDay(traj(noisy), 6000), null);
});

test("reliableImprovementPerDay: an increasing (slowing) trend is not an upside (null)", () => {
  const slowing = Array.from({ length: 12 }, (_, i) => 6000 + i * 18);
  assert.equal(reliableImprovementPerDay(traj(slowing), 6000), null);
});

test("reliableImprovementPerDay: too few points, or no current prediction → null", () => {
  const few = Array.from({ length: 8 }, (_, i) => 6200 - i * 18);
  assert.equal(reliableImprovementPerDay(traj(few), 6000), null); // CI needs ≥10 paired points
  const enough = Array.from({ length: 12 }, (_, i) => 6200 - i * 18);
  assert.equal(reliableImprovementPerDay(traj(enough), undefined), null); // no nearest prediction to scale
});
