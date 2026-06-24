import { test } from "node:test";
import assert from "node:assert/strict";
import { buildDemoWindow, buildDemoGarminDays } from "../src/demo/sampleData.js";
import { renderDashboard } from "../src/coach/dashboard.js";
import { buildInsights } from "../src/insights/engine.js";
import { assessHealthRisk } from "../src/guardrails/wellbeing.js";

/**
 * The demo mode must let a no-account user see the coach working, so its sample window has to be valid
 * end-to-end: populated current markers, a healthy profile that doesn't trip the wellbeing guardrail,
 * and an AthleteState the insight engine + dashboard render without throwing.
 */

test("buildDemoWindow yields a populated window ending today, with current markers + a race calendar", () => {
  const today = "2026-06-14";
  const w = buildDemoWindow(today, 21);
  assert.equal(w.length, 21);
  assert.equal(w[w.length - 1].date, today);
  assert.equal(w[0].date < today, true);

  const t = w[w.length - 1];
  assert.equal(t.thresholds.value?.bikeFtpW, 250);
  assert.ok(t.zones.value, "zones derived from the demo thresholds");
  assert.equal(t.plannedSessions.value?.length, 7);
  assert.ok((t.actualActivities.value?.length ?? 0) > 0);
  assert.equal((t.raw?.getRaceGoalEvent as { goals: unknown[] }).goals.length, 2);
  // every day carries the readiness time-series the Trends sparklines read
  assert.ok(w.every((s) => s.hrvOvernight.value != null && s.weightKg.value != null && s.load.value?.ctl != null));
});

test("the demo profile is healthy — the wellbeing guardrail stays quiet (no false alarm)", () => {
  const w = buildDemoWindow("2026-06-14", 21);
  assert.equal(assessHealthRisk(w).level, "none");
});

test("the insight engine and dashboard render the demo state without throwing", () => {
  const w = buildDemoWindow("2026-06-14", 21);
  const state = w[w.length - 1];
  const insights = buildInsights(state, undefined, { history: w });
  assert.ok(insights, "insights build from the demo state");
  const html = renderDashboard({ window: w, decisions: [], insights, canFetchFit: false });
  assert.match(html, /<html/i);
  assert.match(html, /250/); // the demo bike FTP (250 W) renders in the Zones & thresholds card
});

test("demo data is rich enough for a hero screenshot: load model, Garmin scores + race predictions", () => {
  const today = "2026-06-14";
  const w = buildDemoWindow(today, 42);
  const t = w[w.length - 1];
  // The 42-day ESS series under getRecoveryModel.data drives a non-empty Load & trends card.
  const rec = (t.raw?.getRecoveryModel as { data: { date: string[]; external_stress_score: number[] } }).data;
  assert.equal(rec.date.length, 42);
  assert.equal(rec.external_stress_score.length, 42);
  const insights = buildInsights(t, undefined, { history: w });
  assert.ok(insights.load && typeof insights.load.ctl === "number", "loadModel derives CTL/ATL/TSB from the demo ESS series");
  // Garmin model scores are populated, with the FTP estimate intentionally below the configured 250 W.
  assert.ok((t.powerCurve.value?.ftpEstimateW ?? 0) < 250, "power-curve FTP estimate sits below the configured FTP (shows the gap note)");
  assert.ok((t.enduranceScore.value?.current ?? 0) > 0);
  assert.ok((t.hillScore.value?.overall ?? 0) > 0);
  assert.ok((t.racePredictions.value?.predictions.length ?? 0) >= 3);
});

test("the enriched demo fills the activity-driven cards: brick decoupling, monitoring, last session", () => {
  const today = "2026-06-14";
  const w = buildDemoWindow(today, 42);
  const t = w[w.length - 1];
  const ins = buildInsights(t, { garminDays: buildDemoGarminDays(today) }, { history: w });
  // Power-equipped runs → the brick decoupling proxy computes (no more "need power-equipped runs").
  assert.ok(ins.brick.decouplingPct != null, "brick decoupling computes from the demo's power-equipped runs");
  // A real sample history for the monitoring backtest (no more "0d history"); an exploratory rule surfaces.
  assert.ok(ins.monitoring.days > 0, "monitoring runs over real sample history");
  assert.ok(ins.monitoring.best, "an (exploratory) watch rule surfaces from the demo HRV→recovery relationship");
  // The Last-session card renders for the most recent demo activity (a run) with stored feedback inline.
  const html = renderDashboard({
    window: w,
    decisions: [],
    insights: ins,
    sessionFeedbacks: [{ schemaVersion: 1, date: "2026-06-13", sport: "Run", deep: true, generatedAt: new Date().toISOString(), costUsd: 0.2, markdown: "## Verdict\n**Solid** run." }],
  });
  assert.match(html, /Last session — 2026-06-13 Run/);
  assert.match(html, /<b>Solid<\/b> run/, "the stored session feedback renders inline");
});

test("buildDemoGarminDays: a 42-day series ending today with the Trends-card fields", () => {
  const today = "2026-06-14";
  const days = buildDemoGarminDays(today);
  assert.equal(days.length, 42);
  assert.equal(days[days.length - 1].date, today);
  assert.ok(days.every((d) => d.hrvMs != null && d.restingHr != null && d.sleepScore != null && d.avgStressLevel != null && d.deepSleepSec != null));
});

test("the enriched demo renders the load, trends and Garmin-scores cards", () => {
  const today = "2026-06-14";
  const w = buildDemoWindow(today, 42);
  const insights = buildInsights(w[w.length - 1], undefined, { history: w });
  const html = renderDashboard({
    window: w,
    decisions: [],
    insights,
    garminDays: buildDemoGarminDays(today),
    canFetchFit: false,
  });
  assert.match(html, /Load &amp; trends/);
  assert.match(html, /Trends \(last \d+ days\)/);
  assert.match(html, /Garmin scores/);
  assert.match(html, /FTP estimate/);
  assert.match(html, /Estimated race times/);
});
