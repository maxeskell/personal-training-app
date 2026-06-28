import { test } from "node:test";
import assert from "node:assert/strict";
import { assembleSession, buildSessionContext, listRecentSessions, runSessionFeedback } from "../src/coach/session.js";
import { isLastSessionQuestion } from "../src/coach/ask.js";
import { emptyState } from "../src/state/types.js";
import type { SessionDecay } from "../src/insights/fit.js";
import type { FitSummary } from "../src/archive/store.js";
import type { CoachLLM } from "../src/llm/client.js";

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

/** A triathlete's multi-sport day: a long ride + a shorter run + a swim, all on 2026-06-09. */
function stateMultiSport() {
  const s = emptyState("2026-06-09", new Date().toISOString());
  s.raw = {
    getRunningActivity: { activities: [{ activity_date_local: "2026-06-09", activity_avwatts: 300, activity_avhr: 150, activity_movingtime: 1800 }] },
    getCyclingActivity: { activities: [{ activity_date_local: "2026-06-09", activity_avwatts: 200, activity_avhr: 140, activity_movingtime: 7200 }] },
    getSwimmingActivity: { activities: [{ activity_date_local: "2026-06-09", activity_avhr: 130, activity_movingtime: 1500 }] },
  };
  return s;
}

test("assembleSession: a multi-sport day defaults to the longest, but `sport` selects a specific session", () => {
  const def = assembleSession(stateMultiSport(), undefined)!; // no sport → longest (the 2h ride)
  assert.equal(def.sport, "Ride");
  assert.equal(def.durationMin, 120);
  assert.equal(def.sessionsOnDate, 3, "all three sessions on the day are counted");
  assert.equal(def.sameSportOnDate, 1);
  // Sport-narrowing addresses the run + swim that the longest-wins rule used to hide.
  assert.equal(assembleSession(stateMultiSport(), undefined, { sport: "Run" })!.durationMin, 30);
  assert.equal(assembleSession(stateMultiSport(), undefined, { sport: "Swim" })!.durationMin, 25);
});

test("buildSessionContext: flags a multi-session day so the model knows the readout covers one sport", () => {
  const d = assembleSession(stateMultiSport(), undefined, { sport: "Run" })!;
  assert.match(buildSessionContext(d, stateMultiSport(), undefined), /3 sessions on 2026-06-09/);
});

test("listRecentSessions: one row per date+sport, newest first, marks the most recent", () => {
  const rows = listRecentSessions(stateMultiSport());
  assert.equal(rows.length, 3, "swim + ride + run on one day are three selectable sessions");
  assert.equal(rows[0].sport, "Ride", "the longest of the most-recent day is marked most-recent first");
  assert.ok(rows.find((r) => r.sport === "Ride")!.isMostRecent);
  assert.ok(rows.filter((r) => r.isMostRecent).length === 1, "exactly one most-recent");
  // Same-sport repeats collapse to the longest (a swim/ride/run day stays three rows above).
  const runs = listRecentSessions(stateWithRuns());
  assert.deepEqual(runs.map((r) => r.date), ["2026-06-09", "2026-06-05", "2026-06-02"]);
});

/** Two SAME-sport sessions on one day (a recovery spin + the main ride), distinguishable only by duration. */
function stateDoubleRide() {
  const s = emptyState("2026-06-09", new Date().toISOString());
  s.raw = {
    getCyclingActivity: {
      activities: [
        { activity_date_local: "2026-06-09", activity_avwatts: 120, activity_avhr: 120, activity_movingtime: 1800 }, // 30min spin
        { activity_date_local: "2026-06-09", activity_avwatts: 230, activity_avhr: 150, activity_movingtime: 7200 }, // 120min ride
      ],
    },
  };
  return s;
}
const decay = (extra: Partial<SessionDecay>): SessionDecay => ({
  activityId: "x", date: "2026-06-09", sport: "cycling", startTimeS: null, durationMin: 60, cadenceDropPct: null, gctRisePct: null, voRisePct: null, hrDriftPct: null, decouplingPct: null, avgTempC: null, avgPowerW: null, avgHr: null, avgVerticalRatioPct: null, avgStepLengthMm: null, avgGctBalancePct: null, avgLrBalancePct: null, normalizedPowerW: null, ...extra,
});

