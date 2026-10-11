import { test } from "node:test";
import assert from "node:assert/strict";
import { essSeriesWithHistory, loadModel } from "../src/insights/metrics.js";

function days(start: string, n: number): string[] {
  const out: string[] = [];
  const d = new Date(`${start}T00:00:00Z`);
  for (let i = 0; i < n; i++) {
    out.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}

test("essSeriesWithHistory: AIE window kept as-is, older days filled from the archive (0 on rest days)", () => {
  const rec = { date: ["2026-10-10", "2026-10-11"], external_stress_score: [35, 219] };
  const hist = [
    { date: "2026-10-07", ess: 50 },
    { date: "2026-10-07", ess: 10 }, // two sessions on a day sum
    { date: "2026-10-10", ess: 999 }, // inside the AIE window → AIE wins
  ];
  const s = essSeriesWithHistory(rec, hist)!;
  assert.deepEqual(s.date, ["2026-10-07", "2026-10-08", "2026-10-09", "2026-10-10", "2026-10-11"]);
  assert.deepEqual(s.external_stress_score, [60, 0, 0, 35, 219]);
});

test("essSeriesWithHistory: no older history → the AIE series unchanged", () => {
  const rec = { date: ["2026-10-10", "2026-10-11"], external_stress_score: [35, 219] };
  assert.deepEqual(essSeriesWithHistory(rec, [{ date: "2026-10-11", ess: 5 }]), { date: ["2026-10-10", "2026-10-11"], external_stress_score: [35, 219] });
  assert.equal(essSeriesWithHistory(undefined, []), undefined);
});

test("CTL from an extended series is stable where a 14-day window lurches (the Oct 2026 bug)", () => {
  // 120 days of steady 50 ESS/day, then a 14-day AIE window whose first week is a near-rest week.
  const histDates = days("2026-06-01", 120);
  const hist = histDates.map((date) => ({ date, ess: 50 }));
  const winDates = days("2026-09-29", 14);
  const winEss = [5, 5, 5, 5, 5, 5, 5, 50, 50, 50, 50, 50, 50, 50];
  const rec = { date: winDates, external_stress_score: winEss };
  const windowOnly = loadModel(rec)!.ctl;
  const extended = loadModel(essSeriesWithHistory(rec, hist))!.ctl;
  assert.ok(windowOnly < 20, `window-only CTL seeded from the rest week reads ~${windowOnly}`);
  assert.ok(extended > 40 && extended < 52, `extended CTL stays near the 50/day chronic load (got ${extended})`);
});
