import { test } from "node:test";
import assert from "node:assert/strict";
import { analyseHeat, heatFinding, type HeatInput } from "../src/insights/heat.js";
import { estimateRunSplits, estimateTriSplits } from "../src/insights/splits.js";
import { buildInsights } from "../src/insights/engine.js";
import { deriveZones, paceStr } from "../src/insights/zones.js";
import { findingKey, findingScore, surfaceFindings, alertFindings, type Finding } from "../src/insights/metrics.js";
import { trainingStatusFinding, hrvStatusFinding, enduranceScoreFinding, powerCurveFinding } from "../src/insights/garminHealth.js";
import { garminTrendFindings, illnessEarlyWarning, fuellingFromGarmin, type GarminDaily } from "../src/insights/garminTrends.js";
import { coachHeadline, tsbBand } from "../src/insights/headline.js";
import { emptyState } from "../src/state/types.js";
import type { InsightReport } from "../src/insights/engine.js";

// ---------- heat confounder ----------
test("heat: recovers EF~temp slope and attributes a warm-weather dip", () => {
  const recs: HeatInput[] = [];
  [10, 11, 12, 13, 14, 23, 25, 26, 27, 28].forEach((t, i) => {
    const ef = 1.0 * (1 - 0.005 * (t - 10));
    recs.push({ date: `2026-03-${String(i + 1).padStart(2, "0")}`, sport: "Ride", avgPowerW: +(ef * 140).toFixed(0), avgHr: 140, avgTempC: t });
  });
  const h = analyseHeat(recs, "Ride");
  assert.ok(h.pctPerC != null && h.pctPerC < -0.3, "negative %/°C sensitivity");
  assert.ok((h.heatAttributedPct ?? 0) >= 25);
  assert.ok(heatFinding(h));
});

test("heat: silent without enough range or sessions", () => {
  const few: HeatInput[] = [
    { date: "2026-03-01", sport: "Ride", avgPowerW: 140, avgHr: 140, avgTempC: 15 },
    { date: "2026-03-02", sport: "Ride", avgPowerW: 138, avgHr: 140, avgTempC: 16 },
  ];
  assert.equal(analyseHeat(few, "Ride").pctPerC, null);
  assert.equal(heatFinding(analyseHeat(few, "Ride")), null);
});

// ---------- race splits ----------
test("splits: plan totals exactly equal predicted finish; improving → negative split", () => {
  const plan = estimateRunSplits("Marathon", 42.195, 12600, "improving")!;
  assert.ok(plan);
  assert.equal(plan.segments.at(-1)!.cumulativeSec, 12600);
  assert.ok(plan.segments[0].targetPaceSecPerKm > plan.segments.at(-1)!.targetPaceSecPerKm, "starts slower than it finishes");
  assert.equal(estimateRunSplits("x", 0, 100, "unknown"), null);
});

test("tri splits: olympic plan covers swim/T1/bike/T2/run from CSS + FTP + 10K prediction", () => {
  const plan = estimateTriSplits(
    "Birmingham Triathlon",
    "olympic",
    { cssSecPer100: 110, ftpW: 250, runPredictions: { "10K": 2700 }, riderWeightKg: 75 },
    "improving",
    "2026-07-11",
  )!;
  assert.ok(plan);
  assert.deepEqual(plan.segments.map((s) => s.label), ["Swim 1500 m", "T1", "Bike 40 km", "T2", "Run 10 km"]);
  assert.equal(plan.segments.at(-1)!.cumulativeSec, plan.predictedSec);
  // Bike leg plausible: 40 km at 83% of 250 W on the flat model lands 60–90 min.
  const bikeSec = plan.segments[2].cumulativeSec - plan.segments[1].cumulativeSec;
  assert.ok(bikeSec > 3600 && bikeSec < 5400, `bike leg ${bikeSec}s`);
  // Run leg = 10K prediction + off-bike penalty.
  const runSec = plan.segments[4].cumulativeSec - plan.segments[3].cumulativeSec;
  assert.ok(runSec > 2700 && runSec < 3000, `run leg ${runSec}s`);
  assert.match(plan.strategy, /negative-split/);
  // Targets carry leg-appropriate units.
  assert.match(plan.segments[0].target!, /\/100m$/);
  assert.match(plan.segments[2].target!, /W · .*km\/h$/);
});

