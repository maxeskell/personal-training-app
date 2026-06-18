import { test } from "node:test";
import assert from "node:assert/strict";
import { applyTrendFloor, adverseSignalCount, summarizeForReadiness, type ReadinessVerdict } from "../src/coach/readiness.js";
import { emptyState } from "../src/state/types.js";
import type { AthleteState } from "../src/state/types.js";

/**
 * The deterministic trend floor (COACH-1): "a red needs a PATTERN, not one off number" is now enforced in
 * code, not only in the prompt. These tests pin the floor and the weight line added to the snapshot.
 */
function day(
  date: string,
  o: Partial<{ hrv: number; hrvBase: number; rhr: number; rhrBase: number; sleepH: number; cardio: number }> = {},
): AthleteState {
  const s = emptyState(date, date + "T06:00:00Z");
  if (o.hrv != null) s.hrvOvernight = { value: o.hrv, source: "garmin" };
  if (o.hrvBase != null) s.hrv7dBaseline = { value: o.hrvBase, source: "derived" };
  if (o.rhr != null) s.restingHr = { value: o.rhr, source: "garmin" };
  if (o.rhrBase != null) s.restingHr7dBaseline = { value: o.rhrBase, source: "derived" };
  if (o.sleepH != null) s.sleep = { value: { hours: o.sleepH, score: 80 }, source: "garmin" };
  if (o.cardio != null) s.recovery = { value: { cardioRecovery: o.cardio, orthopedic: {} }, source: "ai-endurance" } as AthleteState["recovery"];
  return s;
}
const RED: ReadinessVerdict = { verdict: "red", why: "x", drivers: [], cautions: [] };

test("applyTrendFloor downgrades a LONE-signal red to amber", () => {
  // only today's HRV is mildly suppressed; the prior days are at baseline → not a pattern.
  const w = [
    day("2026-06-12", { hrv: 60, hrvBase: 60, rhr: 48, rhrBase: 48, sleepH: 7.5 }),
    day("2026-06-13", { hrv: 60, hrvBase: 60, rhr: 48, rhrBase: 48, sleepH: 7.5 }),
    day("2026-06-14", { hrv: 50, hrvBase: 60, rhr: 48, rhrBase: 48, sleepH: 7.5 }),
  ];
  assert.equal(adverseSignalCount(w).count, 1);
  const out = applyTrendFloor(RED, w);
  assert.equal(out.verdict, "amber");
  assert.match(out.cautions.join(" "), /red→amber|trend over point/);
});

test("applyTrendFloor KEEPS red when two signals are out of line today (a pattern)", () => {
  const w = [
    day("2026-06-13", { hrv: 60, hrvBase: 60, rhr: 48, rhrBase: 48 }),
    day("2026-06-14", { hrv: 48, hrvBase: 60, rhr: 56, rhrBase: 48 }), // HRV down + RHR up
  ];
  assert.equal(applyTrendFloor(RED, w).verdict, "red");
});

test("applyTrendFloor KEEPS red on a sustained multi-day deterioration", () => {
  const w = [
    day("2026-06-12", { hrv: 50, hrvBase: 60 }),
    day("2026-06-13", { hrv: 49, hrvBase: 60 }),
    day("2026-06-14", { hrv: 48, hrvBase: 60 }), // 3 adverse days running
  ];
  assert.equal(adverseSignalCount(w).multiDay, true);
  assert.equal(applyTrendFloor(RED, w).verdict, "red");
});

test("applyTrendFloor keeps red when the AI Endurance recovery model is also down", () => {
  const w = [day("2026-06-14", { hrv: 50, hrvBase: 60, cardio: 40 })]; // HRV + low cardio recovery = 2 signals
  assert.equal(adverseSignalCount(w).count, 2);
  assert.equal(applyTrendFloor(RED, w).verdict, "red");
});

test("applyTrendFloor keeps red on a lone HIGH-SPECIFICITY signal (a big RHR spike = illness)", () => {
  const w = [day("2026-06-14", { rhr: 60, rhrBase: 45 })]; // +15 over baseline, nothing else present
  assert.equal(adverseSignalCount(w).count, 1); // only one signal — would normally downgrade…
  const out = applyTrendFloor(RED, w);
  assert.equal(out.verdict, "red"); // …but a large isolated RHR spike stands on its own
  assert.match(out.cautions.join(" "), /high-specificity/i);
});

test("applyTrendFloor HOLDS red (doesn't downgrade) when data is too thin to confirm a one-off", () => {
  const w = [day("2026-06-14")]; // no interpretable inputs present — missing data must not read as 'fine'
  assert.equal(adverseSignalCount(w).count, 0);
  const out = applyTrendFloor(RED, w);
  assert.equal(out.verdict, "red");
  assert.match(out.cautions.join(" "), /limited[- ]data|too little/i);
});

test("applyTrendFloor never touches amber or green", () => {
  const amber: ReadinessVerdict = { verdict: "amber", why: "x", drivers: [], cautions: [] };
  const green: ReadinessVerdict = { verdict: "green", why: "x", drivers: [], cautions: [] };
  const w = [day("2026-06-14", { hrv: 50, hrvBase: 60 })];
  assert.equal(applyTrendFloor(amber, w).verdict, "amber");
  assert.equal(applyTrendFloor(green, w).verdict, "green");
});

test("summarizeForReadiness includes a trend-only weight line", () => {
  const w = [day("2026-06-13"), day("2026-06-14")];
  w[1].weightKg = { value: 69.4, source: "garmin" };
  const s = summarizeForReadiness(w);
  assert.match(s, /Weight:.*69\.4 kg.*trend only/);
});
