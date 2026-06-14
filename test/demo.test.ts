import { test } from "node:test";
import assert from "node:assert/strict";
import { buildDemoWindow } from "../src/demo/sampleData.js";
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
