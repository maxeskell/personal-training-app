import { test } from "node:test";
import assert from "node:assert/strict";
import {
  runLoadRampFindings,
  formAndIntensityFindings,
  efficiencyDurabilityFindings,
  anomalyCorrelationFindings,
  predictionFindings,
} from "../src/insights/engine.js";

/**
 * The buildInsights detectors used to be inline + untestable. Now that each is its own function, pin
 * their thresholds and the exact severity/family they emit — the part a refactor or a tweaked cutoff
 * could silently change. Inputs are minimal metric fixtures (loosely typed — this isn't typechecked).
 */

test("runLoadRampFindings: >50% jump flags injury risk; 25–50% watches; <25% is silent", () => {
  const f = (jumpPct: number) => runLoadRampFindings({ jumpPct, weeks: [1, 2, 3], thisWeekEss: 300, baselineEss: 180 } as never);
  assert.equal(f(60)[0]?.severity, "flag");
  assert.match(f(60)[0]?.title ?? "", /spiked/);
  assert.equal(f(35)[0]?.severity, "watch");
  assert.equal(f(10).length, 0);
  // self-gates without ≥3 weeks of history
  assert.equal(runLoadRampFindings({ jumpPct: 60, weeks: [1], thisWeekEss: 300, baselineEss: 180 } as never).length, 0);
});

test("formAndIntensityFindings: deep fatigue, fast ramp, monotony and grey-zone each fire", () => {
  const out = formAndIntensityFindings(
    { tsb: -30, ctl: 80, atl: 110, rampPerWeek: 9 } as never,
    { monotony: 2.5, strain: 1200, weeklyLoad: 500 } as never,
    { easyPct: 60, tempoPct: 25, hardPct: 15, totalH: 8 } as never,
  );
  const titles = out.map((x) => x.title);
  assert.ok(titles.includes("Deep fatigue (low form)"));
  assert.ok(titles.includes("Fitness ramping fast"));
  assert.ok(titles.includes("High training monotony"));
  assert.ok(titles.includes("Grey-zone creep"));
  // healthy values → silent
  assert.equal(
    formAndIntensityFindings({ tsb: -5, ctl: 70, atl: 72, rampPerWeek: 4 } as never, { monotony: 1.2, strain: 600, weeklyLoad: 500 } as never, { easyPct: 82, tempoPct: 10, hardPct: 8, totalH: 8 } as never).length,
    0,
  );
});

test("efficiencyDurabilityFindings: heat caveat only when EF slips without thermal data", () => {
  const slipNoHeat = efficiencyDurabilityFindings({ deltaPct: -8, n: 8, recent: 1.0, prior: 1.09 } as never, { recent: null, prior: null, n: 0 } as never, false);
  assert.match(slipNoHeat[0]?.detail ?? "", /hot spell can't be ruled out/);
  const slipWithHeat = efficiencyDurabilityFindings({ deltaPct: -8, n: 8, recent: 1.0, prior: 1.09 } as never, { recent: null, prior: null, n: 0 } as never, true);
  assert.doesNotMatch(slipWithHeat[0]?.detail ?? "", /hot spell/);
  // durability improving → info
  const durUp = efficiencyDurabilityFindings({ deltaPct: null, n: 0 } as never, { recent: -1, prior: -4, n: 8 } as never, true);
  assert.equal(durUp.find((x) => x.family === "Durability")?.severity, "info");
});

test("anomalyCorrelationFindings + predictionFindings emit the expected shapes", () => {
  const ac = anomalyCorrelationFindings(
    [{ metric: "HRV", z: -2.3, detail: "HRV well below baseline." }] as never,
    [{ r: 0.6, label: "Sleep → next-day load", interpretation: "More sleep precedes bigger days.", n: 40, fdrPass: true }] as never,
  );
  assert.ok(ac.some((x) => x.family === "Anomaly"));
  const corr = ac.find((x) => x.family === "Your patterns (n=1)");
  assert.equal(corr?.confidence, 0.8); // FDR-confirmed → high confidence

  const pf = predictionFindings([{ race: "Demo Marathon", gapSec: 600, predictedSec: 12300, targetSec: 11700, daysTo: 40 }] as never);
  assert.equal(pf[0]?.severity, "watch"); // +10 min behind target
  assert.match(pf[0]?.title ?? "", /behind target/);
});
