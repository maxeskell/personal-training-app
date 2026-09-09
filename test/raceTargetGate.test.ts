import { test } from "node:test";
import assert from "node:assert/strict";
import { parseTargetSeconds, targetForPlan, checkTargetAgainstPlan, courseForRace, triPerformanceFromState, gatePromptBlock } from "../src/insights/raceTargetGate.js";
import { estimateTriSplits, type RaceSplitPlan } from "../src/insights/splits.js";
import { emptyState } from "../src/state/types.js";

const plan = (over: Partial<RaceSplitPlan>): RaceSplitPlan => ({
  race: "Test Tri",
  distanceKm: 51.5,
  predictedSec: 9600,
  strategy: "",
  segments: [],
  ...over,
});

test("parseTargetSeconds: sub/bare/range forms, with H:MM vs MM:SS resolved against the plan's own time", () => {
  // "sub 2:00" on a ~2:40 tri = 2 hours, an upper bound only.
  assert.deepEqual(parseTargetSeconds("sub 2:00", 9600), { minSec: null, maxSec: 7200 });
  // "sub 20:00" on a ~21 min 5k = 20 MINUTES, not 20 hours.
  assert.deepEqual(parseTargetSeconds("sub 20:00", 1250), { minSec: null, maxSec: 1200 });
  // A range keeps both ends; H:MM:SS is unambiguous.
  assert.deepEqual(parseTargetSeconds("4:55-5:10", 18000), { minSec: 17700, maxSec: 18600 });
  assert.deepEqual(parseTargetSeconds("beat 2:39:12", 9600), { minSec: null, maxSec: 9552 });
  // No time-like token → nothing to check (a choice, not an error).
  assert.deepEqual(parseTargetSeconds("season opener — no target (speed/skills)", 3600), { minSec: null, maxSec: null });
});

test("targetForPlan: exact date beats name (source race names drift/typo); containment + lead-word fall back", () => {
  const races = [
    { name: "Birmingham Triathlon", date: "2026-07-11", target_time: "sub 2:00" },
    { name: "Alderford", date: "2026-09-06", target_time: "sub 2:20" },
  ];
  // AI Endurance's goal was literally misspelled — the date still finds the target.
  assert.equal(targetForPlan(plan({ race: "Birmingham Triahtlon", date: "2026-07-11" }), races), "sub 2:00");
  // Name containment when the date doesn't line up.
  assert.equal(targetForPlan(plan({ race: "Alderford Triathlon", date: "2026-09-07" }), races), "sub 2:20");
  // Lead-word (≥5 chars) as the last resort for a dateless, typo'd plan.
  assert.equal(targetForPlan(plan({ race: "Birmingham Triahtlon" }), races), "sub 2:00");
  assert.equal(targetForPlan(plan({ race: "Unrelated Race", date: "2027-01-01" }), races), undefined);
});

test("checkTargetAgainstPlan: verdicts across the model band", () => {
  const p = plan({ predictedSec: 7800, bestSec: 7300, worstSec: 7800 });
  assert.equal(checkTargetAgainstPlan("sub 1:40", p)?.verdict, "implausible"); // 6000 « best 7300
  assert.equal(checkTargetAgainstPlan("sub 2:01", p)?.verdict, "stretch"); // 7260, within 5% under best
  assert.equal(checkTargetAgainstPlan("2:05", p)?.verdict, "in-range"); // 7500 between 7300–7800
  assert.equal(checkTargetAgainstPlan("2:20", p)?.verdict, "conservative"); // 8400 > worst
  const gap = checkTargetAgainstPlan("sub 1:40", p)!;
  assert.ok(gap.gapPct != null && gap.gapPct < -15, "gap is expressed vs the best case");
  assert.match(gap.note, /pace the race off the model/i);
  // Unparseable target → no check at all.
  assert.equal(checkTargetAgainstPlan("no target — hold fitness", p), null);
});

test("checkTargetAgainstPlan: a plan with missing legs can't be judged — says so instead of comparing", () => {
  const p = plan({ missingLegs: ["swim (no CSS set, no recent open-water swims)"] });
  const check = checkTargetAgainstPlan("sub 2:00", p)!;
  assert.equal(check.verdict, "model-incomplete");
  assert.match(check.note, /not a full-race time/);
});

test("GOLDEN — Birmingham 2026: race-morning inputs predict within 4% of the actual 2:39:12, and 'sub 2:00' is implausible", () => {
  // The inputs as they stood on race morning: no CSS (observed open-water pace 2:00/100m from the race
  // swim itself), FTP 199 W, Garmin 10K prediction 46:07, 71 kg. Actual finish: 2:39:12 (9552 s).
  const p = estimateTriSplits(
    "Birmingham Triathlon",
    "olympic",
    { recentOpenWaterPaceSecPer100: 120, ftpW: 199, runPredictions: { "10K": 2767 }, riderWeightKg: 71 },
    "unknown",
    "2026-07-11",
  )!;
  assert.ok(p);
  const err = Math.abs(p.predictedSec - 9552) / 9552;
  assert.ok(err < 0.04, `model within 4% of the real race (got ${(err * 100).toFixed(1)}% off, ${p.predictedSec}s)`);
  const check = checkTargetAgainstPlan("sub 2:00", p)!;
  assert.equal(check.verdict, "implausible", "the target that went unchallenged for a month");
  assert.ok(check.gapPct != null && check.gapPct < -20, "sub-2:00 was ~25% beyond the model");
});

