import { test } from "node:test";
import assert from "node:assert/strict";
import { mapIntervals, sportOf, type IntervalsRaw } from "../src/sources/intervals/map.js";
import { loadModel } from "../src/insights/metrics.js";

test("sportOf: maps intervals activity types to our buckets; non-endurance → null", () => {
  assert.equal(sportOf("Run"), "Run");
  assert.equal(sportOf("VirtualRide"), "Ride");
  assert.equal(sportOf("OpenWaterSwim"), "Swim");
  assert.equal(sportOf("Walk"), null);
  assert.equal(sportOf(undefined), null);
});

function wellnessDays(n: number): Record<string, unknown>[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `2026-06-${String(i + 1).padStart(2, "0")}`,
    hrv: 60 + i,
    restingHR: 45,
    weight: 70.2,
    sleepSecs: 27000, // 7.5h
    sleepScore: 80,
    vo2max: 55,
  }));
}

test("mapIntervals: activities → AIE-shaped raw + typed actuals; non-endurance excluded from rich data", () => {
  const data: IntervalsRaw = {
    activities: [
      { id: "1", type: "Run", start_date_local: "2026-06-14T07:00:00", moving_time: 3600, distance: 12000, icu_training_load: 80, average_heartrate: 150 },
      { id: "2", type: "Ride", start_date_local: "2026-06-13T07:00:00", moving_time: 5400, distance: 40000, icu_training_load: 120, average_watts: 200 },
      { id: "3", type: "Swim", start_date_local: "2026-06-12T07:00:00", moving_time: 1800, distance: 2000, icu_training_load: 40 },
      { id: "4", type: "Walk", start_date_local: "2026-06-11T07:00:00", moving_time: 1800, icu_training_load: 5 },
    ],
    wellness: wellnessDays(14),
    events: [],
  };
  const s = mapIntervals(data, { date: "2026-06-14", assembledAt: "2026-06-14T08:00:00Z" });

  assert.equal(s.actualActivities.value!.length, 3); // Walk excluded from sport buckets
  assert.equal(s.actualActivities.source, "intervals");
  const run = (s.raw!.getRunningActivity as { activities: Record<string, unknown>[] }).activities[0];
  assert.equal(run.external_stress_score, 80); // icu_training_load → ESS
  assert.equal(run.distance_in_km, 12); // metres → km
  assert.equal(run.activity_avhr, 150);
});

test("mapIntervals: wellness → recovery series + typed hrv/rhr/weight/sleep/vo2max", () => {
  const data: IntervalsRaw = { activities: [{ id: "1", type: "Run", start_date_local: "2026-06-14", icu_training_load: 80 }], wellness: wellnessDays(14), events: [] };
  const s = mapIntervals(data, { date: "2026-06-14", assembledAt: "2026-06-14T08:00:00Z" });

  const rm = (s.raw!.getRecoveryModel as { data: { date: string[]; rMSSD: (number | null)[] } }).data;
  assert.equal(rm.date.length, 14);
  assert.equal(rm.rMSSD.at(-1), 73); // 60 + 13
  assert.equal(s.hrvOvernight.value, 73); // latest
  assert.equal(s.restingHr.value, 45);
  assert.equal(s.weightKg.value, 70.2);
  assert.equal(s.sleep.value!.hours, 7.5);
  assert.equal(s.vo2max.value, 55);
});

test("mapIntervals: events → planned workouts + races (notes excluded; race not in planned)", () => {
  const data: IntervalsRaw = {
    activities: [],
    wellness: [],
    events: [
      { id: "e1", category: "WORKOUT", start_date_local: "2026-06-20", name: "Tempo run", type: "Run", moving_time: 3600 },
      { id: "e2", category: "RACE", start_date_local: "2026-10-11", name: "Autumn Half", icu_priority: "A" },
      { id: "e3", category: "NOTE", start_date_local: "2026-06-21", name: "rest day" },
    ],
  };
  const s = mapIntervals(data, { date: "2026-06-14", assembledAt: "2026-06-14T08:00:00Z" });

  assert.deepEqual(s.plannedSessions.value!.map((p) => p.title), ["Tempo run"]); // RACE + NOTE excluded
  const goals = (s.raw!.getRaceGoalEvent as { goals: Record<string, unknown>[] }).goals;
  assert.equal(goals.length, 1);
  assert.equal(goals[0].event_name, "Autumn Half");
  assert.equal(goals[0].event_date, "2026-10-11");
  assert.equal(goals[0].priority, "A");
});

test("mapIntervals: load model is GATED off — no synthesized ESS series, so CTL/ATL/TSB degrade", () => {
  const data: IntervalsRaw = {
    activities: [{ id: "1", type: "Ride", start_date_local: "2026-06-14", icu_training_load: 120 }],
    wellness: wellnessDays(20),
    events: [],
  };
  const s = mapIntervals(data, { date: "2026-06-14", assembledAt: "2026-06-14T08:00:00Z" });
  const rm = (s.raw!.getRecoveryModel as { data: { date: string[]; external_stress_score?: unknown } }).data;
  assert.equal(rm.external_stress_score, undefined); // not synthesized from a non-comparable load metric
  assert.equal(loadModel(rm as Parameters<typeof loadModel>[0]), null); // EWMA degrades, never a wrong TSB
});

test("mapIntervals: planned duration is never derived from a load-target field", () => {
  const data: IntervalsRaw = {
    activities: [],
    wellness: [],
    events: [
      { id: "w1", category: "WORKOUT", start_date_local: "2026-06-20", name: "Threshold", type: "Ride", icu_training_load_target: 90 },
      { id: "w2", category: "WORKOUT", start_date_local: "2026-06-21", name: "Long run", type: "Run", moving_time: 5400 },
    ],
  };
  const s = mapIntervals(data, { date: "2026-06-14", assembledAt: "2026-06-14T08:00:00Z" });
  const byTitle = Object.fromEntries(s.plannedSessions.value!.map((p) => [p.title, p.durationMin]));
  assert.equal(byTitle["Threshold"], undefined); // a load target of 90 must NOT render as "1 min"
  assert.equal(byTitle["Long run"], 90); // 5400s / 60 = 90 min (a real seconds field)
});

test("mapIntervals: FTP comes from the most recent activity carrying it, even with no wellness rows", () => {
  const data: IntervalsRaw = {
    activities: [
      { id: "old", type: "Ride", start_date_local: "2026-04-01", icu_ftp: 240 },
      { id: "new", type: "Ride", start_date_local: "2026-06-10", icu_ftp: 265 },
    ],
    wellness: [],
    events: [],
  };
  const s = mapIntervals(data, { date: "2026-06-14", assembledAt: "2026-06-14T08:00:00Z" });
  assert.equal(s.thresholds.value!.bikeFtpW, 265); // latest, not activities[0] (which was the old 240)
});