test("Tier 1: a duration selects the right one of two same-sport sessions in a day", () => {
  assert.equal(assembleSession(stateDoubleRide(), undefined, { sport: "Ride" })!.durationMin, 120, "no duration → longest");
  assert.equal(assembleSession(stateDoubleRide(), undefined, { sport: "Ride", durationMin: 30 })!.durationMin, 30, "duration picks the spin");
  assert.equal(assembleSession(stateDoubleRide(), undefined, { sport: "Ride", durationMin: 120 })!.avgPowerW, 230, "duration picks the main ride");
  // The duration match is fuzzy — a few minutes of drift still resolves to the nearer session.
  assert.equal(assembleSession(stateDoubleRide(), undefined, { sport: "Ride", durationMin: 33 })!.durationMin, 30, "closest, not exact");
});

test("Tier 2: each session best-matches its OWN .FIT by duration, not the longest", () => {
  const decays = [decay({ durationMin: 30, startTimeS: 111 }), decay({ durationMin: 120, startTimeS: 999 })];
  const spin = assembleSession(stateDoubleRide(), undefined, { sport: "Ride", durationMin: 30, decays })!;
  const main = assembleSession(stateDoubleRide(), undefined, { sport: "Ride", durationMin: 120, decays })!;
  assert.equal(spin.startTimeS, 111, "the 30min ride links the 30min stream");
  assert.equal(main.startTimeS, 999, "the 120min ride links the 120min stream (not the first match)");
});

test("listRecentSessions: two same-sport sessions in a day are two distinct rows (Tier 1)", () => {
  const rows = listRecentSessions(stateDoubleRide(), [decay({ durationMin: 30, startTimeS: 111 }), decay({ durationMin: 120, startTimeS: 999 })]);
  assert.equal(rows.length, 2, "the spin and the main ride are separate chips");
  assert.deepEqual(rows.map((r) => r.durationMin).sort((a, b) => a! - b!), [30, 120]);
  assert.equal(rows.find((r) => r.durationMin === 30)!.startTimeS, 111, "each row best-matches its own stream's time");
  assert.equal(rows.find((r) => r.durationMin === 120)!.startTimeS, 999);
});

test("listRecentSessions: joins each row's start time from the matching .FIT stream (else null)", () => {
  const rideDecay: SessionDecay = { activityId: "c1", date: "2026-06-09", sport: "cycling", startTimeS: 1750000000, durationMin: 120, cadenceDropPct: null, gctRisePct: null, voRisePct: null, hrDriftPct: null, decouplingPct: null, avgTempC: null, avgPowerW: 200, avgHr: 140, avgVerticalRatioPct: null, avgStepLengthMm: null, avgGctBalancePct: null, avgLrBalancePct: null, normalizedPowerW: null };
  const rows = listRecentSessions(stateMultiSport(), [rideDecay]);
  assert.equal(rows.find((r) => r.sport === "Ride")!.startTimeS, 1750000000, "cycling decay matches the Ride row");
  assert.equal(rows.find((r) => r.sport === "Run")!.startTimeS, null, "no stream for the run → null, never a guess");
});

