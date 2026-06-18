import { test } from "node:test";
import assert from "node:assert/strict";
import { loadModel } from "../src/insights/metrics.js";

function days(n: number): string[] {
  return Array.from({ length: n }, (_, i) => `2026-01-${String(i + 1).padStart(2, "0")}`);
}

test("loadModel: needs ≥14 aligned days, else null", () => {
  assert.equal(loadModel({ date: days(13), external_stress_score: new Array(13).fill(50) }), null);
  assert.equal(loadModel({ date: days(14), external_stress_score: new Array(13).fill(50) }), null); // length mismatch
});

test("loadModel: uses the Banister/Coggan decay 1−e^(−1/τ), not the EMA factor 2/(τ+1)", () => {
  // 7 zero days (seed = mean of first 7 = 0), then a step to 100. After the first 100-load day the
  // EWMAs move by exactly (100 − 0) × k. Correct k: CTL 1−e^(−1/42)=0.023526, ATL 1−e^(−1/7)=0.133156.
  const ess = [...new Array(7).fill(0), ...new Array(7).fill(100)];
  const m = loadModel({ date: days(14), external_stress_score: ess })!;
  const stepDay = m.series[7]; // first day of the step

  assert.equal(stepDay.ctl, 2.4); // 100 × 0.023526 = 2.35 → 2.4  (the wrong 2/43 factor gives 4.7)
  assert.equal(stepDay.atl, 13.3); // 100 × 0.133156 = 13.3        (the wrong 2/8 factor gives 25.0)
  // Sanity: chronic load lags acute, so TSB is negative while load is ramping.
  assert.ok(m.tsb < 0);
});

test("loadModel: constant load converges both EWMAs to that load (ramp → ~0)", () => {
  const m = loadModel({ date: days(200), external_stress_score: new Array(200).fill(60) })!;
  assert.ok(Math.abs(m.ctl - 60) < 1, `ctl ${m.ctl} should converge to 60`);
  assert.ok(Math.abs(m.atl - 60) < 0.5, `atl ${m.atl} should converge to 60`);
  assert.ok(Math.abs(m.rampPerWeek) < 0.5, `ramp ${m.rampPerWeek} should be ~0 at steady state`);
});