test("triPerformanceFromState: maps run predictions + median recent open-water pace (pool + stale excluded)", () => {
  const s = emptyState("2026-07-11", new Date().toISOString());
  s.thresholds = { value: { bikeFtpW: 199, runThresholdPaceSecPerKm: 283 }, source: "garmin" } as never;
  s.weightKg = { value: 71, source: "garmin" } as never;
  s.racePredictions = {
    value: { date: "2026-07-11", predictions: [{ label: "10K", timeSeconds: 2767 }, { label: "5K", timeSeconds: 1324 }] },
    source: "garmin",
  } as never;
  const decays = [
    { date: "2026-07-11", sport: "Swim", swim: { paceSecPer100m: 133, openWater: true } },
    { date: "2026-07-04", sport: "Swim", swim: { paceSecPer100m: 148, openWater: null } }, // untagged OW counts
    { date: "2026-07-09", sport: "Swim", swim: { paceSecPer100m: 90, openWater: false } }, // pool — excluded
    { date: "2026-03-01", sport: "Swim", swim: { paceSecPer100m: 110, openWater: true } }, // >90d — excluded
    { date: "2026-07-08", sport: "Run", swim: null },
  ];
  const perf = triPerformanceFromState(s, decays);
  assert.equal(perf.ftpW, 199);
  assert.equal(perf.riderWeightKg, 71);
  assert.equal(perf.runPredictions?.["10K"], 2767);
  assert.equal(perf.recentOpenWaterPaceSecPer100, 148, "median of the two eligible paces [133, 148]");
});

test("gatePromptBlock: implausible targets demand the report LEAD with the discrepancy; absent targets are named", () => {
  const p = estimateTriSplits(
    "Local Tri",
    "olympic",
    { recentOpenWaterPaceSecPer100: 120, ftpW: 199, runPredictions: { "10K": 2767 }, riderWeightKg: 71 },
    "unknown",
  )!;
  const block = gatePromptBlock(p, "sub 2:00");
  assert.match(block, /RACE-TIME MODEL vs TARGET/);
  assert.match(block, /TARGET CHECK \[IMPLAUSIBLE\]/);
  assert.match(block, /LEAD the report with this discrepancy/);
  const noTarget = gatePromptBlock(p, undefined);
  assert.match(noTarget, /No athlete target found/);
  assert.equal(gatePromptBlock(null, "sub 2:00"), "");
});

test("courseForRace + estimateTriSplits: a 400 m POOL-swim sprint is modelled as one, and the target check flips (Warwick 2026)", () => {
  // Warwick sprint 2026: 400 m pool swim, 20 km bike, 5 km run. Modelled as the standard 750 m open-water
  // sprint, a 1:05-1:09 target read as "implausible" — off a ~6 min swim that doesn't exist in the event.
  const races = [{ name: "Warwick Triathlon", date: "2026-10-04", target_time: "1:05-1:09", swim_m: 400 }];
  const perf = { cssSecPer100: 113, ftpW: 225, runPredictions: { "5K": 1370 as number }, riderWeightKg: 71 };
  const std = estimateTriSplits("Warwick Sprint", "sprint", perf, "unknown", "2026-10-04")!;
  const course = courseForRace({ race: "Warwick Sprint", date: "2026-10-04" }, races);
  assert.deepEqual(course, { swimM: 400 });
  const pool = estimateTriSplits("Warwick Sprint", "sprint", perf, "unknown", "2026-10-04", course)!;
  assert.equal(pool.segments[0].label, "Swim 400 m");
  assert.equal(std.segments[0].label, "Swim 750 m");
  // The 350 m at CSS comes off the total (±1 s of cumulative rounding); nothing else moves.
  assert.ok(Math.abs(std.predictedSec - pool.predictedSec - 3.5 * 113) <= 1, `swim delta ${std.predictedSec - pool.predictedSec}s`);
  assert.equal(std.segments[2].target, pool.segments[2].target, "bike untouched (splits are diffs of rounded cumulatives, so compare the pacing target)");
  assert.equal(std.segments[4].target, pool.segments[4].target, "run untouched");
  assert.equal(pool.distanceKm, 25.4);
  assert.match(pool.strategy, /Course from your profile: swim 400 m \(standard 750 m\)/);
  assert.match(std.strategy, /Standard Sprint course assumed \(750 m \/ 20 km \/ 5 km\)/, "the standard plan nudges toward the profile field");
  // Same range basis on both → the verdict is decided by the swim distance alone.
  for (const p of [std, pool]) {
    p.worstSec = p.predictedSec;
    p.bestSec = Math.round(p.predictedSec * 0.97);
  }
  assert.equal(checkTargetAgainstPlan("1:05-1:09", std)?.verdict, "implausible");
  assert.notEqual(checkTargetAgainstPlan("1:05-1:09", pool)?.verdict, "implausible", "on the real course the target is no longer beyond the model");
});

test("courseForRace: no profile race, or a race with no overrides → undefined (standard course)", () => {
  const races = [
    { name: "Alderford", date: "2026-09-06", target_time: "sub 2:20" },
    { name: "Long Bike Tri", date: "2027-05-01", bike_km: 22.5, run_km: 5.2 },
  ];
  assert.equal(courseForRace({ race: "Alderford Triathlon", date: "2026-09-06" }, races), undefined);
  assert.equal(courseForRace({ race: "Unknown", date: "2030-01-01" }, races), undefined);
  assert.deepEqual(courseForRace({ race: "Long Bike Tri", date: "2027-05-01" }, races), { bikeKm: 22.5, runKm: 5.2 });
  // A course override on a race WITHOUT a target still matches (the target filter only applies to targetForPlan).
  assert.equal(targetForPlan({ race: "Long Bike Tri", date: "2027-05-01", distanceKm: 0, predictedSec: 0, strategy: "", segments: [] }, races), undefined);
});
