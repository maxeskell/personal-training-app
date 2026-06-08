import { test } from "node:test";
import assert from "node:assert/strict";
import { raceContext, buildProposerContext, validateProposals } from "../src/coach/planAdjust.js";
import { emptyState } from "../src/state/types.js";
import type { InsightReport } from "../src/insights/engine.js";

test("raceContext lists upcoming races with countdown, sourced live from AIE goals", () => {
  const s = emptyState("2026-06-08", "x");
  s.raw = { getRaceGoalEvent: { goals: [
    { event_name: "Birmingham Tri", event_date: "2026-07-11", priority: "A" },
    { event_name: "Past Race", event_date: "2026-05-01", priority: "C" }, // already gone → excluded
    { event_name: "Loch Ness Marathon", event_date: "2026-09-27", priority: "B" },
  ] } };
  const ctx = raceContext(s);
  assert.match(ctx, /Birmingham Tri in 33d/);
  assert.match(ctx, /Loch Ness Marathon in 111d/);
  assert.ok(!ctx.includes("Past Race"), "past races excluded");
  // sorted nearest-first
  assert.ok(ctx.indexOf("Birmingham") < ctx.indexOf("Loch Ness"));
});

test("buildProposerContext folds in load bands, training status, races, predictions, taper", () => {
  const s = emptyState("2026-06-08", "x");
  s.raw = { getRaceGoalEvent: { goals: [{ event_name: "A Race", event_date: "2026-07-11", priority: "A" }] } };
  s.trainingStatus = { value: { loadRatio: 1.7, acwrStatus: "HIGH", label: "OVERREACHING_5" }, source: "garmin" } as typeof s.trainingStatus;
  const ins = {
    load: { ctl: 32, atl: 45, tsb: -18, rampPerWeek: 3, series: [] },
    topFindings: [{ family: "Load & injury risk", title: "Overreaching", severity: "flag", detail: "ratio 1.7", evidence: "e", recommendation: "Cut a session." }],
    findings: [{ family: "Heat confounder", title: "EF dip is partly heat", severity: "info", detail: "x", evidence: "e" }],
    predictions: [{ race: "A Race", predictedSec: 15000, targetSec: 14400, daysTo: 33, gapSec: 600 }],
    durability: { run: { recent: -4.5, prior: -13, deltaPct: null, n: 30 } },
    taper: { recommendedTsbLow: -5, recommendedTsbHigh: 5 },
  } as unknown as InsightReport;
  const ctx = buildProposerContext(s, ins);
  assert.match(ctx, /deep fatigue|fatigued/); // TSB -18 band
  assert.match(ctx, /Acute:chronic 1\.7 \(HIGH\)/);
  assert.match(ctx, /partly heat/); // relevant finding folded in
  assert.match(ctx, /Prediction A Race/);
  assert.match(ctx, /Taper target/);
});

test("basis flows through validateProposals", () => {
  const planned = [{ workoutId: "1", date: "2026-06-10", title: "Run", sport: "Run" as const }];
  const { valid } = validateProposals(
    [{ summary: "move", tradeoff: "t", tool: "changeWorkoutDate", argsJson: '{"workoutId":"1","newDate":"2026-06-12"}', basis: ["acute:chronic 1.7", "33d to A-race"] }],
    planned,
  );
  assert.deepEqual(valid[0].basis, ["acute:chronic 1.7", "33d to A-race"]);
});
