import { test } from "node:test";
import assert from "node:assert/strict";
import {
  enrichRaceResults,
  sportFamily,
  isMultisport,
  triathlonDistance,
  finishTimeToSeconds,
  triathlonBests,
  type DatedFit,
  type ActivitySummary,
} from "../src/coach/raceResults.js";
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

// ---------- triathlon PBs ----------

test("triathlonDistance: maps each standard distance; excludes legs, duathlons, oddball distances", () => {
  assert.equal(triathlonDistance("Sprint triathlon"), "Sprint");
  assert.equal(triathlonDistance("Standard triathlon"), "Standard");
  assert.equal(triathlonDistance("Olympic triathlon"), "Standard"); // Olympic = Standard distance
  assert.equal(triathlonDistance("70.3 triathlon (probable)"), "70.3");
  assert.equal(triathlonDistance("Middle-distance triathlon"), "70.3"); // middle distance = half-iron
  assert.equal(triathlonDistance("Middle/long-distance triathlon"), null); // genuinely ambiguous → unclassified
  assert.equal(triathlonDistance("Ironman"), "Full");
  // Not one of the four / not a whole-race finish → null:
  assert.equal(triathlonDistance("IM UK 2011 — bike leg (GPS trace)"), null); // partial leg
  assert.equal(triathlonDistance("Quarter (1/4) triathlon"), null); // non-standard distance
  assert.equal(triathlonDistance("Winter duathlon"), null);
  assert.equal(triathlonDistance("Sportive 140 km"), null);
  assert.equal(triathlonDistance("Marathon"), null);
});

test("finishTimeToSeconds: H:MM:SS, MM:SS, ≈-prefixed; rejects junk", () => {
  assert.equal(finishTimeToSeconds("10:55:47"), 10 * 3600 + 55 * 60 + 47);
  assert.equal(finishTimeToSeconds("1:02:09"), 3600 + 2 * 60 + 9);
  assert.equal(finishTimeToSeconds("43:12"), 43 * 60 + 12); // MM:SS
  assert.equal(finishTimeToSeconds("≈6:13:50"), 6 * 3600 + 13 * 60 + 50); // splits-summed estimate
  assert.equal(finishTimeToSeconds(undefined), null);
  assert.equal(finishTimeToSeconds("—"), null);
  assert.equal(finishTimeToSeconds("DNF"), null);
  assert.equal(finishTimeToSeconds("1:99:00"), null); // impossible minutes
});

test("triathlonBests: fastest finish per distance, all-time vs season vs last-90", () => {
  const races: Race[] = [
    // Sprint: three timed + one pool sprint that's fastest
    { date: "2016-06-04", sport: "triathlon", type: "Sprint triathlon", result: { time: "1:20:10" } },
    { date: "2022-10-09", sport: "triathlon", type: "Sprint triathlon", result: { time: "1:02:09" } },
    { date: "2025-04-13", sport: "triathlon", type: "Sprint triathlon", result: { time: "1:09:07" } },
    // Standard: an old PB, plus a slower one this season (should surface in season + last-90 windows)
    { date: "2023-07-16", sport: "triathlon", type: "Standard triathlon", result: { time: "2:21:30" } },
    { date: "2026-07-11", sport: "triathlon", type: "Olympic triathlon", result: { time: "2:39:12" } },
    // 70.3: one timed
    { date: "2024-06-23", sport: "triathlon", type: "70.3 triathlon", result: { time: "5:26:06" } },
    // Full: two, faster one wins
    { date: "2011-07-31", sport: "triathlon", type: "Ironman", result: { time: "12:21:00" } },
    { date: "2013-07-28", sport: "triathlon", type: "Ironman", result: { time: "10:55:47" } },
    // Excluded: a bike-leg trace with a (fast) time must NOT become a Full PB
    { date: "2011-07-31", sport: "ride", type: "IM UK 2011 — bike leg (GPS trace)", result: { time: "6:32:17" } },
    // Excluded: no finish time
    { date: "2012-05-06", sport: "triathlon", type: "70.3 triathlon" },
  ];
  const now = new Date("2026-07-11T12:00:00Z");
  const bests = triathlonBests(races, 2026, now)!;
  assert.equal(bests.sport, "Triathlon");
  const byLabel = Object.fromEntries(bests.rows.map((r) => [r.label, r]));
  // Fastest all-time per distance:
  assert.deepEqual(byLabel["Sprint"].allTime, { value: "1:02:09", date: "2022-10-09" });
  assert.deepEqual(byLabel["Standard"].allTime, { value: "2:21:30", date: "2023-07-16" });
  assert.deepEqual(byLabel["70.3"].allTime, { value: "5:26:06", date: "2024-06-23" });
  assert.deepEqual(byLabel["Full"].allTime, { value: "10:55:47", date: "2013-07-28" }); // not the 6:32 bike leg
  // Standard has a 2026 race → season + last-90 populated with it; other distances have no recent race.
  assert.deepEqual(byLabel["Standard"].season, { value: "2:39:12", date: "2026-07-11" });
  assert.deepEqual(byLabel["Standard"].last90, { value: "2:39:12", date: "2026-07-11" });
  assert.equal(byLabel["Sprint"].season, undefined);
  assert.equal(byLabel["Sprint"].last90, undefined);
  // All four distances present, in canonical order.
  assert.deepEqual(bests.rows.map((r) => r.label), ["Sprint", "Standard", "70.3", "Full"]);
});

test("triathlonBests: no timed triathlon → null (nothing to show)", () => {
  assert.equal(triathlonBests([{ date: "2024-05-04", sport: "run", type: "Marathon", result: { time: "3:19:14" } }], 2026), null);
  assert.equal(triathlonBests([], 2026), null);
});
