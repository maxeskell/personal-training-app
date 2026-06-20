import { test } from "node:test";
import assert from "node:assert/strict";
import { detectDataQuality } from "../src/insights/dataQuality.js";
import { sleepDurationLow, garminTrendFindings, type GarminDaily } from "../src/insights/garminTrends.js";

/**
 * The data-quality detector is the "is this reading even real?" layer. Pin the three failure modes
 * (out-of-range, impossible jump, stuck) and — just as important for a "only show real problems"
 * promise — that clean, realistic data stays silent.
 */

const day = (i: number, fields: Partial<GarminDaily>): GarminDaily => ({
  date: new Date(Date.UTC(2026, 0, 1 + i)).toISOString().slice(0, 10),
  ...fields,
});

test("data quality: out-of-range value flags that stream", () => {
  const days = Array.from({ length: 10 }, (_, i) => day(i, { restingHr: i === 7 ? 300 : 50 + (i % 3) }));
  const out = detectDataQuality(days);
  assert.equal(out.length, 1);
  assert.equal(out[0].family, "Data quality");
  assert.match(out[0].title, /Resting HR/);
  assert.match(out[0].detail, /outside the plausible human range/);
});

test("data quality: impossible day-over-day body-comp jump flags as a measurement error", () => {
  // 75 → 81 kg overnight is mechanically impossible — a bad bioimpedance step, not real.
  const w = [75.0, 75.1, 74.9, 75.2, 81.0, 75.1, 74.8, 75.0];
  const days = w.map((kg, i) => day(i, { weightKg: kg }));
  const out = detectDataQuality(days);
  const weightFinding = out.find((f) => /Weight/.test(f.title));
  assert.ok(weightFinding, "weight jump surfaced");
  assert.match(weightFinding!.detail, /isn't physiological|measurement error/);
});

test("data quality: a flatlined (stuck) stream is flagged; the jump check ignores multi-day gaps", () => {
  // Same muscle value across 6 readings = stale sync / carried-forward reading.
  const days = Array.from({ length: 6 }, (_, i) => day(i * 3, { muscleMassKg: 35.0 }));
  const out = detectDataQuality(days);
  const muscle = out.find((f) => /muscle/i.test(f.title));
  assert.ok(muscle, "stuck muscle series surfaced");
  assert.match(muscle!.detail, /same value/);
});

test("data quality: realistic, varied data stays silent (no crying wolf)", () => {
  const days = Array.from({ length: 30 }, (_, i) =>
    day(i, {
      restingHr: 50 + ((i * 7) % 5),
      weightKg: 75 + Math.sin(i / 3) * 0.4,
      muscleMassKg: 35 + Math.cos(i / 4) * 0.2,
      sleepHours: 7.5 + ((i * 3) % 3) * 0.3,
      avgStressLevel: 30 + ((i * 5) % 10),
      avgSleepRespiration: 14 + ((i * 2) % 3),
    }),
  );
  assert.deepEqual(detectDataQuality(days), []);
});

test("data quality: at most one finding per stream (worst issue only)", () => {
  // Weight has BOTH an out-of-range reading and a jump — should still be a single finding.
  const w = [75, 400, 75, 81, 75, 75, 75];
  const days = w.map((kg, i) => day(i, { weightKg: kg }));
  const weightFindings = detectDataQuality(days).filter((f) => /Weight/.test(f.title));
  assert.equal(weightFindings.length, 1);
});

test("sleep duration: fires only when sleep is both below baseline AND short in absolute terms", () => {
  const mk = (last7: number) =>
    Array.from({ length: 40 }, (_, i) => day(i, { sleepHours: i >= 33 ? last7 : i % 2 === 0 ? 8.5 : 7.5 }));
  // Baseline ~8h, last week ~6h → fires.
  assert.ok(sleepDurationLow(mk(6.0)));
  // A mild dip to 7.8h (still ≥7h absolute) → silent, even though it's below baseline.
  assert.equal(sleepDurationLow(mk(7.8)), null);
});

test("garminTrendFindings: data-quality + sleep-duration ride alongside the trend findings", () => {
  const days = Array.from({ length: 30 }, (_, i) =>
    day(i, { avgStressLevel: 40, restingHr: i === 25 ? 300 : 50 }),
  );
  const families = new Set(garminTrendFindings(days).map((f) => f.family));
  assert.ok(families.has("Data quality"));
  // still self-gates below 21 days of history
  assert.equal(garminTrendFindings(days.slice(0, 10)).length, 0);
});
