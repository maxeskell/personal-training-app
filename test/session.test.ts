import { test } from "node:test";
import assert from "node:assert/strict";
import { assembleSession, buildSessionContext } from "../src/coach/session.js";
import { emptyState } from "../src/state/types.js";
import type { SessionDecay } from "../src/insights/fit.js";
import type { FitSummary } from "../src/archive/store.js";

function stateWithRuns() {
  const s = emptyState("2026-06-09", new Date().toISOString());
  s.raw = {
    getRunningActivity: {
      activities: [
        { activity_date_local: "2026-06-09", activity_avwatts: 300, activity_avhr: 150, activity_movingtime: 3600, external_stress_score: 80, aerobic_durability_according_to_dfa_alpha1_running_power_in_percent: 85 },
        { activity_date_local: "2026-06-05", activity_avwatts: 280, activity_avhr: 150, activity_movingtime: 3000, external_stress_score: 70 },
        { activity_date_local: "2026-06-02", activity_avwatts: 279, activity_avhr: 150, activity_movingtime: 3300, external_stress_score: 75 },
      ],
    },
  };
  return s;
}

test("assembleSession: picks the most recent activity, computes EF, and builds the comparable norm", () => {
  const d = assembleSession(stateWithRuns(), undefined)!;
  assert.equal(d.date, "2026-06-09");
  assert.equal(d.sport, "Run");
  assert.equal(d.durationMin, 60);
  assert.equal(d.ef, 2); // 300/150
  assert.equal(d.durabilityPct, 85);
  assert.equal(d.comparable.n, 2); // the two earlier runs
  // efMean of 280/150 and 279/150 ≈ 1.863
  assert.ok(Math.abs(d.comparable.efMean! - 1.863) < 0.01);
});

test("assembleSession: a specific date selects that session; an unknown date returns null", () => {
  assert.equal(assembleSession(stateWithRuns(), undefined, { date: "2026-06-05" })!.ef, +(280 / 150).toFixed(3));
  assert.equal(assembleSession(stateWithRuns(), undefined, { date: "1999-01-01" }), null);
});

test("assembleSession: joins .FIT biomechanics and archive thermal summary by date+sport", () => {
  const decay: SessionDecay = { activityId: "a1", date: "2026-06-09", sport: "running", durationMin: 60, cadenceDropPct: -3, gctRisePct: 4, voRisePct: 2, hrDriftPct: 6, decouplingPct: 7, avgTempC: 24, avgPowerW: 300, avgHr: 150 };
  const fit: FitSummary = { activityId: "a1", date: "2026-06-09", sport: "Run", avgTempC: 24, weatherTempC: 22, trainingEffect: 3.4 };
  const d = assembleSession(stateWithRuns(), undefined, { decays: [decay], fitSummaries: [fit] })!;
  assert.equal(d.decay?.decouplingPct, 7);
  assert.equal(d.fit?.trainingEffect, 3.4);
  const ctx = buildSessionContext(d, stateWithRuns(), undefined);
  assert.match(ctx, /IN-SESSION BIOMECHANICS \[\.FIT/);
  assert.match(ctx, /Aerobic decoupling 7/);
});

test("buildSessionContext: states plainly when no .FIT stream is present (never fabricates)", () => {
  const d = assembleSession(stateWithRuns(), undefined)!;
  const ctx = buildSessionContext(d, stateWithRuns(), undefined);
  assert.match(ctx, /no \.FIT stream synced/);
});
