import { test } from "node:test";
import assert from "node:assert/strict";
import { mapRichActivity, durabilityTrend, efTrend, thresholdTrend, type RichActivity } from "../src/insights/metrics.js";

/**
 * The AIE summary payload changed shape in the 2026-08 "durability for all workouts" update (probe
 * 2026-08-24, spec 10): the DFA-α1 VALUE fields (durability %, aerobic-threshold HR/W) disappeared and
 * per-activity control flags (exclude_from_durability, exclude_hr_data, power_is_from_hr) appeared.
 * These tests pin both eras: legacy archived rows keep their values; new rows map the flags; and the
 * trends honour the flags — most importantly EF, where HR-derived power would be circular.
 */

/** A live post-2026-08 ride, field names verbatim from the 2026-08-24 probe. */
const LIVE_RIDE = {
  activity_date: "2026-08-23T13:02:30Z",
  activity_date_local: "2026-08-23T14:02:30Z",
  activity_name: "Endurance Ride - AI Endurance",
  activity_type: "Garmin_Ride",
  activity_movingtime: 5400,
  activity_avwatts: 180,
  activity_haspower: true,
  activity_avhr: 130,
  external_stress_score: 80,
  distance_in_km: 45.2,
  hrv_artifact_percentage: 3.1,
  power_is_from_hr: false,
  exclude_from_durability: false,
  exclude_from_curves: false,
  exclude_from_model: false,
  exclude_hr_data: false,
  is_erg_mode: false,
  is_indoor: false,
  is_virtual: false,
  kcal: 1200,
};

test("mapRichActivity: live 2026-08 shape maps the flags and degrades the gone value fields to undefined", () => {
  const r = mapRichActivity(LIVE_RIDE, "Ride");
  assert.equal(r.date, "2026-08-23");
  assert.equal(r.avwatts, 180);
  assert.equal(r.powerIsFromHr, false);
  assert.equal(r.excludeFromDurability, false);
  assert.equal(r.excludeHrData, false);
  assert.equal(r.durabilityPct, undefined);
  assert.equal(r.aerThrHr, undefined);
  assert.equal(r.aerThrW, undefined);
});

test("mapRichActivity: legacy archived rows still yield their DFA-α1 values; flags stay undefined", () => {
  const r = mapRichActivity(
    {
      activity_date_local: "2026-05-10T08:00:00Z",
      activity_movingtime: 3900,
      aerobic_durability_according_to_dfa_alpha1_running_power_in_percent: -4.2,
      aerobic_threshold_dfa_alpha1_heart_rate_cluster: 138,
    },
    "Run",
  );
  assert.equal(r.durabilityPct, -4.2);
  assert.equal(r.aerThrHr, 138);
  assert.equal(r.powerIsFromHr, undefined);
  assert.equal(r.excludeFromDurability, undefined);
});

const act = (over: Partial<RichActivity>): RichActivity => ({ date: "2026-06-01", sport: "Ride", ...over });

test("durabilityTrend: an athlete-flagged exclude_from_durability session never enters the trend", () => {
  const acts: RichActivity[] = [];
  for (let i = 0; i < 10; i++) acts.push(act({ date: `2026-06-${String(i + 1).padStart(2, "0")}`, durabilityPct: -4 }));
  // A flagged outlier that would drag the recent mean if counted:
  acts.push(act({ date: "2026-06-11", durabilityPct: -40, excludeFromDurability: true }));
  const t = durabilityTrend(acts, "Ride");
  assert.equal(t.recent, -4);
  assert.equal(t.n, 10, "the excluded session contributes no point");
});

test("efTrend: rides with power derived from HR are excluded (EF would be circular)", () => {
  const good = Array.from({ length: 10 }, (_, i) =>
    act({ date: `2026-06-${String(i + 1).padStart(2, "0")}`, movingSec: 3600, avwatts: 150, avhr: 150 }),
  );
  const derived = act({ date: "2026-06-11", movingSec: 3600, avwatts: 300, avhr: 150, powerIsFromHr: true });
  const t = efTrend([...good, derived], "Ride");
  assert.equal(t.recent, 1, "EF stays at the measured 1.0 — the HR-derived 2.0 ride is dropped");
  assert.equal(t.n, 10);
});

test("efTrend and thresholdTrend: exclude_hr_data drops the session from HR-derived metrics", () => {
  const base = Array.from({ length: 10 }, (_, i) =>
    act({ date: `2026-06-${String(i + 1).padStart(2, "0")}`, movingSec: 3600, avwatts: 150, avhr: 150, aerThrHr: 140 }),
  );
  const badHr = act({ date: "2026-06-11", movingSec: 3600, avwatts: 150, avhr: 75, aerThrHr: 90, excludeHrData: true });
  assert.equal(efTrend([...base, badHr], "Ride").n, 10, "bad-HR ride out of EF");
  assert.equal(thresholdTrend([...base, badHr], "Ride").n, 10, "bad-HR ride out of the threshold trend");
});

test("trends stay well-behaved on an all-new-shape window (no value fields at all)", () => {
  const acts = Array.from({ length: 8 }, (_, i) =>
    act({ date: `2026-08-${String(i + 1).padStart(2, "0")}`, movingSec: 3000, excludeFromDurability: false }),
  );
  const t = durabilityTrend(acts, "Ride");
  assert.equal(t.recent, null);
  assert.equal(t.n, 0);
});