test("tri splits: degrade per leg — missing FTP drops the bike leg and is named; all-missing → null", () => {
  const plan = estimateTriSplits("Local Tri", "olympic", { cssSecPer100: 110, runThresholdPaceSecPerKm: 270 }, "unknown")!;
  assert.ok(plan);
  assert.ok(!plan.segments.some((s) => s.label.startsWith("Bike")));
  assert.match(plan.strategy, /no FTP/);
  assert.equal(estimateTriSplits("Local Tri", "olympic", {}, "unknown"), null);
});

test("engine: triathlon goals produce per-leg split plans (not run-only)", () => {
  const s = emptyState("2026-06-09", new Date().toISOString());
  s.raw = { getRaceGoalEvent: { goals: [{ event_name: "Birmingham Triathlon", event_date: "2026-07-11", event_type: "Triathlon" }] } };
  s.thresholds = { value: { bikeFtpW: 250, swimCssSecPer100: 110, runThresholdPaceSecPerKm: 270 }, source: "garmin" };
  const ins = buildInsights(s, undefined, {});
  assert.equal(ins.splits.length, 1);
  assert.match(ins.splits[0].race, /Birmingham/);
  assert.ok(ins.splits[0].segments.some((x) => x.label.startsWith("Swim")));
  assert.ok(ins.splits[0].segments.some((x) => x.label.startsWith("Run")));
});

// ---------- zones ----------
test("zones: derived bands ordered correctly from thresholds", () => {
  const z = deriveZones({ bikeFtpW: 250, runThresholdHr: 170, runThresholdPaceSecPerKm: 240, runThresholdPowerW: 338 });
  assert.equal(z.bike?.power?.bounds[1], Math.round(250 * 0.55));
  assert.ok(z.run?.hr && z.run.hr.bounds[z.run.hr.bounds.length - 1] > z.run.hr.bounds[0]);
  // HR zones follow the Coggan %-LTHR table: Z1 (recovery) tops out at 81% LTHR, Z2 endurance above it.
  assert.equal(z.run!.hr!.bounds[1], Math.round(170 * 0.81));
  assert.equal(z.run!.hr!.labels![0], "Z1 Recovery");
  // pace bounds ascending in sec/km (fastest→slowest)
  const pb = z.run!.pace!.bounds;
  assert.ok(pb.every((v, i) => i === 0 || v >= pb[i - 1]));
  assert.equal(paceStr(240), "4:00");
});

test("zones: bike HR zones use bike LTHR when set, else fall back to run LTHR", () => {
  const fallback = deriveZones({ bikeFtpW: 250, runThresholdHr: 170 });
  assert.ok(fallback.bike?.hr, "bike HR zones derived from run LTHR");
  assert.equal(fallback.bike!.hr!.bounds.at(-1), Math.round(170 * 1.06));
  const explicit = deriveZones({ bikeFtpW: 250, bikeThresholdHr: 165, runThresholdHr: 170 });
  assert.equal(explicit.bike!.hr!.bounds.at(-1), Math.round(165 * 1.06));
});

// ---------- finding gating ----------
test("findings: stable key, score ranking, confidence gate + suppression", () => {
  const fs: Finding[] = [
    { family: "Injury risk", title: "Run load spiked 60% this week", severity: "flag", detail: "d", evidence: "e", confidence: 0.85 },
    { family: "Your patterns (n=1)", title: "Sleep vs load", severity: "info", detail: "d", evidence: "e", confidence: 0.35 },
    { family: "Load & form", title: "Deep fatigue", severity: "watch", detail: "d", evidence: "e", confidence: 0.7 },
  ];
  // key is digit-insensitive (survives changing percentages)
  assert.equal(findingKey(fs[0]), findingKey({ ...fs[0], title: "Run load spiked 80% this week" }));
  assert.ok(findingScore(fs[0]) > findingScore(fs[2]));
  // low-confidence (0.35) gated out; suppressed key removed
  const out = surfaceFindings(fs, new Set([findingKey(fs[2])]));
  assert.deepEqual(out.map((f) => f.title), ["Run load spiked 60% this week"]);
});

