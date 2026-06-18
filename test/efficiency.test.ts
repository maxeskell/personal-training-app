import { test } from "node:test";
import assert from "node:assert/strict";
import { analyseEfficiency, efficiencyFinding } from "../src/insights/efficiency.js";
import type { RichActivity, LoadModel } from "../src/insights/metrics.js";

// Small deterministic wobble so the fit isn't exact (gives a real SE → an honest CI), no RNG.
const noise = (i: number) => (((i * 37) % 7) - 3) * 0.0005; // ±0.0015

function build(efOf: (i: number, ctl: number) => number, ctlOf: (i: number) => number, n = 12): { acts: RichActivity[]; load: LoadModel } {
  const acts: RichActivity[] = [];
  const series: LoadModel["series"] = [];
  const base = Date.UTC(2026, 2, 1);
  for (let i = 0; i < n; i++) {
    const date = new Date(base + i * 7 * 86_400_000).toISOString().slice(0, 10);
    const ctl = ctlOf(i);
    const ef = efOf(i, ctl) + noise(i);
    acts.push({ date, sport: "Run", avhr: 150, avwatts: ef * 150, movingSec: 3000 });
    series.push({ date, load: 50, ctl, atl: ctl, tsb: 0 });
  }
  return { acts, load: { series, ctl: series[series.length - 1].ctl, atl: 0, tsb: 0, rampPerWeek: 0 } };
}

test("analyseEfficiency: a time trend beyond CTL → an APPARENT economy gain (CI excludes 0)", () => {
  // EF rises with time independent of CTL; CTL varies but isn't collinear with time.
  const { acts, load } = build((i, ctl) => 2.0 + 0.002 * (i * 7) + 0.0015 * ctl, (i) => 42 + (i % 3) * 5);
  const e = analyseEfficiency(acts, load);
  assert.equal(e.efImproving, true);
  assert.ok(e.economyPer30d! > 0 && e.ciLow! > 0, `economy ${e.economyPer30d} CI ${e.ciLow}..${e.ciHigh}`);
  assert.equal(e.economyReliable, true);
  assert.match(efficiencyFinding(e)!.title, /Apparent economy/);
  assert.match(efficiencyFinding(e)!.detail, /heat-adjusted/); // honesty caveat present
});

test("analyseEfficiency: EF that only tracks CTL → no reliable economy gain (fitness, not economy)", () => {
  // EF is essentially a function of CTL only; CTL rises with time (with a wobble so it's not collinear).
  const { acts, load } = build((_i, ctl) => 2.0 + 0.003 * ctl, (i) => 40 + i + (i % 2) * 3);
  const e = analyseEfficiency(acts, load);
  assert.equal(e.economyReliable, false); // the time coefficient's CI spans 0
  assert.equal(e.fitnessExplains, true);
  assert.match(efficiencyFinding(e)!.title, /fitness, not economy/);
});

test("analyseEfficiency: fewer than 10 steady runs → no economy claim", () => {
  const { acts, load } = build((i, ctl) => 2.0 + 0.002 * (i * 7) + 0.0015 * ctl, (i) => 42 + (i % 3) * 5, 8);
  const e = analyseEfficiency(acts, load);
  assert.equal(e.economyPer30d, null);
  assert.equal(efficiencyFinding(e), null);
});