test("assembleSession: joins .FIT biomechanics and archive thermal summary by date+sport", () => {
  const decay: SessionDecay = { activityId: "a1", date: "2026-06-09", sport: "running", startTimeS: null, durationMin: 60, cadenceDropPct: -3, gctRisePct: 4, voRisePct: 2, hrDriftPct: 6, decouplingPct: 7, avgTempC: 24, avgPowerW: 300, avgHr: 150 };
  const fit: FitSummary = { activityId: "a1", date: "2026-06-09", sport: "Run", avgTempC: 24, weatherTempC: 22, trainingEffect: 3.4 };
  const d = assembleSession(stateWithRuns(), undefined, { decays: [decay], fitSummaries: [fit] })!;
  assert.equal(d.decay?.decouplingPct, 7);
  assert.equal(d.fit?.trainingEffect, 3.4);
  const ctx = buildSessionContext(d, stateWithRuns(), undefined);
  assert.match(ctx, /IN-SESSION BIOMECHANICS \[\.FIT/);
  assert.match(ctx, /Aerobic decoupling 7/);
});

test("buildSessionContext: power line follows the session sport — running power is not labelled bike power", () => {
  // Regression: a Run carries running power (NP/VI computed from the run's power channel). The label used
  // to be a blanket "Bike power", which made the model flag a phantom run/ride mix-up. It must say "Run power".
  const runDecay: SessionDecay = { activityId: "r1", date: "2026-06-09", sport: "running", startTimeS: null, durationMin: 60, cadenceDropPct: -3, gctRisePct: 4, voRisePct: 2, hrDriftPct: 6, decouplingPct: 8, avgTempC: null, avgPowerW: 285, avgHr: 133, avgVerticalRatioPct: null, avgStepLengthMm: null, avgGctBalancePct: null, avgLrBalancePct: null, normalizedPowerW: 317 };
  const ctx = buildSessionContext(assembleSession(stateWithRuns(), undefined, { decays: [runDecay] })!, stateWithRuns(), undefined);
  assert.match(ctx, /Run power: normalized power 317W \(avg 285W → variability index 1\.11\)/);
  assert.ok(!/Bike power/.test(ctx), "a run never says bike power");
});

test("buildSessionContext: a swim reports pace + stroke efficiency, labels open water, and flags the active-only basis", () => {
  // The old block printed GCT/vertical-osc (meaningless for a swim) and whole-clock cadence — which read a
  // long rest as a fake fade. The swim block must instead give pace + distance-per-stroke and say the
  // drifts are over active swimming only, so the model never re-reads a rest as form falling apart.
  const swimDecay = {
    activityId: "s1", date: "2026-06-09", sport: "swimming", startTimeS: null, durationMin: 47,
    cadenceDropPct: -2, gctRisePct: null, voRisePct: null, hrDriftPct: 3, decouplingPct: 4, avgTempC: 22.6,
    avgPowerW: null, avgHr: 134, avgVerticalRatioPct: null, avgStepLengthMm: null, avgGctBalancePct: null,
    avgLrBalancePct: null, normalizedPowerW: null,
    swim: { openWater: true, paceSecPer100m: 143, paceDriftPct: 14.3, distPerStrokeM: 1.45, dpsDriftPct: 7.1 },
  } as unknown as SessionDecay;
  const ctx = buildSessionContext(assembleSession(stateMultiSport(), undefined, { sport: "Swim", decays: [swimDecay] })!, stateMultiSport(), undefined);
  assert.match(ctx, /open-water swim/);
  assert.match(ctx, /Swim pace 2:23\/100m/); // 143 s/100m
  assert.match(ctx, /slowed 14\.3% .*positive split/);
  assert.match(ctx, /1\.45 m\/stroke/);
  assert.match(ctx, /efficiency improved 7\.1%/);
  assert.match(ctx, /active swimming only/);
  assert.ok(!/GCT rise/.test(ctx), "a swim never prints run-only GCT/vertical-oscillation lines");
});

test("buildSessionContext: a ride still labels its power 'Bike power'", () => {
  const rideDecay: SessionDecay = { activityId: "c1", date: "2026-06-09", sport: "cycling", startTimeS: null, durationMin: 120, cadenceDropPct: null, gctRisePct: null, voRisePct: null, hrDriftPct: null, decouplingPct: null, avgTempC: 22, avgPowerW: 200, avgHr: 140, avgVerticalRatioPct: null, avgStepLengthMm: null, avgGctBalancePct: null, avgLrBalancePct: null, normalizedPowerW: 222 };
  const ctx = buildSessionContext(assembleSession(stateMultiSport(), undefined, { sport: "Ride", decays: [rideDecay] })!, stateMultiSport(), undefined);
  assert.match(ctx, /Bike power: normalized power 222W/);
});

test("buildSessionContext: a missing session temperature reads as a device gap, not a data-pipeline gap", () => {
  const noTemp: SessionDecay = { activityId: "r2", date: "2026-06-09", sport: "running", startTimeS: null, durationMin: 60, cadenceDropPct: -3, gctRisePct: 4, voRisePct: 2, hrDriftPct: 6, decouplingPct: 8, avgTempC: null, avgPowerW: 285, avgHr: 133, avgVerticalRatioPct: null, avgStepLengthMm: null, avgGctBalancePct: null, avgLrBalancePct: null, normalizedPowerW: 317 };
  const ctx = buildSessionContext(assembleSession(stateWithRuns(), undefined, { decays: [noTemp] })!, stateWithRuns(), undefined);
  assert.match(ctx, /Session mean temperature: not recorded by the device/);
  assert.ok(!/Session mean temperature —°C/.test(ctx), "no bare em-dash that reads as a sync failure");
  // Present temperature still renders as a number.
  const withTemp = { ...noTemp, avgTempC: 24 };
  assert.match(buildSessionContext(assembleSession(stateWithRuns(), undefined, { decays: [withTemp] })!, stateWithRuns(), undefined), /Session mean temperature 24\.0°C/);
});

test("buildSessionContext: states plainly when no .FIT stream is present (never fabricates)", () => {
  const d = assembleSession(stateWithRuns(), undefined)!;
  const ctx = buildSessionContext(d, stateWithRuns(), undefined);
  assert.match(ctx, /no raw \.FIT stream/);
  assert.match(ctx, /data\/fit-streams\//); // points at the real source, not fit-sync
});

test("buildSessionContext: includes the next-7-days plan so the model can adjust ahead (user ask)", () => {
  const s = stateWithRuns();
  s.plannedSessions = {
    value: [
      { date: "2026-06-11", sport: "Run", title: "Tempo 3x10", durationMin: 60 },
      { date: "2026-06-25", sport: "Run", title: "beyond the horizon" },
    ],
    source: "ai-endurance",
  };
  const d = assembleSession(s, undefined)!; // session date 2026-06-09 → horizon 2026-06-16
  const ctx = buildSessionContext(d, s, undefined);
  assert.match(ctx, /UPCOMING PLAN \(next 7 days\)/);
  assert.match(ctx, /2026-06-11 Run: Tempo 3x10 \(60min planned\)/);
  assert.ok(!ctx.includes("beyond the horizon"), "sessions past the 7-day horizon are excluded");
  // No planned sessions → no empty section.
  assert.ok(!buildSessionContext(assembleSession(stateWithRuns(), undefined)!, stateWithRuns(), undefined).includes("UPCOMING PLAN"));
});

const RUN_DECAY: SessionDecay = { activityId: "a1", date: "2026-06-09", sport: "running", startTimeS: null, durationMin: 60, cadenceDropPct: -3, gctRisePct: 4, voRisePct: 2, hrDriftPct: 6, decouplingPct: 7, avgTempC: 24, avgPowerW: 300, avgHr: 150 };
const llmStub = (): CoachLLM => ({ text: async () => ({ text: "LLM FEEDBACK", cacheRead: 0, costUsd: 0.01 }) }) as unknown as CoachLLM;
const llmMustNotRun = (): CoachLLM =>
  ({ text: async () => { throw new Error("LLM must not be called without the .FIT stream"); } }) as unknown as CoachLLM;

test("runSessionFeedback: no raw .FIT stream → no LLM call, zero cost, explains how to unlock (user ask)", async () => {
  const fb = (await runSessionFeedback(llmMustNotRun(), stateWithRuns(), undefined))!;
  assert.equal(fb.skippedNoFit, true);
  assert.equal(fb.costUsd, 0);
  assert.match(fb.markdown, /skipped/i);
  assert.match(fb.markdown, /Export Original/);
});

test("runSessionFeedback: --force runs without the stream; a joined stream runs normally", async () => {
  const forced = (await runSessionFeedback(llmStub(), stateWithRuns(), undefined, { force: true }))!;
  assert.ok(!forced.skippedNoFit);
  assert.match(forced.markdown, /LLM FEEDBACK/);
  const joined = (await runSessionFeedback(llmStub(), stateWithRuns(), undefined, { decays: [RUN_DECAY] }))!;
  assert.ok(!joined.skippedNoFit);
  assert.match(joined.markdown, /LLM FEEDBACK/);
});

test("isLastSessionQuestion: routes recency+session-noun questions, leaves general Q&A alone", () => {
  // Routed — a recency word plus a session noun.
  for (const q of ["what happened in my last run?", "how did my latest ride go?", "feedback on today's session", "analyse my most recent swim"]) {
    assert.equal(isLastSessionQuestion(q), true, q);
  }
  // Not routed — no recency word, or no session noun.
  for (const q of ["how were my long rides this month?", "am I overtraining?", "what's my FTP?", "how is my fitness trending?"]) {
    assert.equal(isLastSessionQuestion(q), false, q);
  }
});
