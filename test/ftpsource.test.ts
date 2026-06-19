import { test } from "node:test";
import assert from "node:assert/strict";
import { emptyState } from "../src/state/types.js";
import type { AthleteState } from "../src/state/types.js";
import type { RichActivity } from "../src/insights/metrics.js";
import { diagnoseFtp, powerCoverage, formatFtpDiagnosis } from "../src/insights/ftpSource.js";

const TODAY = "2026-06-19";

function stateWith(opts: { bikeFtpW?: number; source?: string; estimateW?: number; analyzed?: number; note?: string }): AthleteState {
  const s = emptyState(TODAY, TODAY);
  if (opts.bikeFtpW != null) s.thresholds = { value: { bikeFtpW: opts.bikeFtpW, ...(opts.note ? { bikeFtpNote: opts.note } : {}) }, source: (opts.source as never) ?? "ai-endurance" };
  if (opts.estimateW != null) s.powerCurve = { value: { ftpEstimateW: opts.estimateW, activitiesAnalyzed: opts.analyzed, bests: [] }, source: "garmin" };
  return s;
}

function ride(date: string, watts?: number): RichActivity {
  return { date, sport: "Ride", avwatts: watts };
}

test("powerCoverage: counts in-window rides carrying power; ignores older ones", () => {
  const rides = [ride(TODAY, 200), ride("2026-06-10", 210), ride("2026-06-05"), ride("2026-01-01", 200)];
  const c = powerCoverage(rides, TODAY);
  assert.equal(c.totalRides, 3, "the Jan ride is outside the 90d window");
  assert.equal(c.ridesWithPower, 2);
  assert.equal(c.pct, 67);
});

test("diagnoseFtp: 223 configured vs 183 Garmin estimate → gap flagged, power-ride recommendation", () => {
  const state = stateWith({ bikeFtpW: 223, source: "ai-endurance", estimateW: 183, analyzed: 8 });
  const rides = [ride(TODAY), ride("2026-06-12"), ride("2026-06-04", 183)]; // mostly no power → starved
  const d = diagnoseFtp(state, rides);
  assert.equal(d.configuredFtpW, 223);
  assert.equal(d.garminEstimateW, 183);
  assert.equal(d.gapW, 40);
  assert.equal(d.gapPct, 18);
  assert.match(d.recommendation, /power-meter|power-equipped|power/i);
  // honesty: always states the read-only "can't see AIE's source" limitation
  assert.ok(d.flags.some((f) => /read-only/i.test(f)));
  assert.ok(d.flags.some((f) => /starved|carry power/i.test(f)), "low coverage is flagged");
  const text = formatFtpDiagnosis(d).join("\n");
  assert.match(text, /223 W/);
  assert.match(text, /183 W/);
  assert.match(text, /never writes/i);
});

test("diagnoseFtp: figures agreeing within ~5% → no action", () => {
  const d = diagnoseFtp(stateWith({ bikeFtpW: 200, estimateW: 195 }), [ride(TODAY, 200)]);
  assert.match(d.recommendation, /agree|no action/i);
});

test("diagnoseFtp: Garmin estimate ABOVE configured → configured may be stale", () => {
  const d = diagnoseFtp(stateWith({ bikeFtpW: 180, estimateW: 205 }), [ride(TODAY, 205)]);
  assert.ok(d.gapW! < 0);
  assert.match(d.recommendation, /stale|ABOVE|retest|fresh/i);
});

test("diagnoseFtp: no configured FTP → recommend setting one", () => {
  const d = diagnoseFtp(stateWith({ estimateW: 200 }), [ride(TODAY, 200)]);
  assert.equal(d.configuredFtpW, null);
  assert.match(d.recommendation, /No bike FTP is configured/i);
});

test("diagnoseFtp: no Garmin estimate → can't cross-check", () => {
  const d = diagnoseFtp(stateWith({ bikeFtpW: 223 }), [ride(TODAY, 200)]);
  assert.equal(d.garminEstimateW, null);
  assert.match(d.recommendation, /cross-check|no Garmin/i);
});

test("diagnoseFtp: surfaces the existing bikeFtpNote when present", () => {
  const d = diagnoseFtp(stateWith({ bikeFtpW: 223, estimateW: 183, note: "Garmin auto-detects 183 W from sparse rides — keeping the higher 223 W." }), [ride(TODAY)]);
  assert.ok(d.flags.some((f) => /auto-detects 183 W/.test(f)));
});
