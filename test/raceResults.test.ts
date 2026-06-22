import { test } from "node:test";
import assert from "node:assert/strict";
import { enrichRaceResults, sportFamily, isMultisport, type DatedFit, type ActivitySummary } from "../src/coach/raceResults.js";
import type { Race } from "../src/coach/careerHistory.js";
import type { FitActivity, FitLap, FitSessionSummary } from "../src/insights/fitParser.js";

/** Minimal FitActivity builder for the tests (only the fields the deriver reads). */
function mkFit(opts: { sportName: string; sport?: number; startT?: number; session: FitActivity["session"]; laps?: FitLap[]; sessions?: FitSessionSummary[] }): FitActivity {
  return {
    sport: opts.sport ?? 0,
    sportName: opts.sportName,
    samples: opts.startT != null ? [{ t: opts.startT }] : [],
    laps: opts.laps ?? [],
    lengths: [],
    sessions: opts.sessions ?? [],
    session: opts.session,
  };
}

const runFit = mkFit({
  sportName: "Run",
  startT: 300,
  session: { durationSec: 2700, distanceKm: 10, avgHr: 168 },
  laps: [
    { index: 1, timerS: 1350, distanceM: 5000, avgHr: 162 },
    { index: 2, timerS: 1350, distanceM: 5000, avgHr: 170 },
  ],
});

test("sportFamily + isMultisport classify labels", () => {
  assert.equal(sportFamily("Run"), "run");
  assert.equal(sportFamily("VirtualRide"), "ride");
  assert.equal(sportFamily("sportive"), "ride");
  assert.equal(sportFamily("Open water swim"), "swim");
  assert.equal(sportFamily("triathlon"), "other");
  assert.equal(isMultisport("triathlon", "70.3 triathlon"), true);
  assert.equal(isMultisport("run", "Half-marathon"), false);
});

test("enrich: a .FIT fills summary + per-lap splits, tagged via:fit", () => {
  const races: Race[] = [{ date: "2024-01-01", sport: "run", type: "10k" }];
  const fits: DatedFit[] = [{ date: "2024-01-01", sport: "Run", fit: runFit }];
  const { races: out, stats } = enrichRaceResults(races, fits, []);
  const r = out[0].result;
  assert.ok(r);
  assert.equal(r.time, "45:00");
  assert.equal(r.distanceKm, 10);
  assert.equal(r.pace, "4:30/km"); // 2700s / 10km
  assert.equal(r.avgHr, 168);
  assert.equal(r.via, "fit");
  assert.equal(r.splits?.length, 2);
  assert.equal(r.splits?.[0].pace, "4:30/km"); // 1350s / 5km
  assert.equal(r.splits?.[0].dist, "5.00 km");
  assert.deepEqual(stats, { total: 1, fromFit: 1, fromActivity: 0, withSplits: 1 });
});

test("enrich: hand-authored fields win; the .FIT only fills the gaps", () => {
  const races: Race[] = [{ date: "2024-01-01", sport: "run", type: "10k", result: { time: "44:00" } }];
  const fits: DatedFit[] = [{ date: "2024-01-01", sport: "Run", fit: runFit }];
  const r = enrichRaceResults(races, fits, []).races[0].result;
  assert.equal(r?.time, "44:00"); // authored, NOT overwritten by the FIT's 45:00
  assert.equal(r?.distanceKm, 10); // gap filled from the FIT
  assert.equal(r?.splits?.length, 2);
});

test("enrich: no .FIT → activity-export fallback (summary only, no splits, via:activity)", () => {
  const races: Race[] = [{ date: "2024-02-02", sport: "run", type: "10k" }];
  const acts: ActivitySummary[] = [{ date: "2024-02-02", sport: "run", distKm: 10, durSec: 2700 }];
  const { races: out, stats } = enrichRaceResults(races, [], acts);
  const r = out[0].result;
  assert.equal(r?.time, "45:00");
  assert.equal(r?.pace, "4:30/km");
  assert.equal(r?.via, "activity");
  assert.equal(r?.splits, undefined);
  assert.deepEqual(stats, { total: 1, fromFit: 0, fromActivity: 1, withSplits: 0 });
});