test("alertFindings: flags + health watch-families fire; ordinary watch/info don't", () => {
  const surfaced: Finding[] = [
    { family: "Load & injury risk", title: "Overreaching", severity: "flag", detail: "d", evidence: "e" },
    { family: "Illness early-warning", title: "Pre-illness signals", severity: "watch", detail: "d", evidence: "e" },
    { family: "Aerobic efficiency", title: "Run EF slipping", severity: "watch", detail: "d", evidence: "e" },
    { family: "Endurance score", title: "Endurance score", severity: "info", detail: "d", evidence: "e" },
  ];
  assert.deepEqual(alertFindings(surfaced).map((f) => f.title), ["Overreaching", "Pre-illness signals"]);
  assert.equal(alertFindings([]).length, 0);
});

// ---------- garmin health ----------
test("training status: OVERREACHING / high ACWR → flag; balanced HRV silent", () => {
  const f = trainingStatusFinding({ label: "OVERREACHING_5", acuteLoad: 1101, chronicLoad: 613, loadRatio: 1.7, acwrStatus: "HIGH" });
  assert.equal(f?.severity, "flag");
  assert.match(f!.title, /Overreach/i);
  assert.equal(hrvStatusFinding({ status: "BALANCED", lastNightMs: 35 }), null);
  assert.equal(hrvStatusFinding({ status: "LOW", lastNightMs: 24, baselineLowMs: 32, baselineUpperMs: 40 })?.severity, "watch");
});

test("tsbBand classifies form sensibly", () => {
  assert.equal(tsbBand(8)!.tone, "good");
  assert.equal(tsbBand(-5)!.tone, "good");
  assert.equal(tsbBand(-15)!.tone, "warn");
  assert.equal(tsbBand(-25)!.tone, "bad");
  assert.equal(tsbBand(null), null);
});

test("coachHeadline leads with the flag + action; red when fatigued; green when clear", () => {
  const st = emptyState("2026-06-08", new Date().toISOString());
  st.recovery = { value: { limiterToday: "resting HR" }, source: "ai-endurance" } as typeof st.recovery;
  st.trainingStatus = { value: { loadRatio: 1.7, acwrStatus: "HIGH", label: "OVERREACHING_5" }, source: "garmin" } as typeof st.trainingStatus;

  const flagReport = {
    load: { tsb: -22 },
    topFindings: [{ family: "Load & injury risk", title: "Overreaching — acute load spike", severity: "flag", detail: "d", evidence: "e", recommendation: "Cut this week's hardest session." }],
  } as unknown as InsightReport;
  const h = coachHeadline(flagReport, st);
  assert.equal(h.severity, "red"); // flag + deep-fatigue TSB
  assert.match(h.line, /Overreaching/);
  assert.equal(h.action, "Cut this week's hardest session.");
  assert.ok(h.drivers.some((d) => /Acute:chronic 1\.7/.test(d)));

  const calm = { load: { tsb: -3 }, topFindings: [{ family: "Aerobic efficiency", title: "EF slipping", severity: "info", detail: "d", evidence: "e" }] } as unknown as InsightReport;
  assert.equal(coachHeadline(calm, emptyState("2026-06-08", "x")).severity, "green");
});

test("endurance score + power curve produce findings on real-shaped input", () => {
  assert.ok(enduranceScoreFinding({ current: 6395, classification: "trained", periodAvg: 6186, nextThresholdLabel: "well_trained", nextThresholdGap: 105 }));
  assert.ok(powerCurveFinding({ ftpEstimateW: 250, activitiesAnalyzed: 9, bests: [{ duration: "1min", watts: 400 }, { duration: "5min", watts: 320 }, { duration: "20min", watts: 255 }] }));
});

// ---------- garmin daily trends ----------
test("garmin trends: illness/stress/fuelling fire; <21 days → empty", () => {
  const mk = (n: number, f: (i: number) => Partial<GarminDaily>): GarminDaily[] =>
    Array.from({ length: n }, (_, i) => ({ date: new Date(Date.UTC(2026, 0, 1 + i)).toISOString().slice(0, 10), ...f(i) }));
  const ill = mk(40, (i) => ({ avgSleepRespiration: i >= 38 ? 18 : 14, skinTempDevC: i >= 38 ? 1.4 : 0.1, restingHr: i >= 38 ? 60 : 50 }));
  assert.ok(illnessEarlyWarning(ill));
  const fuel = mk(30, (i) => (i % 4 === 0 ? { weightKg: 75 - i * 0.05, muscleMassKg: 35 - i * 0.03 } : {}));
  assert.ok(fuellingFromGarmin(fuel));
  assert.equal(garminTrendFindings(mk(10, () => ({ avgStressLevel: 50 }))).length, 0);
});