test("enrich: a triathlon gets one summary row per discipline leg, in chronological order", () => {
  const swim = mkFit({ sportName: "Swim", startT: 100, session: { durationSec: 1800, distanceKm: 1.9, avgHr: 150 } });
  const bike = mkFit({ sportName: "Ride", startT: 200, session: { durationSec: 9000, distanceKm: 90, avgHr: 148, avgPower: 200 } });
  const run = mkFit({ sportName: "Run", startT: 300, session: { durationSec: 2400, distanceKm: 10, avgHr: 160 } });
  const races: Race[] = [{ date: "2024-06-13", sport: "triathlon", type: "70.3 triathlon", result: { time: "5:30:00" } }];
  const fits: DatedFit[] = [
    { date: "2024-06-13", sport: "Run", fit: run }, // out of order on purpose
    { date: "2024-06-13", sport: "Swim", fit: swim },
    { date: "2024-06-13", sport: "Ride", fit: bike },
  ];
  const { races: out, stats } = enrichRaceResults(races, fits, []);
  const r = out[0].result;
  assert.equal(r?.time, "5:30:00"); // overall stays author-owned
  assert.equal(r?.via, undefined); // no summary derived for a multisport race
  assert.deepEqual(r?.splits?.map((s) => s.label), ["Swim", "Ride", "Run"]);
  assert.equal(r?.splits?.find((s) => s.label === "Ride")?.watts, 200);
  assert.equal(r?.splits?.find((s) => s.label === "Swim")?.pace, "1:35/100m"); // 1800s / 1.9km
  assert.equal(stats.withSplits, 1);
  assert.equal(stats.fromFit, 0);
});

test("enrich: a triathlon recorded as ONE multisport .FIT expands into its discipline legs", () => {
  // a single file whose `sessions` carry the per-leg summaries (+ a transition session that's dropped)
  const multisport = mkFit({
    sportName: "Run", // the file's overall sport is the last leg
    startT: 100,
    session: { durationSec: 9999, distanceKm: 0 },
    sessions: [
      { sport: 5, sportName: "Swim", startTimeS: 100, durationSec: 1800, distanceKm: 1.9, avgHr: 150 },
      { sport: 18, sportName: "sport-18", startTimeS: 1900, durationSec: 120 }, // T1 — dropped (not a discipline)
      { sport: 2, sportName: "Ride", startTimeS: 2020, durationSec: 9000, distanceKm: 90, avgHr: 148, avgPower: 200 },
      { sport: 1, sportName: "Run", startTimeS: 11020, durationSec: 2400, distanceKm: 10, avgHr: 160 },
    ],
  });
  const races: Race[] = [{ date: "2024-06-13", sport: "triathlon", type: "70.3 triathlon", result: { time: "5:30:00" } }];
  const { races: out, stats } = enrichRaceResults(races, [{ date: "2024-06-13", sport: "Run", fit: multisport }], []);
  const r = out[0].result;
  assert.deepEqual(r?.splits?.map((s) => s.label), ["Swim", "Ride", "Run"]); // transition dropped, chronological
  assert.equal(r?.splits?.find((s) => s.label === "Ride")?.watts, 200);
  assert.equal(r?.splits?.find((s) => s.label === "Ride")?.time, "2:30:00");
  assert.equal(stats.withSplits, 1);
});

test("enrich: a race with nothing matching is returned untouched", () => {
  const races: Race[] = [{ date: "2024-09-09", sport: "run", type: "10k" }];
  const { races: out, stats } = enrichRaceResults(races, [], []);
  assert.equal(out[0].result, undefined);
  assert.deepEqual(stats, { total: 1, fromFit: 0, fromActivity: 0, withSplits: 0 });
});
